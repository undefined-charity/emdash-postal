/**
 * Admin page for the Postal plugin: is it configured, is the drain job alive,
 * what is waiting, what has been given up on — and a test button that queues
 * a real message rather than sending one inline, so a green result means the
 * whole path works.
 */
import { Badge, Button, Input } from "@cloudflare/kumo";
import type { PluginAdminExports } from "emdash";
import { apiFetch as baseFetch } from "emdash/plugin-utils";
import * as React from "react";

const API = "/_emdash/api/plugins/emdash-postal";

interface FailedItem {
	id: string;
	to: string;
	subject: string;
	source: string;
	attempts: number;
	error: string;
	errorKind: "transient" | "permanent" | "unconfirmed";
	createdAt: string;
	lastAttemptAt: string | null;
}

interface WaitingItem {
	id: string;
	to: string;
	subject: string;
	source: string;
	attempts: number;
	nextAttemptAt: string;
	createdAt: string;
	error: string | null;
	errorKind: "transient" | "permanent" | "unconfirmed" | null;
}

interface Status {
	configured: boolean;
	waiting: WaitingItem[];
	baseUrl: string | null;
	fromAddress: string | null;
	drainScheduled: boolean;
	lastDrainAt: string | null;
	lastSentAt: string | null;
	sentCount: number;
	lastError: { at: string; to: string; error: string } | null;
	queued: number;
	sending: number;
	failed: FailedItem[];
}

async function call<T = unknown>(route: string, body?: unknown): Promise<T> {
	const response = await baseFetch(`${API}/${route}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});
	const payload = (await response.json().catch(() => ({}))) as { success?: boolean; data?: T; error?: { message?: string } };
	if (!response.ok || payload.success === false) {
		throw new Error(payload.error?.message ?? `Request failed (${response.status})`);
	}
	return payload.data as T;
}

function ago(iso: string | null): string {
	if (!iso) return "never";
	const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
	if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
	return new Date(iso).toLocaleString();
}

function PostalPage() {
	const [status, setStatus] = React.useState<Status | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	const [notice, setNotice] = React.useState<string | null>(null);
	const [testTo, setTestTo] = React.useState("");
	const [busy, setBusy] = React.useState(false);

	const refresh = React.useCallback(async () => {
		try {
			setStatus(await call<Status>("status"));
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	React.useEffect(() => {
		void refresh();
		// The queue moves once a minute; poll a little faster so the page
		// reflects a drain shortly after it happens.
		const timer = setInterval(() => void refresh(), 20_000);
		return () => clearInterval(timer);
	}, [refresh]);

	const act = async (label: string, fn: () => Promise<unknown>) => {
		setBusy(true);
		setNotice(null);
		try {
			await fn();
			setNotice(label);
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	// The drain is considered alive if it has run in the last few minutes.
	const drainAge = status?.lastDrainAt ? (Date.now() - new Date(status.lastDrainAt).getTime()) / 1000 : null;
	const drainHealthy = drainAge !== null && drainAge < 300;

	return (
		<div className="space-y-6 p-6">
			<div>
				<h1 className="text-xl font-semibold">Postal</h1>
				<p className="text-sm text-kumo-subtle mt-1">
					Every email EmDash sends is queued here and delivered through Postal by a job that runs once a minute. Server
					URL, API key and From address live under <strong>Settings</strong> for this plugin.
				</p>
			</div>

			{error && (
				<div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
					{error}{" "}
					<Button variant="ghost" size="sm" onClick={() => void refresh()}>
						Retry
					</Button>
				</div>
			)}
			{notice && <div className="rounded border border-green-300 bg-green-50 p-3 text-sm text-green-800">{notice}</div>}

			{status && (
				<>
					<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
						<Stat label="Configured" value={status.configured ? "Yes" : "No"} tone={status.configured ? "success" : "error"} />
						<Stat
							label="Drain job"
							value={!status.drainScheduled ? "Not scheduled" : drainHealthy ? "Running" : "Stale"}
							tone={status.drainScheduled && drainHealthy ? "success" : "error"}
							hint={`last run ${ago(status.lastDrainAt)}`}
						/>
						<Stat label="Waiting" value={String(status.queued + status.sending)} hint={status.sending ? `${status.sending} in flight` : undefined} />
						<Stat label="Delivered" value={String(status.sentCount)} hint={`last ${ago(status.lastSentAt)}`} />
					</div>

					{!status.configured && (
						<div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
							Mail is being queued but nothing can be sent until the server URL, API key and From address are set in
							this plugin's Settings.
						</div>
					)}
					{status.configured && (
						<p className="text-sm text-kumo-subtle">
							Sending as <code>{status.fromAddress}</code> via <code>{status.baseUrl}</code>.
						</p>
					)}

					<section className="space-y-2">
						<h2 className="font-medium">Send a test</h2>
						<p className="text-sm text-kumo-subtle">
							Queued like any other message — expect it within a minute. If it arrives, settings, queue and drain all
							work.
						</p>
						<div className="flex gap-2">
							<Input
								value={testTo}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTestTo(e.target.value)}
								placeholder="you@example.com"
								aria-label="Test recipient"
							/>
							<Button
								disabled={busy || !testTo}
								onClick={() => void act(`Test email to ${testTo} queued`, () => call("test", { to: testTo }))}
							>
								Queue test email
							</Button>
							<Button
								variant="secondary"
								disabled={busy}
								onClick={() => void act("Drain pass finished", () => call("drain-now"))}
							>
								Send now
							</Button>
						</div>
					</section>

					<section className="space-y-2">
						<h2 className="font-medium">Waiting ({status.waiting.length})</h2>
						{status.waiting.length === 0 ? (
							<p className="text-sm text-kumo-subtle">Nothing queued.</p>
						) : (
							<div className="divide-y rounded border">
								{status.waiting.map((item) => {
									const due = new Date(item.nextAttemptAt).getTime() - Date.now();
									return (
										<div key={item.id} className="space-y-1 p-3 text-sm">
											<div className="flex flex-wrap items-center gap-2">
												<span className="font-medium">{item.to}</span>
												<span className="text-kumo-subtle">
													{item.source} · queued {ago(item.createdAt)} ·{" "}
													{item.attempts === 0
														? "not yet attempted"
														: `attempt ${item.attempts} failed, next ${due > 0 ? `in ${Math.ceil(due / 60000)} min` : "on the next run"}`}
												</span>
												{item.errorKind && <Badge variant="warning">{item.errorKind}</Badge>}
											</div>
											<div className="truncate">{item.subject}</div>
											{item.error && <div className="text-kumo-subtle break-words">{item.error}</div>}
										</div>
									);
								})}
							</div>
						)}
					</section>

					<section className="space-y-2">
						<h2 className="font-medium">Given up on ({status.failed.length})</h2>
						{status.failed.length === 0 ? (
							<p className="text-sm text-kumo-subtle">Nothing. Every message has either been delivered or is still queued.</p>
						) : (
							<div className="divide-y rounded border">
								{status.failed.map((item) => (
									<div key={item.id} className="flex flex-col gap-1 p-3 text-sm md:flex-row md:items-start md:justify-between">
										<div className="min-w-0 space-y-1">
											<div className="flex flex-wrap items-center gap-2">
												<span className="font-medium">{item.to}</span>
												<Badge variant={item.errorKind === "permanent" ? "error" : "warning"}>{item.errorKind}</Badge>
												<span className="text-kumo-subtle">
													{item.source} · {item.attempts} attempt{item.attempts === 1 ? "" : "s"} · {ago(item.lastAttemptAt ?? item.createdAt)}
												</span>
											</div>
											<div className="truncate">{item.subject}</div>
											<div className="text-kumo-subtle break-words">{item.error}</div>
										</div>
										<div className="flex shrink-0 gap-2">
											<Button size="sm" disabled={busy} onClick={() => void act(`Re-queued ${item.to}`, () => call("retry", { id: item.id }))}>
												Retry
											</Button>
											<Button
												size="sm"
												variant="ghost"
												disabled={busy}
												onClick={() => void act(`Discarded message to ${item.to}`, () => call("discard", { id: item.id }))}
											>
												Discard
											</Button>
										</div>
									</div>
								))}
							</div>
						)}
						{status.failed.some((f) => f.errorKind === "unconfirmed") && (
							<p className="text-xs text-kumo-subtle">
								“Unconfirmed” means Postal never replied in time. The message may already have been delivered; retrying
								may send it again.
							</p>
						)}
					</section>
				</>
			)}
		</div>
	);
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "success" | "error" }) {
	return (
		<div className="rounded border p-3">
			<div className="text-xs uppercase tracking-wide text-kumo-subtle">{label}</div>
			<div className={`text-lg font-semibold ${tone === "error" ? "text-red-700" : tone === "success" ? "text-green-700" : ""}`}>
				{value}
			</div>
			{hint && <div className="text-xs text-kumo-subtle">{hint}</div>}
		</div>
	);
}

export const pages: PluginAdminExports["pages"] = {
	"/": PostalPage,
};
