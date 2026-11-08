import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { PiRecord } from "@gentle-shell/protocol";

export interface PiProcessOptions {
	/** Working directory of the agent. */
	readonly cwd: string;
	/** Executable that runs Pi. Defaults to `pi` on PATH. */
	readonly executable?: string;
	/** Arguments passed before `--mode rpc`. */
	readonly args?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly requestTimeoutMs?: number;
}

interface PendingRequest {
	readonly command: string;
	readonly resolve: (data: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly timer: NodeJS.Timeout;
}

interface ExitInfo {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stderr: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 3_000;

/**
 * One `pi --mode rpc` child process.
 *
 * Framing is strict JSONL: records split on LF only, because `\u2028`/`\u2029` are legal inside
 * JSON strings and a generic line reader would corrupt them (Pi's own docs call this out).
 *
 * Emits:
 * - `record` (record) for every stdout record that is not a command response
 * - `ui-request` (request) for `extension_ui_request` dialog records
 * - `log` (line) for each stderr line
 * - `exit` (info) once the process is gone
 */
export class PiProcess extends EventEmitter {
	#child: ChildProcess | null = null;
	#buffer = "";
	#counter = 0;
	#pending = new Map<string, PendingRequest>();
	#stderr: string[] = [];
	#exited = false;
	#exitInfo: ExitInfo | null = null;
	readonly #options: PiProcessOptions;

	constructor(options: PiProcessOptions) {
		super();
		this.#options = options;
	}

	get cwd(): string {
		return this.#options.cwd;
	}

	get exited(): boolean {
		return this.#exited;
	}

	get stderrTail(): string {
		return this.#stderr.join("\n");
	}

	start(): void {
		if (this.#child) throw new Error("pi process already started");

		const executable = this.#options.executable ?? "pi";
		const args = ["--mode", "rpc", ...(this.#options.args ?? [])];
		const child = spawn(executable, args, {
			cwd: this.#options.cwd,
			env: { ...process.env, ...this.#options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.#child = child;
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => this.#consume(chunk));
		child.stderr?.on("data", (chunk: string) => this.#consumeStderr(chunk));
		child.on("error", (error) => this.#fail(error));
		child.on("exit", (code, signal) => this.#onExit(code, signal));
	}

	/** Send one RPC command and resolve with its `response.data`. */
	send<T = unknown>(
		command: string,
		params: Readonly<Record<string, unknown>> = {},
		timeoutMs = this.#options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
	): Promise<T> {
		const child = this.#child;
		if (!child || this.#exited) return Promise.reject(new Error("pi process is not running"));

		const id = `req-${++this.#counter}`;
		const record = { id, type: command, ...params };

		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`pi did not answer "${command}" within ${timeoutMs}ms`));
			}, timeoutMs);

			this.#pending.set(id, {
				command,
				resolve: (data) => resolve(data as T),
				reject,
				timer,
			});

			this.#write(`${JSON.stringify(record)}\n`).catch((error: unknown) => {
				const pending = this.#pending.get(id);
				this.#pending.delete(id);
				if (pending) clearTimeout(pending.timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
	}

	/** Send a fire-and-forget record, such as an `extension_ui_response`. */
	sendRaw(record: Readonly<Record<string, unknown>>): Promise<void> {
		return this.#write(`${JSON.stringify(record)}\n`);
	}

	async stop(): Promise<void> {
		const child = this.#child;
		if (!child || this.#exited) return;

		child.stdin?.end();
		const exited = await this.#waitForExit(SHUTDOWN_GRACE_MS);
		if (!exited) child.kill("SIGTERM");
	}

	async #write(line: string): Promise<void> {
		const stdin = this.#child?.stdin;
		if (!stdin || stdin.destroyed) throw new Error("pi process stdin is closed");

		await new Promise<void>((resolve, reject) => {
			const drained = stdin.write(line, (error) => {
				if (error) reject(error);
			});
			if (drained) resolve();
			else stdin.once("drain", () => resolve());
		});
	}

	#consume(chunk: string): void {
		this.#buffer += chunk;
		let index = this.#buffer.indexOf("\n");
		while (index >= 0) {
			const raw = this.#buffer.slice(0, index);
			this.#buffer = this.#buffer.slice(index + 1);
			const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
			if (line.trim().length > 0) this.#handleLine(line);
			index = this.#buffer.indexOf("\n");
		}
	}

	#handleLine(line: string): void {
		let record: PiRecord;
		try {
			record = JSON.parse(line) as PiRecord;
		} catch {
			this.emit("log", `unparsable record from pi: ${line.slice(0, 200)}`);
			return;
		}

		if (record.type === "response") {
			this.#settle(record);
			return;
		}
		if (record.type === "extension_ui_request") {
			this.emit("ui-request", record);
		}
		this.emit("record", record);
	}

	#settle(record: PiRecord): void {
		const id = typeof record.id === "string" ? record.id : null;
		const pending = id ? this.#pending.get(id) : undefined;

		// A parse error arrives without an id. Surface it instead of dropping it.
		if (!pending) {
			const error = typeof record.error === "string" ? record.error : "command failed";
			this.emit("log", `unmatched pi response: ${error}`);
			return;
		}

		this.#pending.delete(id as string);
		clearTimeout(pending.timer);
		if (record.success === true) pending.resolve(record.data);
		else pending.reject(new Error(typeof record.error === "string" ? record.error : `${pending.command} failed`));
	}

	#consumeStderr(chunk: string): void {
		for (const line of chunk.split("\n")) {
			if (line.trim().length === 0) continue;
			this.#stderr.push(line);
			if (this.#stderr.length > 200) this.#stderr.shift();
			this.emit("log", line);
		}
	}

	#fail(error: Error): void {
		for (const [, pending] of this.#pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pending.clear();
		this.emit("log", `pi process error: ${error.message}`);
	}

	#onExit(code: number | null, signal: NodeJS.Signals | null): void {
		this.#exited = true;
		const info: ExitInfo = { code, signal, stderr: this.stderrTail };
		this.#exitInfo = info;
		this.#fail(new Error(`pi exited (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""})`));
		this.emit("exit", info);
	}

	async #waitForExit(timeoutMs: number): Promise<boolean> {
		if (this.#exitInfo) return true;
		return new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(false), timeoutMs);
			this.once("exit", () => {
				clearTimeout(timer);
				resolve(true);
			});
		});
	}
}
