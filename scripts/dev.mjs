#!/usr/bin/env node
/**
 * Dev launcher: the bridge and the Vite server in one terminal.
 *
 * The desktop shell is not needed during UI work — the same Solid app runs in a browser and speaks to
 * the same bridge, so iteration is instant.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const port = process.env.BRIDGE_PORT ?? "7787";
const token = process.env.BRIDGE_TOKEN ?? "dev";

const children = [];

function run(name, command, args, options = {}) {
	const child = spawn(command, args, {
		cwd: root,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, ...(options.env ?? {}) },
	});
	child.stdout.on("data", (chunk) => process.stdout.write(prefixed(name, chunk)));
	child.stderr.on("data", (chunk) => process.stderr.write(prefixed(name, chunk)));
	child.on("exit", (code) => {
		if (code !== 0 && code !== null) {
			process.stderr.write(prefixed(name, `exited with code ${code}`));
			shutdown(code);
		}
	});
	children.push(child);
	return child;
}

function prefixed(name, chunk) {
	return String(chunk)
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => `[${name}] ${line}\n`)
		.join("");
}

let stopping = false;
function shutdown(code = 0) {
	if (stopping) return;
	stopping = true;
	for (const child of children) child.kill("SIGTERM");
	setTimeout(() => process.exit(code), 150);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

run("bridge", "node", ["--experimental-strip-types", join(root, "packages/bridge/src/main.ts"), "--port", port, "--token", token]);
run("web", "pnpm", ["--filter", "@gentle-shell/desktop", "dev"], {
	env: { VITE_BRIDGE_URL: `ws://127.0.0.1:${port}/?token=${token}` },
});
