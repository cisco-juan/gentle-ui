// The packaging path of the bridge URL: no DOM to lean on, so the test fakes only `window`.
//
// The two directives match `keybindings.test.ts`: this package has no `@types/node`, the runner is
// Node's own, and `tsc --noEmit` must stay honest about every other line.
import assert from "node:assert/strict";
import test from "node:test";
import { BRIDGE_ENDPOINT_COMMAND, DEV_BRIDGE_URL, resolveBridgeUrl, websocketUrl } from "./bridge-endpoint.ts";

interface Invocation {
	readonly command: string;
}

type InvokeStub = ((command: string, args: unknown) => Promise<unknown>) & { readonly calls: Invocation[] };

/** Crash if the packaged branch is taken when it should not be. */
function forbiddenInvoke(): InvokeStub {
	const calls: Invocation[] = [];
	const invoke = (command: string): Promise<unknown> => {
		calls.push({ command });
		return Promise.reject(new Error(`the host must not be asked for ${command}`));
	};
	return Object.assign(invoke, { calls });
}

function hostInvoke(answer: () => Promise<unknown>): InvokeStub {
	const calls: Invocation[] = [];
	const invoke = (command: string): Promise<unknown> => {
		calls.push({ command });
		return answer();
	};
	return Object.assign(invoke, { calls });
}

/** The webview's own shape: `"__TAURI_INTERNALS__" in window` is the only thing the module probes. */
function installTauriWindow(invoke: InvokeStub): void {
	(globalThis as unknown as Record<string, unknown>).window = {
		__TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => invoke(command, args) },
	};
}

function removeWindow(): void {
	delete (globalThis as unknown as Record<string, unknown>).window;
}

test("a browser session falls back to the bridge scripts/dev.mjs starts", async () => {
	removeWindow();
	assert.equal(DEV_BRIDGE_URL, "ws://127.0.0.1:7787/?token=dev");
	assert.equal(await resolveBridgeUrl(), "ws://127.0.0.1:7787/?token=dev");
});

test("VITE_BRIDGE_URL wins over both the host and the dev default", async () => {
	const override = { VITE_BRIDGE_URL: "ws://127.0.0.1:9900/?token=dev" };
	try {
		removeWindow();
		assert.equal(await resolveBridgeUrl(override), "ws://127.0.0.1:9900/?token=dev");

		const invoke = forbiddenInvoke();
		installTauriWindow(invoke);
		assert.equal(await resolveBridgeUrl(override), "ws://127.0.0.1:9900/?token=dev");
		assert.deepEqual(invoke.calls, []);
	} finally {
		removeWindow();
	}
});

test("a packaged build asks the host and builds the socket URL from port and token", async () => {
	const invoke = hostInvoke(async () => ({ port: 47831, token: "9f2c4d" }));
	try {
		installTauriWindow(invoke);
		assert.equal(await resolveBridgeUrl(undefined), "ws://127.0.0.1:47831/?token=9f2c4d");
		assert.deepEqual(invoke.calls, [{ command: BRIDGE_ENDPOINT_COMMAND }]);
		assert.equal(BRIDGE_ENDPOINT_COMMAND, "bridge_endpoint");
	} finally {
		removeWindow();
	}
});

test("a bridge that never started reaches the UI as its own message, not as the dev port", async () => {
	const invoke = hostInvoke(async () => {
		throw new Error("the bundled bridge is missing from /opt/gentle-shell/bridge");
	});
	try {
		installTauriWindow(invoke);
		await assert.rejects(resolveBridgeUrl(undefined), {
			message: "the bundled bridge is missing from /opt/gentle-shell/bridge",
		});
	} finally {
		removeWindow();
	}
});

test("websocketUrl keeps a token with reserved characters intact", () => {
	assert.equal(websocketUrl({ port: 1, token: "a b&c" }), "ws://127.0.0.1:1/?token=a%20b%26c");
});
