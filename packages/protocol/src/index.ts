/**
 * Wire protocol between the desktop UI and the bridge.
 *
 * The bridge owns `pi --mode rpc` child processes. Everything the agent emits is forwarded
 * verbatim as a `record`; extension dialogs are promoted to `ui-request` so the UI can answer
 * them without inventing a rendering for the terminal.
 */

/** A raw JSONL record emitted by `pi --mode rpc`. Shape belongs to Pi, not to us. */
export interface PiRecord {
	readonly type: string;
	readonly [key: string]: unknown;
}

/** Dialog methods block the agent until the client answers. */
export type DialogMethod = "select" | "confirm" | "input" | "editor";

/** Fire-and-forget methods describe state the UI may render. */
export type NotificationMethod = "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text";

export interface ExtensionUiRequest extends PiRecord {
	/** Request id the answer must repeat. */
	readonly id: string;
	readonly method: DialogMethod | NotificationMethod;
	readonly title?: string;
	readonly message?: string;
	readonly options?: readonly string[];
	readonly placeholder?: string;
	readonly prefill?: string;
	readonly timeout?: number;
}

export interface ExtensionUiResponse {
	readonly value?: string;
	readonly confirmed?: boolean;
	readonly cancelled?: true;
}

export interface OpenThreadRequest {
	/** Workspace folder. Absent means the bridge's own working directory. */
	readonly cwd?: string;
	/** Session file to resume. Absent opens a fresh session. */
	readonly sessionPath?: string;
	readonly provider?: string;
	readonly model?: string;
}

/**
 * Pi RPC command name. The authoritative allowlist lives in the bridge
 * (`packages/bridge/src/commands.ts`); keep both in sync when Pi adds a command.
 */
export type PiCommand = string;


/**
 * The subset of Pi's session state this UI renders.
 *
 * Deliberately narrow: Pi may add fields, and the UI must keep working when it does.
 */
export interface SessionState {
	readonly model?: { readonly provider?: string; readonly id?: string; readonly name?: string };
	readonly thinkingLevel?: string;
	readonly isStreaming?: boolean;
	readonly isCompacting?: boolean;
	readonly steeringMode?: string;
	readonly followUpMode?: string;
	readonly sessionFile?: string;
	readonly cwd?: string;
	readonly [key: string]: unknown;
}

/** One entry of the bridge's session index, as shown in the sidebar. */
export interface SessionSummary {
	/** Absolute path of the session JSONL file; this is the value `switch_session` takes. */
	readonly path: string;
	/** Workspace recorded in the session header, empty when the file does not say. */
	readonly cwd: string;
	/** Explicit session name, else the trimmed first user message, else the file basename. */
	readonly title: string;
	/** File modification time in epoch milliseconds. */
	readonly updatedAt: number;
	readonly model?: string;
}

/** One slash command, skill, or prompt template advertised by the agent. */
export interface SlashCommand {
	readonly name: string;
	readonly description: string;
	readonly source?: string;
}

/** One entry of a workspace directory listing, paths relative to the workspace root. */
export interface WorkspaceTreeEntry {
	readonly name: string;
	readonly path: string;
	readonly kind: "file" | "dir";
}

/** A workspace file read by the inspector; `truncated` means the byte cap was hit. */
export interface WorkspaceFileContent {
	readonly content: string;
	readonly truncated: boolean;
}

/** How the working tree changed one path, in the vocabulary the changes list renders. */
export type GitFileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

export interface GitStatusFile {
	readonly path: string;
	readonly status: GitFileStatus;
	/** True when the change is already in the index, false when it lives in the working tree. */
	readonly staged: boolean;
	/** Line counts from `git diff --numstat`; absent for untracked files and binaries. */
	readonly additions?: number;
	readonly deletions?: number;
}

export interface GitStatus {
	readonly isRepo: boolean;
	/** Current branch, empty when the repository has no commit yet or git could not say. */
	readonly branch: string;
	readonly files: readonly GitStatusFile[];
}

export type ClientMessage =
	| ({ readonly kind: "open"; readonly id: string } & OpenThreadRequest)
	| { readonly kind: "close"; readonly threadId: string }
	| {
			readonly kind: "command";
			readonly id: string;
			readonly threadId: string;
			readonly command: PiCommand;
			readonly params?: Record<string, unknown>;
	  }
	| {
			readonly kind: "ui-response";
			readonly threadId: string;
			readonly requestId: string;
			readonly response: ExtensionUiResponse;
	  }
	| { readonly kind: "sessions"; readonly id: string }
	| { readonly kind: "git"; readonly id: string; readonly action: "status" }
	| { readonly kind: "git"; readonly id: string; readonly action: "diff"; readonly path: string }
	| { readonly kind: "fs"; readonly id: string; readonly action: "tree"; readonly path?: string }
	| { readonly kind: "fs"; readonly id: string; readonly action: "read"; readonly path: string };

export type ServerMessage =
	| {
			readonly kind: "opened";
			readonly id: string;
			readonly threadId: string;
			readonly state: unknown;
	  }
	| {
			readonly kind: "result";
			readonly id: string;
			readonly threadId: string;
			readonly command: string;
			readonly ok: boolean;
			readonly data?: unknown;
			readonly error?: string;
	  }
	| { readonly kind: "record"; readonly threadId: string; readonly record: PiRecord }
	| { readonly kind: "ui-request"; readonly threadId: string; readonly request: ExtensionUiRequest }
	| { readonly kind: "log"; readonly threadId: string; readonly line: string }
	| { readonly kind: "exited"; readonly threadId: string; readonly code: number | null }
	| { readonly kind: "sessions"; readonly id: string; readonly items: readonly SessionSummary[] }
	/** Answer to `{kind:"git", action:"status"}`. */
	| { readonly kind: "git"; readonly id: string; readonly action: "status"; readonly data: GitStatus }
	/** Answer to `{kind:"git", action:"diff"}`: unified diff text, or a note for an untracked directory. */
	| { readonly kind: "git"; readonly id: string; readonly action: "diff"; readonly data: string }
	/** Answer to `{kind:"fs", action:"tree"}`. */
	| { readonly kind: "fs"; readonly id: string; readonly action: "tree"; readonly data: readonly WorkspaceTreeEntry[] }
	/** Answer to `{kind:"fs", action:"read"}`. */
	| { readonly kind: "fs"; readonly id: string; readonly action: "read"; readonly data: WorkspaceFileContent }
	| { readonly kind: "error"; readonly id?: string; readonly message: string };
