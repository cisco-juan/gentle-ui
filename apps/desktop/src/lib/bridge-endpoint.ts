/**
 * Where the shell finds its bridge.
 *
 * Three sources, in order, and the order is the whole point:
 *
 * 1. `VITE_BRIDGE_URL` — set by `scripts/dev.mjs` so a browser session can talk to the dev bridge
 *    without asking anyone. Also the manual escape hatch for pointing the UI at another host.
 * 2. The Tauri command `bridge_endpoint` — only a packaged app has a bundled bridge, and only Rust
 *    knows the port and token it printed on startup (`src-tauri/src/bridge_process.rs`).
 * 3. The dev default `ws://127.0.0.1:7787/?token=dev` — a plain browser with no build-time override,
 *    which is what `pnpm dev` alone gives you.
 *
 * Nothing here imports the Tauri API eagerly: in a browser that module is dead weight, and the
 * packaged branch is the only one that needs it.
 */

/** The payload of the `bridge_endpoint` command: what the bridge printed once it was listening. */
export interface BridgeEndpoint {
	readonly port: number;
	readonly token: string;
}

/** Name of the Rust command that answers with the running bridge's `{ port, token }`. */
export const BRIDGE_ENDPOINT_COMMAND = "bridge_endpoint";

/** What `scripts/dev.mjs` starts when nothing overrides it: bridge on 7787, token `dev`. */
export const DEV_BRIDGE_URL = "ws://127.0.0.1:7787/?token=dev";

/** The slice of `import.meta.env` this module reads; a plain object keeps the module testable. */
export interface BridgeEnv {
	readonly VITE_BRIDGE_URL?: string;
}

/** Build the socket URL the bridge client expects. The token goes in the query string, encoded. */
export function websocketUrl(endpoint: BridgeEndpoint): string {
	return `ws://127.0.0.1:${endpoint.port}/?token=${encodeURIComponent(endpoint.token)}`;
}

/** True inside the Tauri webview (development or packaged), false in a plain browser. */
export function isTauriHost(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Resolve the bridge URL before the first connection.
 *
 * Rejects only in a packaged build whose bridge is missing or dead: the message is Rust's, meant for
 * the user, and the caller must show it. Falling back to the dev port there would hide a broken bundle
 * behind a confusing connection timeout.
 *
 * `env` exists so the precedence is testable without Vite; production code passes nothing.
 */
export async function resolveBridgeUrl(env: BridgeEnv | undefined = importMetaEnv()): Promise<string> {
	const override = env?.VITE_BRIDGE_URL;
	if (typeof override === "string" && override.length > 0) return override;
	if (!isTauriHost()) return DEV_BRIDGE_URL;

	const { invoke } = await import("@tauri-apps/api/core");
	return websocketUrl(await invoke<BridgeEndpoint>(BRIDGE_ENDPOINT_COMMAND));
}

/**
 * `import.meta.env` under Vite, `undefined` under Node's test runner.
 *
 * The expression has to stay literal: Vite substitutes `import.meta.env` while bundling, so reading it
 * through an alias would leave the dev override unset in the built app. Bare Node simply has no `env`.
 */
function importMetaEnv(): BridgeEnv | undefined {
	const url: unknown = import.meta.env?.VITE_BRIDGE_URL;
	return typeof url === "string" ? { VITE_BRIDGE_URL: url } : undefined;
}
