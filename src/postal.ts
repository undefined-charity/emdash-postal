/**
 * The Postal HTTP client and the message shapes it needs.
 *
 * Kept free of EmDash plugin types so the queue logic can be reasoned about
 * (and tested) on its own: everything here takes settings and a payload and
 * either resolves or throws a `PostalSendError` that says whether retrying
 * could possibly help.
 */

export interface PostalSettings {
	/** Postal server origin, e.g. https://postal.example.com */
	baseUrl: string;
	/** Server API credential (sent as X-Server-API-Key) */
	apiKey: string;
	/** Default From, e.g. "Bad Dog <hello@example.com>" */
	fromAddress: string;
}

/** Body of `POST /api/v1/send/message`. */
export interface PostalPayload {
	to: string[];
	cc?: string[];
	from: string;
	reply_to?: string;
	subject: string;
	plain_body: string;
	html_body?: string;
	headers?: Record<string, string>;
}

/**
 * How a failed send should be treated.
 *
 * - `transient`   — network trouble, 5xx, rate limiting. Worth retrying later.
 * - `permanent`   — Postal understood the request and said no (bad address,
 *                   bad credential, parameter error). Retrying repeats the
 *                   refusal; a person has to look.
 * - `unconfirmed` — we gave up waiting. Postal may well have accepted the
 *                   message, so a retry risks a duplicate. Handled apart.
 */
export type FailureKind = "transient" | "permanent" | "unconfirmed";

export class PostalSendError extends Error {
	constructor(
		message: string,
		public readonly kind: FailureKind,
	) {
		super(message);
		this.name = "PostalSendError";
	}
}

const EMAIL_RE = /^.+@.+\..+$/;

/** Accepts both "user@host" and "Name <user@host>". */
export function isValidEmail(value: string): boolean {
	const angled = value.match(/<([^>]+)>\s*$/);
	return EMAIL_RE.test(angled ? angled[1] : value);
}

/** Reduce a user-entered server URL to its origin, or null if unusable. */
export function normalizeBaseUrl(value: string): string | null {
	try {
		const url = new URL(value.trim());
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		return url.origin;
	} catch {
		return null;
	}
}

/**
 * EmDash's EmailMessage doesn't model CC/Reply-To, but the pipeline passes
 * extra fields through to the deliver hook untouched. Senders (e.g. a contact
 * form plugin) can attach `cc` (string | string[]), `replyTo` (string), and
 * `headers` (Record<string, string>, e.g. List-Unsubscribe); invalid or
 * missing values are ignored.
 */
export function extractExtras(message: Record<string, unknown>): Pick<PostalPayload, "cc" | "reply_to" | "headers"> {
	const extras: Pick<PostalPayload, "cc" | "reply_to" | "headers"> = {};

	const rawCc = message.cc;
	const ccList = (Array.isArray(rawCc) ? rawCc : rawCc !== undefined ? [rawCc] : []).filter(
		(v): v is string => typeof v === "string" && isValidEmail(v),
	);
	if (ccList.length > 0) extras.cc = ccList;

	const rawReplyTo = message.replyTo;
	if (typeof rawReplyTo === "string" && isValidEmail(rawReplyTo)) extras.reply_to = rawReplyTo;

	// Arbitrary headers, e.g. List-Unsubscribe / List-Unsubscribe-Post, which
	// Gmail and Yahoo require from bulk senders (RFC 8058). Names and values are
	// validated because a CR/LF in a header value is header injection — it would
	// let a caller append headers of its own or terminate the header block.
	const rawHeaders = message.headers;
	if (rawHeaders && typeof rawHeaders === "object" && !Array.isArray(rawHeaders)) {
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
			if (typeof value !== "string") continue;
			if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) continue;
			const clean = value.replace(/[\r\n]+/g, " ").trim();
			if (clean) headers[name] = clean;
		}
		if (Object.keys(headers).length > 0) extras.headers = headers;
	}

	return extras;
}

/**
 * Postal reply codes that mean the request itself is wrong. Retrying any of
 * these repeats the same refusal, so they dead-letter immediately rather than
 * burning five attempts.
 */
const PERMANENT_POSTAL_CODES = new Set([
	"ValidationError",
	"NoRecipients",
	"NoContent",
	"TooManyToAddresses",
	"TooManyCCAddresses",
	"TooManyBCCAddresses",
	"FromAddressMissing",
	"UnauthenticatedFromAddress",
	"AttachmentMissingName",
	"AttachmentMissingData",
	"InvalidServerAPIKey",
	"ServerSuspended",
]);

/**
 * Send one message through Postal's HTTP API.
 *
 * `fetchImpl` is whatever the plugin context provides (it enforces the
 * plugin's network capability); `timeoutMs` bounds the whole call so a stalled
 * connection surfaces as `unconfirmed` instead of hanging the job.
 */
export async function sendViaPostal(
	fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
	settings: PostalSettings,
	payload: PostalPayload,
	timeoutMs: number,
): Promise<{ messageId?: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	let response: Response;
	try {
		response = await fetchImpl(`${settings.baseUrl}/api/v1/send/message`, {
			method: "POST",
			headers: {
				"X-Server-API-Key": settings.apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
			signal: controller.signal,
		});
	} catch (error) {
		if (controller.signal.aborted) {
			throw new PostalSendError(
				`No reply from Postal within ${Math.round(timeoutMs / 1000)}s — the message may or may not have been accepted`,
				"unconfirmed",
			);
		}
		throw new PostalSendError(
			`Could not reach Postal: ${error instanceof Error ? error.message : String(error)}`,
			"transient",
		);
	} finally {
		clearTimeout(timer);
	}

	const bodyText = await response.text();

	if (!response.ok) {
		// A credential problem won't fix itself; everything else on the HTTP
		// layer (5xx, 429, proxies) is worth another go.
		const kind: FailureKind = response.status === 401 || response.status === 403 ? "permanent" : "transient";
		throw new PostalSendError(`Postal returned HTTP ${response.status}: ${bodyText.slice(0, 500)}`, kind);
	}

	// Postal replies 200 with {"status":"success"|"error"|"parameter-error","data":{...}}
	let parsed: { status?: string; data?: { code?: string; message?: string; message_id?: string } };
	try {
		parsed = JSON.parse(bodyText) as typeof parsed;
	} catch {
		throw new PostalSendError(`Postal returned an unparseable response: ${bodyText.slice(0, 500)}`, "transient");
	}

	if (parsed.status !== "success") {
		const code = parsed.data?.code ?? "";
		const detail = parsed.data?.message ?? code ?? bodyText.slice(0, 500);
		const kind: FailureKind =
			parsed.status === "parameter-error" || PERMANENT_POSTAL_CODES.has(code) ? "permanent" : "transient";
		throw new PostalSendError(`Postal rejected the message (${code || parsed.status}): ${detail}`, kind);
	}

	return { messageId: parsed.data?.message_id };
}
