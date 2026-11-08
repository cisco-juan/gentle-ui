import { startBridgeServer } from "./server.ts";

/**
 * Bridge entry point.
 *
 * Prints one handshake line on stdout so the desktop shell (or a dev browser session) can discover
 * the port and the token without guessing. Everything after that goes over the WebSocket.
 */
async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const port = readFlag(args, "--port");
	const token = readFlag(args, "--token");

	const server = await startBridgeServer({
		...(port === null ? {} : { port: Number.parseInt(port, 10) }),
		...(token === null ? {} : { token }),
	});

	process.stdout.write(`${JSON.stringify({ event: "ready", port: server.port, token: server.token })}\n`);

	let closing = false;
	const shutdown = async (): Promise<void> => {
		if (closing) return;
		closing = true;
		await server.close();
		process.exit(0);
	};

	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}

function readFlag(args: readonly string[], flag: string): string | null {
	const index = args.indexOf(flag);
	if (index < 0) return null;
	const value = args[index + 1];
	return value === undefined ? null : value;
}

await main();
