// A stand-in for `engram mcp`, so the Memory panel's bridge half can be tested without Engram.
//
// It speaks the MCP handshake over stdin/stdout and answers from a scenario file named by
// FAKE_MCP_SCENARIO, appending every message it receives and its own argv and pid to
// FAKE_MCP_JOURNAL. A test therefore sees both what the bridge asked for and whether the child it
// started is still alive.
//
// It never writes memory: it has no storage, and its answers are recorded payloads.
import { appendFileSync, readFileSync } from "node:fs";

const scenario = JSON.parse(readFileSync(process.env.FAKE_MCP_SCENARIO, "utf8"));
const journal = process.env.FAKE_MCP_JOURNAL;
// Tool names whose answer never arrives: the bridge has to time out and kill this process.
const hanging = new Set(scenario.hangOn ?? []);

function record(entry) {
	appendFileSync(journal, `${JSON.stringify(entry)}\n`);
}

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function toolResult(name) {
	const entry = scenario.tools?.[name];
	if (entry === undefined) {
		return { content: [{ type: "text", text: JSON.stringify({ result: `no recorded answer for ${name}` }) }] };
	}
	if (typeof entry.error === "string") {
		return { content: [{ type: "text", text: entry.error }], isError: true };
	}
	if (typeof entry.fixture === "string") {
		return { content: [{ type: "text", text: readFileSync(new URL(entry.fixture, import.meta.url), "utf8") }] };
	}
	if (entry.json !== undefined) {
		return { content: [{ type: "text", text: JSON.stringify(entry.json) }] };
	}
	return { content: [{ type: "text", text: entry.text ?? "" }] };
}

function handle(line) {
	const message = JSON.parse(line);
	record({ kind: "message", message });

	if (message.method === "initialize") {
		if (typeof scenario.initializeError === "string") {
			send({ jsonrpc: "2.0", id: message.id, error: { code: -32600, message: scenario.initializeError } });
			return;
		}
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				protocolVersion: "2024-11-05",
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: "engram", version: "0.0.0-fake" },
			},
		});
		return;
	}

	// Notifications carry no id and are never answered.
	if (message.id === undefined) return;

	if (message.method === "tools/list") {
		const names = scenario.toolNames ?? Object.keys(scenario.tools ?? {});
		send({ jsonrpc: "2.0", id: message.id, result: { tools: names.map((name) => ({ name })) } });
		return;
	}

	if (message.method === "tools/call") {
		const name = message.params?.name ?? "";
		if (hanging.has(name)) return;
		send({ jsonrpc: "2.0", id: message.id, result: toolResult(name) });
	}
}

record({ kind: "start", pid: process.pid, argv: process.argv.slice(2) });

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let index = buffer.indexOf("\n");
	while (index >= 0) {
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		if (line.trim().length > 0) handle(line);
		index = buffer.indexOf("\n");
	}
});
