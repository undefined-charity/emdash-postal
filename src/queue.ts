/**
 * The outbox: every message EmDash asks us to deliver is written here first
 * and sent by a background job.
 *
 * Why not send inline? A plugin hook runs under a wall-time budget, and a
 * single Postal call can outlast it — the message goes out, the hook is
 * killed, and the caller sees an error for a delivery that succeeded. Retrying
 * "the failure" then sends the same email again. This was observed in
 * production: one invite, two error dialogs, three emails.
 *
 * So the hook does the cheapest possible thing (a storage write) and the cron
 * job, which can declare its own generous timeout, does the network. The
 * price is latency: on Cloudflare the finest cron granularity is one minute,
 * so an email is typically on its way within 30 seconds and always within 60.
 *
 * Retry policy:
 *   transient   → back off 1, 2, 4, 8, 16 minutes, then dead-letter
 *   permanent   → dead-letter immediately (a person has to fix something)
 *   unconfirmed → one retry after a longer wait, then dead-letter. Postal may
 *                 have accepted the message already, so a second send risks a
 *                 duplicate; that is a smaller harm than silently losing a
 *                 magic link, but not one worth repeating five times.
 */
import type { PluginContext, StorageCollection } from "emdash";

import { PostalSendError, sendViaPostal, type PostalPayload, type PostalSettings } from "./postal.js";

export type OutboxStatus = "queued" | "sending" | "failed";

export interface OutboxItem {
	status: OutboxStatus;
	/** Where the email came from — "system" for auth mail, else a plugin id. */
	source: string;
	to: string;
	subject: string;
	payload: PostalPayload;
	attempts: number;
	/** ISO time before which the item must not be attempted again. */
	nextAttemptAt: string;
	createdAt: string;
	lastAttemptAt?: string;
	/** Set once a call has timed out, so the second timeout dead-letters. */
	unconfirmedOnce?: boolean;
	/** Why the last attempt failed — shown in the admin. */
	error?: string;
	/** Category of the last failure. */
	errorKind?: "transient" | "permanent" | "unconfirmed";
}

/** Storage declaration shared by the descriptor and definePlugin. */
export const STORAGE_CONFIG = {
	outbox: { indexes: ["status", "nextAttemptAt", "createdAt"] },
};

/** Name of the recurring cron task that drains the outbox. */
export const DRAIN_TASK = "drain";

/** How long one Postal call may take before it is treated as unconfirmed. */
const CALL_TIMEOUT_MS = 20_000;
/** How much of the cron hook's budget to spend before leaving the rest for the next tick. */
const DRAIN_BUDGET_MS = 40_000;
/** Give the cron hook headroom over the drain budget plus one full call. */
export const DRAIN_HOOK_TIMEOUT_MS = DRAIN_BUDGET_MS + CALL_TIMEOUT_MS + 5_000;
/** Transient failures: minutes to wait before each retry, by attempt number. */
const BACKOFF_MINUTES = [1, 2, 4, 8, 16];
/** An unconfirmed call gets one more try, after long enough for Postal to have settled. */
const UNCONFIRMED_RETRY_MINUTES = 5;
/** A "sending" row older than this belonged to a job that died mid-call. */
const STALE_SENDING_MINUTES = 10;
/** Rows drained per tick. Each is one Postal round-trip. */
const BATCH_SIZE = 25;

const now = () => new Date().toISOString();
const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

export function outbox(ctx: PluginContext): StorageCollection<OutboxItem> {
	return ctx.storage.outbox as StorageCollection<OutboxItem>;
}

export async function getSettings(ctx: PluginContext): Promise<Partial<PostalSettings>> {
	const [baseUrl, apiKey, fromAddress] = await Promise.all([
		ctx.kv.get<string>("settings:baseUrl"),
		ctx.kv.get<string>("settings:apiKey"),
		ctx.kv.get<string>("settings:fromAddress"),
	]);
	return {
		baseUrl: baseUrl?.replace(/\/+$/, "") || undefined,
		apiKey: apiKey || undefined,
		fromAddress: fromAddress || undefined,
	};
}

export function settingsComplete(s: Partial<PostalSettings>): s is PostalSettings {
	return !!s.baseUrl && !!s.apiKey && !!s.fromAddress;
}

/** Make sure the drain job exists. Cheap enough to call on every enqueue. */
export async function ensureDrainScheduled(ctx: PluginContext): Promise<void> {
	if (!ctx.cron) return;
	try {
		const tasks = await ctx.cron.list();
		if (!tasks.some((t) => t.name === DRAIN_TASK)) {
			await ctx.cron.schedule(DRAIN_TASK, { schedule: "* * * * *" });
			ctx.log.info("Postal outbox drain scheduled");
		}
	} catch (error) {
		ctx.log.error("Failed to schedule the Postal outbox drain", error);
	}
}

/** Queue a message. Returns the outbox id. */
export async function enqueue(
	ctx: PluginContext,
	source: string,
	payload: PostalPayload,
): Promise<string> {
	const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	const stamp = now();
	await outbox(ctx).put(id, {
		status: "queued",
		source,
		to: payload.to[0] ?? "",
		subject: payload.subject,
		payload,
		attempts: 0,
		nextAttemptAt: stamp,
		createdAt: stamp,
	});
	await ensureDrainScheduled(ctx);
	return id;
}

/** A drain older than this is assumed dead and its lock ignored. */
const DRAIN_LOCK_STALE_MS = DRAIN_HOOK_TIMEOUT_MS + 30_000;

export interface DrainStats {
	sent: number;
	failed: number;
	deferred: number;
	/** True when another drain held the lock and this one did nothing. */
	skipped?: boolean;
}

/**
 * One drain pass. Sends due items sequentially until the batch or the time
 * budget is exhausted; whatever is left waits for the next tick.
 *
 * Only one pass may run at a time. The cron and the admin's "send now" can
 * coincide, and marking an item "sending" is a read-then-write, so two passes
 * could both pick up the same message — the very duplicate this queue exists
 * to prevent. The lock is a KV timestamp rather than anything atomic, which
 * leaves a millisecond-scale window; the alternative sends are a minute apart.
 */
export async function drain(ctx: PluginContext): Promise<DrainStats> {
	const stats: DrainStats = { sent: 0, failed: 0, deferred: 0 };

	const lock = await ctx.kv.get<string>("state:drainLock");
	if (lock && Date.now() - new Date(lock).getTime() < DRAIN_LOCK_STALE_MS) {
		return { ...stats, skipped: true };
	}
	await ctx.kv.set("state:drainLock", now());

	try {
		await ctx.kv.set("state:lastDrainAt", now());

		const settings = await getSettings(ctx);
		if (!settingsComplete(settings)) {
			// Not an error worth spamming the log every minute; the admin page
			// shows the queue depth and that settings are incomplete.
			return stats;
		}
		if (!ctx.http) {
			ctx.log.error("Postal plugin has no network access — check the network:request:unrestricted capability");
			return stats;
		}

		await reclaimStale(ctx);
		await drainDue(ctx, settings, stats);
		return stats;
	} finally {
		await ctx.kv.delete("state:drainLock");
	}
}

async function drainDue(ctx: PluginContext, settings: PostalSettings, stats: DrainStats): Promise<void> {
	if (!ctx.http) return;
	const started = Date.now();
	const page = await outbox(ctx).query({
		where: { status: "queued" },
		orderBy: { createdAt: "asc" },
		limit: BATCH_SIZE,
	});
	const due = page.items.filter((item) => item.data.nextAttemptAt <= now());
	stats.deferred = page.items.length - due.length;

	for (const { id, data } of due) {
		if (Date.now() - started > DRAIN_BUDGET_MS) {
			stats.deferred += 1;
			continue;
		}

		const attempt: OutboxItem = { ...data, status: "sending", attempts: data.attempts + 1, lastAttemptAt: now() };
		await outbox(ctx).put(id, attempt);

		try {
			const { messageId } = await sendViaPostal(ctx.http.fetch.bind(ctx.http), settings, data.payload, CALL_TIMEOUT_MS);
			await outbox(ctx).delete(id);
			await recordSent(ctx);
			stats.sent += 1;
			ctx.log.info("Email delivered via Postal", {
				to: data.to,
				source: data.source,
				attempt: attempt.attempts,
				...(messageId ? { messageId } : {}),
			});
		} catch (error) {
			const outcome = await recordFailure(ctx, id, attempt, error);
			if (outcome === "failed") stats.failed += 1;
			else stats.deferred += 1;
		}
	}
}

/** Decide what happens to an item after a failed attempt, and persist it. */
async function recordFailure(
	ctx: PluginContext,
	id: string,
	item: OutboxItem,
	error: unknown,
): Promise<"retry" | "failed"> {
	const kind = error instanceof PostalSendError ? error.kind : "transient";
	const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
	const base: OutboxItem = { ...item, error: message, errorKind: kind };

	const deadLetter = async (why: string) => {
		await outbox(ctx).put(id, { ...base, status: "failed", error: `${message} — ${why}` });
		await ctx.kv.set("state:lastError", { at: now(), to: item.to, error: message });
		ctx.log.error(`Postal delivery to ${item.to} dead-lettered: ${why}`, { error: message, source: item.source });
		return "failed" as const;
	};

	if (kind === "permanent") {
		return deadLetter("Postal refused the message; retrying would not help");
	}

	if (kind === "unconfirmed") {
		if (item.unconfirmedOnce) {
			return deadLetter("timed out twice; it may have been delivered, so it was not sent a third time");
		}
		await outbox(ctx).put(id, {
			...base,
			status: "queued",
			unconfirmedOnce: true,
			nextAttemptAt: minutesFromNow(UNCONFIRMED_RETRY_MINUTES),
		});
		ctx.log.warn(`Postal delivery to ${item.to} unconfirmed; one retry in ${UNCONFIRMED_RETRY_MINUTES} minutes`);
		return "retry";
	}

	const backoff = BACKOFF_MINUTES[item.attempts - 1];
	if (backoff === undefined) {
		return deadLetter(`gave up after ${item.attempts} attempts`);
	}
	await outbox(ctx).put(id, { ...base, status: "queued", nextAttemptAt: minutesFromNow(backoff) });
	ctx.log.warn(`Postal delivery to ${item.to} failed (attempt ${item.attempts}); retrying in ${backoff} min`, {
		error: message,
	});
	return "retry";
}

/**
 * A row can be left in "sending" if the job died between marking it and
 * finishing the call — a deploy, an isolate eviction, a hard timeout. Treat
 * it exactly like a timed-out call: the message may have gone.
 */
async function reclaimStale(ctx: PluginContext): Promise<void> {
	const cutoff = new Date(Date.now() - STALE_SENDING_MINUTES * 60_000).toISOString();
	const page = await outbox(ctx).query({ where: { status: "sending" }, limit: 50 });
	for (const { id, data } of page.items) {
		if ((data.lastAttemptAt ?? data.createdAt) > cutoff) continue;
		await recordFailure(
			ctx,
			id,
			data,
			new PostalSendError("the previous attempt was interrupted before Postal replied", "unconfirmed"),
		);
	}
}

async function recordSent(ctx: PluginContext): Promise<void> {
	const count = (await ctx.kv.get<number>("state:sentCount")) ?? 0;
	await Promise.all([ctx.kv.set("state:sentCount", count + 1), ctx.kv.set("state:lastSentAt", now())]);
}

/** Snapshot for the admin page. */
export async function queueStatus(ctx: PluginContext) {
	const settings = await getSettings(ctx);
	const [queuedPage, sending, failedPage, lastDrainAt, lastSentAt, sentCount, lastError, cronTasks] = await Promise.all([
		outbox(ctx).query({ where: { status: "queued" }, orderBy: { createdAt: "asc" }, limit: 50 }),
		outbox(ctx).count({ status: "sending" }),
		outbox(ctx).query({ where: { status: "failed" }, orderBy: { createdAt: "desc" }, limit: 50 }),
		ctx.kv.get<string>("state:lastDrainAt"),
		ctx.kv.get<string>("state:lastSentAt"),
		ctx.kv.get<number>("state:sentCount"),
		ctx.kv.get<{ at: string; to: string; error: string }>("state:lastError"),
		ctx.cron?.list() ?? Promise.resolve([]),
	]);
	return {
		configured: settingsComplete(settings),
		baseUrl: settings.baseUrl ?? null,
		fromAddress: settings.fromAddress ?? null,
		drainScheduled: cronTasks.some((t) => t.name === DRAIN_TASK),
		lastDrainAt: lastDrainAt ?? null,
		lastSentAt: lastSentAt ?? null,
		sentCount: sentCount ?? 0,
		lastError: lastError ?? null,
		queued: queuedPage.items.length,
		sending,
		waiting: queuedPage.items.map(({ id, data }) => ({
			id,
			to: data.to,
			subject: data.subject,
			source: data.source,
			attempts: data.attempts,
			nextAttemptAt: data.nextAttemptAt,
			createdAt: data.createdAt,
			error: data.error ?? null,
			errorKind: data.errorKind ?? null,
		})),
		failed: failedPage.items.map(({ id, data }) => ({
			id,
			to: data.to,
			subject: data.subject,
			source: data.source,
			attempts: data.attempts,
			error: data.error ?? "",
			errorKind: data.errorKind ?? "transient",
			createdAt: data.createdAt,
			lastAttemptAt: data.lastAttemptAt ?? null,
		})),
	};
}

/** Put a dead-lettered item back in the queue for an immediate attempt. */
export async function retryItem(ctx: PluginContext, id: string): Promise<boolean> {
	const item = await outbox(ctx).get(id);
	if (!item || item.status !== "failed") return false;
	await outbox(ctx).put(id, {
		...item,
		status: "queued",
		attempts: 0,
		unconfirmedOnce: false,
		nextAttemptAt: now(),
		error: undefined,
		errorKind: undefined,
	});
	await ensureDrainScheduled(ctx);
	return true;
}

export async function discardItem(ctx: PluginContext, id: string): Promise<boolean> {
	const item = await outbox(ctx).get(id);
	if (!item || item.status !== "failed") return false;
	return outbox(ctx).delete(id);
}
