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

/** One composer attachment the bridge accepted: an absolute path the agent can read. */
export interface UploadedFile {
	/** Absolute path inside the agent home's uploads directory. */
	readonly path: string;
	readonly bytes: number;
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

/**
 * Native review (receipt-driven development), as far as this UI renders it.
 *
 * The provider spawns nothing here: `review status` is the only source of truth, and the bridge turns
 * its JSON into these shapes before the panel sees it. A provider schema bump therefore never reaches
 * a component. The artefacts under `.git/gentle-ai/review-transactions/` name a lineage; the status of
 * that lineage is what confirms it, so nothing here is read from disk as authority.
 */
export interface ReviewAuthority {
	/** Authority layout, `compact-v2` on a modern provider. */
	readonly version: string;
	readonly lineageId: string;
	readonly state: string;
	readonly generation: number;
	/** Digest of the authority revision this lineage is at. */
	readonly revision: string;
}

/** The budget a review froze when it started; it never moves afterwards. */
export interface ReviewFrozen {
	readonly tier: string;
	readonly changedLines: number;
	readonly correctionBudget: number;
	readonly changedPathManifestDigest: string;
}

export type ReviewTransitionKind = "execute" | "collect" | "stop";

/** The step an `execute` transition invites: its tokens are the provider's, never synthesized. */
export interface ReviewExecuteStep {
	readonly operation: string;
	/** The provider's own rendering of the command. Display only; it is never run as a string. */
	readonly command: string;
	readonly tokens: readonly string[];
	readonly lineageId: string | null;
	readonly targetIdentity: string | null;
}

/** One artefact an `collect` transition is waiting for; capturing it belongs to a later phase. */
export interface ReviewCollectInput {
	readonly name: string;
	readonly schema: string;
	readonly captureOperation: string;
}

export interface ReviewTransition {
	readonly kind: ReviewTransitionKind;
	/** The provider's reason code, shown verbatim. */
	readonly reasonCode: string;
	readonly execute: ReviewExecuteStep | null;
	readonly collect: readonly ReviewCollectInput[];
}

/**
 * What the Review tab renders.
 *
 * `state` says whether the provider answered at all: `empty` means there is no repository to ask
 * about, `unreadable` means the answer was not the negotiated JSON and `raw` carries it for display.
 * `emptiness` is narrower: which honest empty state the authority section shows when nothing is
 * authoritative yet.
 */
export interface ReviewStatusView {
	readonly state: "ok" | "empty" | "unreadable";
	readonly emptiness: "not-a-repository" | "no-authority" | null;
	readonly message: string;
	/** The workspace the panel asked about. */
	readonly repository: string;
	readonly contract: string;
	readonly applicability: string;
	readonly action: string;
	readonly targetIdentity: string;
	readonly projection: string;
	readonly changedPaths: readonly string[];
	readonly authority: ReviewAuthority | null;
	/** True when the authority belongs to an earlier target than the one the provider reports now. */
	readonly authorityStale: boolean;
	readonly frozen: ReviewFrozen | null;
	readonly transition: ReviewTransition | null;
	/** The untouched answer, present only when it could not be parsed. */
	readonly raw: string | null;
}

/** `review assess`: the read-only risk a start would freeze. */
export interface ReviewAssessment {
	readonly risk: string;
	readonly reasons: readonly { readonly code: string; readonly path: string | null }[];
	readonly changedPaths: number;
	readonly changedLines: number;
	readonly candidateKind: string;
	readonly candidateConsumed: boolean;
	readonly reviewDue: boolean;
	readonly reviewDueReason: string;
}

/** `review mode status`: the user-owned switch, with both sources and the effective answer. */
export interface ReviewMode {
	readonly global: string;
	readonly cloneLocal: string;
	readonly effective: string;
	readonly source: string;
	readonly revision: string;
}

/** One answer of the blocking consent question; its `invocation` is the exact command to replay. */
export interface ReviewConsentChoice {
	readonly answer: string;
	readonly label: string;
	readonly effect: string;
	readonly invocation: string;
}

export interface ReviewConsent {
	readonly schema: string;
	readonly blocking: boolean;
	readonly targetIdentity: string;
	readonly projection: string;
	readonly riskLevel: string;
	readonly changedFiles: number;
	readonly changedLines: number;
	readonly headline: string;
	readonly reason: string;
	readonly value: string;
	readonly riskEvidence: readonly string[];
	/** Exactly two ordered choices: the provider's answer, or none. */
	readonly choices: readonly ReviewConsentChoice[];
	readonly offPath: { readonly note: string; readonly command: string } | null;
}

/**
 * The answer to a start: the frozen lineage, the consent question that must be answered first, or
 * the record that the change was skipped.
 */
export interface ReviewStartView {
	readonly outcome: "started" | "consent" | "declined";
	readonly consent: ReviewConsent | null;
	readonly lineageId: string;
	readonly state: string;
	readonly riskLevel: string;
	readonly selectedLenses: readonly string[];
	readonly changedFiles: number;
	readonly changedLines: number;
	readonly correctionBudget: number;
	readonly message: string;
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
	/** A dropped or pasted file, base64 encoded, for the bridge to write into the agent home. */
	| { readonly kind: "upload"; readonly id: string; readonly name: string; readonly dataBase64: string }
	| { readonly kind: "git"; readonly id: string; readonly action: "status" }
	| { readonly kind: "git"; readonly id: string; readonly action: "diff"; readonly path: string }
	| { readonly kind: "fs"; readonly id: string; readonly action: "tree"; readonly path?: string }
	| { readonly kind: "fs"; readonly id: string; readonly action: "read"; readonly path: string }
	/** Native review, always against the bridge's workspace. */
	| { readonly kind: "review"; readonly id: string; readonly action: "status" | "assess" | "mode" }
	/** Start a review with the tokens its own status transition carried. */
	| { readonly kind: "review"; readonly id: string; readonly action: "start"; readonly tokens: readonly string[] }
	/** Answer the blocking consent question by replaying the chosen invocation. */
	| { readonly kind: "review"; readonly id: string; readonly action: "consent"; readonly invocation: string };

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
	/** Answer to `{kind:"upload"}`: where the file landed and how many bytes were written. */
	| { readonly kind: "upload"; readonly id: string; readonly data: UploadedFile }
	/** Answer to `{kind:"git", action:"status"}`. */
	| { readonly kind: "git"; readonly id: string; readonly action: "status"; readonly data: GitStatus }
	/** Answer to `{kind:"git", action:"diff"}`: unified diff text, or a note for an untracked directory. */
	| { readonly kind: "git"; readonly id: string; readonly action: "diff"; readonly data: string }
	/** Answer to `{kind:"fs", action:"tree"}`. */
	| { readonly kind: "fs"; readonly id: string; readonly action: "tree"; readonly data: readonly WorkspaceTreeEntry[] }
	/** Answer to `{kind:"fs", action:"read"}`. */
	| { readonly kind: "fs"; readonly id: string; readonly action: "read"; readonly data: WorkspaceFileContent }
	| ({
			readonly kind: "review";
			readonly id: string;
	  } & ReviewResult)
	| { readonly kind: "error"; readonly id?: string; readonly message: string };

/** One review answer, tagged with the action that asked for it. */
export type ReviewResult =
	| { readonly action: "status"; readonly data: ReviewStatusView }
	| { readonly action: "assess"; readonly data: ReviewAssessment }
	| { readonly action: "mode"; readonly data: ReviewMode }
	| { readonly action: "start"; readonly data: ReviewStartView }
	| { readonly action: "consent"; readonly data: ReviewStartView };
