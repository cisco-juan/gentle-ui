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

/**
 * The Memory tab: what Engram remembers, read over MCP stdio and projected before it reaches a
 * component.
 *
 * The panel is read-only, so there is no `saved` or `updated` shape here at all: the bridge may only
 * call tools that read, and every answer below is a read. `state` says what happened: `ok` for a
 * payload this panel parsed, `unparsable` for an answer that was not the JSON it expects (`raw`
 * keeps the text), and `unavailable` for a memory that could not be asked (no binary, no handshake,
 * no answer in time). A reason and a message always accompany the last two, so an empty list is
 * never mistaken for "you have no memories".
 */
export type MemoryState = "ok" | "unparsable" | "unavailable";

/** Why there is no memory to show, in the panel's own vocabulary. */
export type MemoryFailureReason =
	| "binary-missing"
	| "handshake-failed"
	| "timeout"
	| "tool-refused"
	| "tool-error";

/** The memory stats Engram prints at the end of a context answer. */
export interface MemoryCounts {
	readonly sessions: number;
	readonly observations: number;
	readonly projects: number;
}

/** One search hit. `text` is the text the server returned for it, not a field this panel filled in. */
export interface MemoryObservation {
	/** Engram's own id, as text so an id the panel never saw cannot be renumbered. Empty when absent. */
	readonly id: string;
	readonly title: string;
	readonly type: string;
	readonly scope: string;
	readonly pinned: boolean;
	readonly text: string;
	/** True when Engram itself truncated this text. */
	readonly truncated: boolean;
}

/** Answer to `{kind:"memory", action:"context"}`: the project Engram derived and its recent history. */
export interface MemoryContextView {
	readonly state: MemoryState;
	readonly reason: MemoryFailureReason | null;
	readonly message: string;
	readonly project: string;
	readonly projectPath: string;
	/** How Engram decided: `git_root`, `explicit_override`, `process_override`, … */
	readonly projectSource: string;
	readonly counts: MemoryCounts | null;
	readonly text: string;
	readonly raw: string | null;
}

/** Answer to `{kind:"memory", action:"search"}`: the query, and the hits grouped by the UI. */
export interface MemorySearchView {
	readonly state: MemoryState;
	readonly reason: MemoryFailureReason | null;
	readonly message: string;
	readonly project: string;
	readonly query: string;
	readonly observations: readonly MemoryObservation[];
	readonly text: string;
	readonly raw: string | null;
}

/** One project in Engram's index, with the counts it reports for it. */
export interface MemoryProjectEntry {
	readonly name: string;
	readonly observations: number;
	readonly sessions: number;
	readonly prompts: number;
	readonly directories: readonly string[];
}

/** Answer to `{kind:"memory", action:"projects"}`: every project Engram knows. */
export interface MemoryProjectsView {
	readonly state: MemoryState;
	readonly reason: MemoryFailureReason | null;
	readonly message: string;
	readonly count: number;
	readonly projects: readonly MemoryProjectEntry[];
	readonly text: string;
	readonly raw: string | null;
}

/**
 * Gentle Shell's agent-model profiles: named routing maps (agent -> model, thinking level, tier) kept in
 * `<config home>/profiles.json`, a file gentle-pi owns.
 *
 * The bridge reads and writes it with gentle-pi's own library, so the format never drifts from the
 * terminal's. `unavailable` says why there is nothing to show (the library could not be loaded, or the
 * file is not one gentle-pi accepts) and always carries a reason and a message; an empty list is never
 * composed to stand for either.
 */
export type ProfilesState = "ok" | "unavailable";

export type ProfilesFailureReason = "library-missing" | "library-incompatible" | "file-invalid";

/** One agent's route inside a profile. A field that is not set is null, never an empty string. */
export interface ProfileRoute {
	readonly agent: string;
	/** `provider/model`. */
	readonly model: string | null;
	readonly thinking: string | null;
	readonly tier: string | null;
}

export type ProfileMode = "organic" | "full-delegation";

export interface ProfileView {
	readonly name: string;
	readonly mode: ProfileMode;
	/** True for the global default that new threads start with when no repository pin overrides it. */
	readonly active: boolean;
	readonly routes: readonly ProfileRoute[];
}

/** Where a workspace's new threads get their profile from. */
export interface ProfileEffective {
	readonly name: string;
	readonly source: "pin-local" | "pin-repo" | "active";
}

export interface ProfilesView {
	readonly state: ProfilesState;
	readonly reason: ProfilesFailureReason | null;
	readonly message: string;
	readonly configHome: string;
	/** False while `profiles.json` does not exist yet. */
	readonly stored: boolean;
	readonly active: string | null;
	readonly effective: ProfileEffective | null;
	readonly profiles: readonly ProfileView[];
	/** Every agent name any profile routes, orchestrator first, so an editor can offer the full set. */
	readonly agents: readonly string[];
	/** Things worth saying: entries the reader dropped, pins that name a profile that is gone. */
	readonly notes: readonly string[];
}

/** The orchestrator a profile selects; Pi stores the provider and the model apart. */
export interface ProfileOrchestrator {
	readonly provider: string;
	readonly model: string;
	readonly thinking: string | null;
}

export interface ProfilesActivation {
	readonly view: ProfilesView;
	/** What the profile routes the orchestrator to, or null when it says nothing about it. */
	readonly orchestrator: ProfileOrchestrator | null;
	/** A repository pin that wins over the new default for subagents here, when there is one. */
	readonly pinnedTo: string | null;
}

/**
 * The permission mode new threads start in, which gentle-pi keeps in a file of its own.
 *
 * The mode decides whether the agent asks before it acts, so what may be changed from here is narrower than
 * what exists: `settable` lists the modes the bridge will write, and raising the default to `yolo` or
 * `super-yolo` is not among them. Those are chosen in a terminal, by a person, and the bridge refuses them
 * on the server rather than trusting the UI to hide them. A file gentle-pi cannot read is `unavailable`,
 * never read as `normal`.
 */
export type PermissionMode = "normal" | "auto" | "yolo" | "super-yolo";

export interface PermissionsView {
	readonly state: ProfilesState;
	readonly reason: ProfilesFailureReason | null;
	readonly message: string;
	/** The default for new threads, or null when it could not be read. */
	readonly default: PermissionMode | null;
	/** False while no preference has been saved and the built-in default applies. */
	readonly stored: boolean;
	readonly settable: readonly PermissionMode[];
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
	| { readonly kind: "review"; readonly id: string; readonly action: "consent"; readonly invocation: string }
	/** Engram's memory for the bridge's workspace. Every action here reads; none of them writes. */
	| { readonly kind: "memory"; readonly id: string; readonly action: "context" }
	| {
			readonly kind: "memory";
			readonly id: string;
			readonly action: "search";
			readonly query: string;
			readonly limit?: number;
	  }
	| { readonly kind: "memory"; readonly id: string; readonly action: "projects" }
	/** The default permission mode for new threads. Only a lowering is ever written from here. */
	| { readonly kind: "permissions"; readonly id: string; readonly action: "status" }
	| { readonly kind: "permissions"; readonly id: string; readonly action: "default"; readonly mode: string }
	/** Profiles. Every mutation answers with the whole list as it now is on disk. */
	| { readonly kind: "profiles"; readonly id: string; readonly action: "list" }
	| {
			readonly kind: "profiles";
			readonly id: string;
			readonly action: "save";
			readonly name: string;
			readonly routes: readonly ProfileRoute[];
			readonly mode: ProfileMode;
	  }
	/** A new profile, empty or copied from `from`. */
	| { readonly kind: "profiles"; readonly id: string; readonly action: "create"; readonly name: string; readonly from?: string }
	| { readonly kind: "profiles"; readonly id: string; readonly action: "rename"; readonly name: string; readonly to: string }
	| { readonly kind: "profiles"; readonly id: string; readonly action: "delete"; readonly name: string }
	/** Make a profile the global default and set the orchestrator it selects. */
	| { readonly kind: "profiles"; readonly id: string; readonly action: "activate"; readonly name: string };

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
	| ({
			readonly kind: "memory";
			readonly id: string;
	  } & MemoryResult)
	| ({
			readonly kind: "profiles";
			readonly id: string;
	  } & ProfilesResult)
	| ({
			readonly kind: "permissions";
			readonly id: string;
	  } & PermissionsResult)
	| { readonly kind: "error"; readonly id?: string; readonly message: string };

/** One memory answer, tagged with the action that asked for it. */
export type MemoryResult =
	| { readonly action: "context"; readonly data: MemoryContextView }
	| { readonly action: "search"; readonly data: MemorySearchView }
	| { readonly action: "projects"; readonly data: MemoryProjectsView };

/** One permissions answer. */
export type PermissionsResult = { readonly action: "status" | "default"; readonly data: PermissionsView };

/** One profiles answer, tagged with the action that asked for it. */
export type ProfilesResult =
	| { readonly action: "list" | "save" | "create" | "rename" | "delete"; readonly data: ProfilesView }
	| { readonly action: "activate"; readonly data: ProfilesActivation };

/** One review answer, tagged with the action that asked for it. */
export type ReviewResult =
	| { readonly action: "status"; readonly data: ReviewStatusView }
	| { readonly action: "assess"; readonly data: ReviewAssessment }
	| { readonly action: "mode"; readonly data: ReviewMode }
	| { readonly action: "start"; readonly data: ReviewStartView }
	| { readonly action: "consent"; readonly data: ReviewStartView };
