import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

/**
 * Runtime entry for the Postal email provider plugin.
 *
 * Settings (stored in the plugin's scoped KV, entered in Settings → Postal):
 * - `settings:baseUrl`     — Postal server origin, e.g. https://postal.example.com
 * - `settings:apiKey`      — Postal server API credential (X-Server-API-Key)
 * - `settings:fromAddress` — default From, e.g. "K9 Campout <noreply@example.com>"
 *
 * Delivery uses Postal's HTTP API (`POST /api/v1/send/message`), which works in
 * both trusted (Node) and sandboxed (Cloudflare Workers) plugin modes — no SMTP
 * sockets required.
 */

const EMAIL_RE = /^.+@.+\..+$/;

function isValidEmail(value: string): boolean {
	// Accept both "user@host" and "Name <user@host>" forms.
	const angled = value.match(/<([^>]+)>\s*$/);
	return EMAIL_RE.test(angled ? angled[1] : value);
}

function normalizeBaseUrl(value: string): string | null {
	try {
		const url = new URL(value.trim());
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		return url.origin;
	} catch {
		return null;
	}
}

interface PostalSettings {
	baseUrl: string;
	apiKey: string;
	fromAddress: string;
}

async function getSettings(ctx: PluginContext): Promise<Partial<PostalSettings>> {
	const [baseUrl, apiKey, fromAddress] = await Promise.all([
		ctx.kv.get<string>("settings:baseUrl"),
		ctx.kv.get<string>("settings:apiKey"),
		ctx.kv.get<string>("settings:fromAddress"),
	]);
	return {
		baseUrl: baseUrl ?? undefined,
		apiKey: apiKey ?? undefined,
		fromAddress: fromAddress ?? undefined,
	};
}

interface PostalPayload {
	to: string[];
	cc?: string[];
	from: string;
	reply_to?: string;
	subject: string;
	plain_body: string;
	html_body?: string;
}

/**
 * EmDash's EmailMessage doesn't model CC/Reply-To, but the pipeline passes
 * extra fields through to the deliver hook untouched. Senders (e.g. a contact
 * form plugin) can attach `cc` (string | string[]) and `replyTo` (string);
 * invalid or missing values are ignored.
 */
function extractExtras(message: Record<string, unknown>): { cc?: string[]; reply_to?: string } {
	const extras: { cc?: string[]; reply_to?: string } = {};
	const rawCc = (message as { cc?: unknown }).cc;
	const ccList = (Array.isArray(rawCc) ? rawCc : rawCc !== undefined ? [rawCc] : [])
		.filter((v): v is string => typeof v === "string" && isValidEmail(v));
	if (ccList.length > 0) extras.cc = ccList;
	const rawReplyTo = (message as { replyTo?: unknown }).replyTo;
	if (typeof rawReplyTo === "string" && isValidEmail(rawReplyTo)) extras.reply_to = rawReplyTo;
	return extras;
}

async function sendViaPostal(
	ctx: PluginContext,
	settings: PostalSettings,
	payload: PostalPayload,
): Promise<void> {
	if (!ctx.http) {
		throw new Error("Missing network:request:unrestricted capability");
	}

	const response = await ctx.http.fetch(`${settings.baseUrl}/api/v1/send/message`, {
		method: "POST",
		headers: {
			"X-Server-API-Key": settings.apiKey,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(payload),
	});

	const bodyText = await response.text();
	if (!response.ok) {
		throw new Error(`Postal API returned HTTP ${response.status}: ${bodyText.slice(0, 500)}`);
	}

	// Postal replies 200 with {"status":"success"|"error"|"parameter-error", "data":{...}}
	let parsed: { status?: string; data?: { code?: string; message?: string } };
	try {
		parsed = JSON.parse(bodyText) as typeof parsed;
	} catch {
		throw new Error(`Postal API returned unparseable response: ${bodyText.slice(0, 500)}`);
	}

	if (parsed.status !== "success") {
		const detail = parsed.data?.message ?? parsed.data?.code ?? bodyText.slice(0, 500);
		throw new Error(`Postal rejected the message (${parsed.status}): ${detail}`);
	}
}

async function buildSettingsPage(ctx: PluginContext) {
	const settings = await getSettings(ctx);
	return {
		blocks: [
			{
				type: "section",
				text: "Deliver EmDash email (invites, magic links, plugin mail) through your self-hosted Postal server's HTTP API.",
			},
			{
				type: "form",
				submit: { label: "Save Settings", action_id: "save_settings" },
				fields: [
					{
						type: "text_input",
						action_id: "baseUrl",
						label: "Postal Server URL",
						placeholder: "https://postal.example.com",
						initial_value: settings.baseUrl ?? "",
						required: true,
					},
					{
						type: "secret_input",
						action_id: "apiKey",
						label: "Server API Key",
						placeholder: "The credential from Postal → Server → Credentials (API type)",
						has_value: !!settings.apiKey,
						required: true,
					},
					{
						type: "text_input",
						action_id: "fromAddress",
						label: "From Address",
						placeholder: "K9 Campout <noreply@yourdomain.com>",
						initial_value: settings.fromAddress ?? "",
						required: true,
					},
				],
			},
			{
				type: "section",
				text: "Send a test email through Postal to verify the server URL and credential.",
			},
			{
				type: "form",
				submit: { label: "Send Test Email", action_id: "test_email" },
				fields: [
					{
						type: "text_input",
						action_id: "testEmailAddress",
						label: "Test Email Recipient",
						placeholder: "you@example.com",
						initial_value: "",
					},
				],
			},
		],
	};
}

type FormValues = Record<string, string | undefined>;

async function saveSettings(ctx: PluginContext, values: FormValues) {
	try {
		if (typeof values.baseUrl === "string" && values.baseUrl) {
			const normalized = normalizeBaseUrl(values.baseUrl);
			if (!normalized) {
				return {
					...(await buildSettingsPage(ctx)),
					toast: { message: "Postal Server URL must be a valid http(s) origin", type: "error" },
				};
			}
			await ctx.kv.set("settings:baseUrl", normalized);
		}

		// The secret input echoes a mask when unchanged — only store real values.
		if (typeof values.apiKey === "string" && values.apiKey && values.apiKey !== "********") {
			await ctx.kv.set("settings:apiKey", values.apiKey);
		}

		if (typeof values.fromAddress === "string" && values.fromAddress) {
			if (!isValidEmail(values.fromAddress)) {
				return {
					...(await buildSettingsPage(ctx)),
					toast: { message: "Invalid From Address (must contain @)", type: "error" },
				};
			}
			await ctx.kv.set("settings:fromAddress", values.fromAddress.trim());
		}

		return {
			...(await buildSettingsPage(ctx)),
			toast: { message: "Settings saved successfully", type: "success" },
		};
	} catch (error) {
		ctx.log.error("Failed to save Postal settings", error);
		return {
			...(await buildSettingsPage(ctx)),
			toast: { message: "Failed to save settings", type: "error" },
		};
	}
}

interface AdminInteraction {
	type: string;
	page?: string;
	action_id?: string;
	values?: FormValues;
}

export default {
	hooks: {
		"email:deliver": {
			exclusive: true,
			handler: async (event, ctx) => {
				const settings = await getSettings(ctx);
				if (!settings.baseUrl || !settings.apiKey || !settings.fromAddress) {
					ctx.log.error("Cannot send email: Postal server URL, API key, or From Address is missing");
					throw new Error("Postal settings missing. Configure them in Settings → Postal.");
				}

				const { message } = event;
				const extras = extractExtras(message as unknown as Record<string, unknown>);
				await sendViaPostal(ctx, settings as PostalSettings, {
					to: [message.to],
					...extras,
					from: settings.fromAddress,
					subject: message.subject,
					plain_body: message.text,
					html_body: message.html,
				});
				ctx.log.info("Email delivered via Postal", { to: message.to, ...(extras.cc ? { cc: extras.cc } : {}) });
			},
		},
	},

	routes: {
		admin: async (routeCtx, ctx) => {
			const interaction = routeCtx.input as AdminInteraction;

			if (interaction.type === "page_load" && interaction.page === "/settings") {
				return buildSettingsPage(ctx);
			}

			if (interaction.type === "form_submit" && interaction.action_id === "save_settings") {
				return saveSettings(ctx, interaction.values ?? {});
			}

			if (interaction.type === "form_submit" && interaction.action_id === "test_email") {
				try {
					const settings = await getSettings(ctx);
					const testEmailAddress = interaction.values?.testEmailAddress;

					if (!settings.baseUrl || !settings.apiKey || !settings.fromAddress) {
						return {
							...(await buildSettingsPage(ctx)),
							toast: {
								message: "Configure the server URL, API key and From Address before sending a test",
								type: "error",
							},
						};
					}
					if (!testEmailAddress || !isValidEmail(testEmailAddress)) {
						return {
							...(await buildSettingsPage(ctx)),
							toast: { message: "Enter a valid test email address", type: "error" },
						};
					}

					await sendViaPostal(ctx, settings as PostalSettings, {
						to: [testEmailAddress],
						from: settings.fromAddress,
						subject: "EmDash Postal plugin test email",
						plain_body:
							"Hello from the EmDash Postal plugin! If you can read this, your Postal server URL and API credential are working.",
					});

					return {
						...(await buildSettingsPage(ctx)),
						toast: { message: "Test email sent successfully!", type: "success" },
					};
				} catch (error) {
					return {
						...(await buildSettingsPage(ctx)),
						toast: {
							message: `Error: ${error instanceof Error ? error.message : String(error)}`,
							type: "error",
						},
					};
				}
			}

			return { blocks: [] };
		},
	},
} satisfies SandboxedPlugin;
