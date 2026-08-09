import type { PluginDescriptor } from "emdash";

/**
 * Postal email provider plugin for EmDash CMS.
 *
 * Registers an exclusive `email:deliver` transport that sends mail through a
 * self-hosted Postal server's HTTP API (`POST /api/v1/send/message`). Because
 * the Postal host is user-configured at runtime (Settings → Postal in the
 * admin UI), the plugin needs unrestricted outbound fetch rather than a fixed
 * `allowedHosts` list.
 */
export function emdashPostal(): PluginDescriptor {
	return {
		id: "emdash-postal",
		version: "0.1.0",
		format: "standard",
		entrypoint: "emdash-postal/sandbox",
		options: {},
		capabilities: ["hooks.email-transport:register", "network:request:unrestricted"],
		adminPages: [{ path: "/settings", label: "Postal", icon: "email" }],
	};
}

export default emdashPostal;
