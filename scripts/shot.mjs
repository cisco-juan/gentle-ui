#!/usr/bin/env node
/**
 * Screenshot helper for UI review.
 *
 * The shared browser session in this environment returns blank frames, so this drives its own headless
 * Chromium over CDP: no dependencies beyond `ws`, an exact viewport (not a window size), a wait
 * condition before the shot, and an optional interaction script.
 *
 * Usage:
 *   node scripts/shot.mjs --out /tmp/ui.png [--url http://localhost:1420/] [--width 1480] [--height 900]
 *                         [--wait-ready] [--eval "document.querySelector('.chip').click()"] [--settle 800]
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
	const index = args.indexOf(`--${name}`);
	return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const has = (name) => args.includes(`--${name}`);

const url = flag("url", "http://localhost:1420/");
const out = flag("out", "/tmp/ui-shot.png");
const width = Number.parseInt(flag("width", "1480"), 10);
const height = Number.parseInt(flag("height", "900"), 10);
const settle = Number.parseInt(flag("settle", "700"), 10);
const evalScript = flag("eval");
const evalAfterReload = flag("eval-after");

function findChrome() {
	const roots = [join(homedir(), ".cache", "ms-playwright")];
	for (const root of roots) {
		if (!existsSync(root)) continue;
		for (const entry of readdirSync(root).filter((name) => name.startsWith("chromium-")).sort().reverse()) {
			const candidate = join(root, entry, "chrome-linux", "chrome");
			if (existsSync(candidate)) return candidate;
		}
	}
	return "google-chrome-stable";
}

const chrome = spawn(findChrome(), [
	"--headless=new",
	"--disable-gpu",
	"--no-sandbox",
	"--hide-scrollbars",
	"--force-device-scale-factor=1",
	"--remote-debugging-port=0",
	`--window-size=${width},${height}`,
	"about:blank",
]);

const endpoints = [];
chrome.stderr.on("data", (chunk) => {
	const text = String(chunk);
	for (const match of text.matchAll(/ws:\/\/[^\s]+/g)) endpoints.push(match[0]);
});

async function browserEndpoint(timeoutMs = 15000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (endpoints.length > 0) return endpoints[0];
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("chromium did not expose a debugging endpoint");
}

/** Node 22 ships a WebSocket client, so CDP needs no dependency. */
function command(socket, { id, method, params = {}, sessionId }) {
	return new Promise((resolve, reject) => {
		const onMessage = (event) => {
			const message = JSON.parse(String(event.data));
			if (message.id !== id) return;
			socket.removeEventListener("message", onMessage);
			if (message.error) reject(new Error(message.error.message));
			else resolve(message.result);
		};
		socket.addEventListener("message", onMessage);
		socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
	});
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
	const endpoint = await browserEndpoint();
	const socket = new WebSocket(endpoint);
	await new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve, { once: true });
		socket.addEventListener("error", () => reject(new Error("cannot attach to the debugging endpoint")), { once: true });
	});

	let id = 0;
	const nextId = () => ++id;

	const { targetId } = await command(socket, { id: nextId(), method: "Target.createTarget", params: { url: "about:blank" } });
	const { sessionId } = await command(socket, {
		id: nextId(),
		method: "Target.attachToTarget",
		params: { targetId, flatten: true },
	});

	const sessionSend = (method, params = {}) => command(socket, { id: nextId(), method, params, sessionId });

	await sessionSend("Emulation.setDeviceMetricsOverride", {
		width,
		height,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await sessionSend("Page.enable");
	await sessionSend("Runtime.enable");

	const failures = [];
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(String(event.data));
		if (message.method === "Runtime.exceptionThrown") {
			const detail = message.params?.exceptionDetails;
			failures.push(detail?.exception?.description ?? detail?.text ?? "unknown exception");
		}
		if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
			failures.push(message.params.args.map((arg) => arg.description ?? arg.value ?? "").join(" "));
		}
	});
	process.on("exit", () => {
		if (failures.length > 0) process.stdout.write(`page failures:\n${failures.slice(0, 4).join("\n")}\n`);
	});
	await sessionSend("Page.navigate", { url });
	await sleep(1200);

	if (has("wait-ready")) {
		const started = Date.now();
		for (;;) {
			const { result } = await sessionSend("Runtime.evaluate", {
				expression: "Boolean(document.querySelector('.connection .dot.connected'))",
				returnByValue: true,
			});
			if (result.value === true) break;
			if (Date.now() - started > 20000) throw new Error("the shell never reported a connected bridge");
			await sleep(250);
		}
	}


	// Settle before interacting: a screenshot taken while the shell is still loading is a lie.
	await sleep(settle);

	if (evalScript) {
		const evaluation = await sessionSend("Runtime.evaluate", {
			expression: evalScript,
			awaitPromise: true,
			returnByValue: true,
		});
		if (evaluation?.result?.value !== undefined) {
			process.stdout.write(`${JSON.stringify(evaluation.result.value)}\n`);
		}
	}

	if (has("reload")) {
		await sessionSend("Page.reload", { ignoreCache: false });
		await sleep(1500);
		if (has("wait-ready")) {
			const started = Date.now();
			for (;;) {
				const { result } = await sessionSend("Runtime.evaluate", {
					expression: "Boolean(document.querySelector('.connection .dot.connected'))",
					returnByValue: true,
				});
				if (result.value === true) break;
				if (Date.now() - started > 20000) throw new Error("the shell never reconnected after reload");
				await sleep(250);
			}
		}
		if (evalAfterReload) {
			const evaluation = await sessionSend("Runtime.evaluate", {
				expression: evalAfterReload,
				awaitPromise: true,
				returnByValue: true,
			});
			process.stdout.write(`${JSON.stringify(evaluation.result.value)}\n`);
		}
	}

	await sleep(300);

	const shot = await sessionSend("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
	writeFileSync(out, Buffer.from(shot.data, "base64"));
	process.stdout.write(`${out}\n`);
	socket.close();
}

try {
	await main();
} finally {
	chrome.kill("SIGTERM");
}
