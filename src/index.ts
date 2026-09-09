/**
 * Postal email provider plugin for EmDash CMS.
 *
 * Registers the exclusive `email:deliver` transport. Every message is queued
 * in plugin storage and sent by a once-a-minute job through Postal's HTTP API
 * (`POST /api/v1/send/message`) — the hook itself never touches the network,
 * so no request ever waits on Postal and a slow reply can't turn into a
 * duplicate send. See src/queue.ts for the reasoning and the retry policy.
 *
 * Native format: the sandbox runner caps a plugin call's wall time, which is
 * exactly the constraint that made inline sending unreliable. Running
 * in-process lets the drain job declare a budget that fits a real Postal call.
 *
 * Settings (Plugins → Postal → Settings):
 * - `baseUrl`     — Postal server origin, e.g. https://postal.example.com
 * - `apiKey`      — Postal server API credential (X-Server-API-Key)
 * - `fromAddress` — default From, e.g. "Bad Dog <hello@example.com>"
 *
 * Stored under the same `settings:*` KV keys the 0.3 sandboxed plugin used,
 * so an existing configuration carries over untouched.
 */
import type { PluginDescriptor, ResolvedPlugin, RouteContext } from "emdash";
import { definePlugin, PluginRouteError } from "emdash";
import { z } from "zod";

import { extractExtras, isValidEmail } from "./postal.js";
import {
	DRAIN_HOOK_TIMEOUT_MS,
	DRAIN_TASK,
	STORAGE_CONFIG,
	discardItem,
	drain,
	enqueue,
	ensureDrainScheduled,
	getSettings,
	queueStatus,
	retryItem,
	settingsComplete,
} from "./queue.js";

const VERSION = "0.4.0";
const ID = "emdash-postal";

const SETTINGS_SCHEMA = {
	baseUrl: {
		type: "url" as const,
		label: "Postal server URL",
		description: "The origin of your Postal server, e.g. https://postal.example.com",
		placeholder: "https://postal.example.com",
	},
	apiKey: {
		type: "secret" as const,
		label: "Server API key",
		description: "From Postal → your mail server → Credentials, type “API”.",
	},
	fromAddress: {
		type: "string" as const,
		label: "From address",
		description: "Default sender for every email, e.g. Bad Dog <hello@example.com>. The domain must be set up in Postal.",
		placeholder: "Bad Dog <hello@example.com>",
	},
};

const ADMIN_PAGES = [{ path: "/", label: "Postal", icon: "email" }];

/** Descriptor for astro.config: `emdash({ plugins: [emdashPostal()] })`. */
export function emdashPostal(): PluginDescriptor {
	return {
		id: ID,
		version: VERSION,
		entrypoint: "emdash-postal",
		adminEntry: "emdash-postal/admin",
		options: {},
		capabilities: ["hooks.email-transport:register", "network:request:unrestricted"],
		storage: STORAGE_CONFIG,
		adminPages: ADMIN_PAGES,
		settingsSchema: SETTINGS_SCHEMA,
	};
}

const idInput = z.object({ id: z.string().min(1) });
const testInput = z.object({ to: z.string().min(3) });
type IdInput = z.infer<typeof idInput>;
type TestInput = z.infer<typeof testInput>;

// The routes record erases each handler's input generic to `unknown`, so
// typed handlers need a cast at the boundary. It is safe: the `input` schema
// on the same route guarantees the runtime shape the handler declares.
async function retryHandler(ctx: RouteContext<IdInput>) {
	if (!(await retryItem(ctx, ctx.input.id))) {
		throw PluginRouteError.notFound("No failed message with that id");
	}
	return { ok: true };
}

async function discardHandler(ctx: RouteContext<IdInput>) {
	if (!(await discardItem(ctx, ctx.input.id))) {
		throw PluginRouteError.notFound("No failed message with that id");
	}
	return { ok: true };
}

/**
 * Queue a test message. It travels the same path as real mail, so "it
 * arrived" proves the settings, the queue and the drain together.
 */
async function testHandler(ctx: RouteContext<TestInput>) {
	const to = ctx.input.to.trim();
	if (!isValidEmail(to)) throw PluginRouteError.badRequest("Enter a valid email address");
	const settings = await getSettings(ctx);
	if (!settingsComplete(settings)) {
		throw PluginRouteError.badRequest("Set the server URL, API key and From address first");
	}
	const id = await enqueue(ctx, ID, {
		to: [to],
		from: settings.fromAddress,
		subject: "EmDash Postal plugin test email",
		plain_body:
			"Hello from the EmDash Postal plugin. If you can read this, the queue, the drain job and your Postal credentials all work.",
	});
	return { ok: true, id };
}

export function createPlugin(): ResolvedPlugin {
	return definePlugin({
		id: ID,
		version: VERSION,
		capabilities: ["hooks.email-transport:register", "network:request:unrestricted"],
		allowedHosts: ["*"],
		storage: STORAGE_CONFIG,

		hooks: {
			"plugin:activate": {
				handler: async (_event, ctx) => {
					await ensureDrainScheduled(ctx);
				},
			},

			"email:deliver": {
				exclusive: true,
				handler: async (event, ctx) => {
					const settings = await getSettings(ctx);
					if (!settingsComplete(settings)) {
						// Queueing with nowhere to send would lose the mail silently;
						// failing loudly is the better outcome for an unconfigured site.
						ctx.log.error("Cannot queue email: Postal server URL, API key, or From address is missing");
						throw new Error("Postal settings missing. Configure them under Plugins → Postal → Settings.");
					}

					const { message, source } = event;
					const extras = extractExtras(message as unknown as Record<string, unknown>);
					const id = await enqueue(ctx, source, {
						to: [message.to],
						...extras,
						from: settings.fromAddress,
						subject: message.subject,
						plain_body: message.text,
						html_body: message.html,
					});
					ctx.log.info("Email queued for Postal", { id, to: message.to, source });
				},
			},

			cron: {
				// Sequential Postal calls, each allowed to run long: the whole point
				// of the queue is that this job is the only place a wall clock matters.
				timeout: DRAIN_HOOK_TIMEOUT_MS,
				handler: async (event, ctx) => {
					if (event.name !== DRAIN_TASK) return;
					const stats = await drain(ctx);
					if (stats.sent || stats.failed) ctx.log.info("Postal outbox drained", stats);
				},
			},
		},

		routes: {
			/** Queue depth, dead letters and configuration state for the admin page. */
			status: {
				handler: async (ctx: RouteContext) => {
					// `plugin:activate` only fires on activation, and this plugin was
					// already active before the queue existed — opening the page is
					// the earliest reliable moment to make sure the job is scheduled.
					await ensureDrainScheduled(ctx);
					return queueStatus(ctx);
				},
			},

			/** Put a dead-lettered message back in the queue. */
			retry: { input: idInput, handler: retryHandler as never },

			/** Drop a dead-lettered message for good. */
			discard: { input: idInput, handler: discardHandler as never },

			/** Queue a test message through the real path. */
			test: { input: testInput, handler: testHandler as never },

			/** Run a drain pass now rather than waiting for the minute. */
			"drain-now": {
				handler: async (ctx: RouteContext) => drain(ctx),
			},
		},

		admin: {
			settingsSchema: SETTINGS_SCHEMA,
			pages: ADMIN_PAGES,
		},
	});
}

// The default export is the descriptor factory so `import postal from
// "emdash-postal"` keeps working in astro.config; EmDash's native loader
// imports `createPlugin` by name from the same module.
export default emdashPostal;
