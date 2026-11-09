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

/**
 * One argument the provider rendered for a capture step.
 *
 * `token` is the provider's own flag rendering when it offered one; a selection argument carries the
 * value under a name and no token. Both are relayed verbatim, because a rewritten one names an
 * operation the provider never offered.
 */
export interface ReviewCollectArgument {
	readonly name: string;
	readonly value: string;
	readonly token: string | null;
}

/** One artefact an `collect` transition is waiting for; capturing it belongs to a later phase. */
export interface ReviewCollectInput {
	readonly name: string;
	readonly schema: string;
	readonly captureOperation: string;
	/** The provider's own arguments for the capture; empty when it named none. */
	readonly arguments: readonly ReviewCollectArgument[];
	/** The opaque binding the provider attached to the capture, flattened to its own fields. */
	readonly binding: readonly ReviewCollectArgument[];
}

export interface ReviewTransition {
	readonly kind: ReviewTransitionKind;
	/** The provider's reason code, shown verbatim. */
	readonly reasonCode: string;
	readonly execute: ReviewExecuteStep | null;
	readonly collect: readonly ReviewCollectInput[];
}

/**
 * The untracked-file declaration the provider's own status transition offered.
 *
 * `tokens` is that selection binding rendered as the provider's own assess flags; the bridge derives
 * it from the collect arguments, and the panel only relays it back. `paths` and `inventory` are the
 * binding's values, kept for display so the panel can say what the declaration includes.
 */
export interface ReviewUntrackedDeclaration {
	readonly inventory: string;
	readonly paths: readonly string[];
	readonly tokens: readonly string[];
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
	/** The untracked-file declaration the transition offered, or null when it offered none. */
	readonly untracked: ReviewUntrackedDeclaration | null;
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

/**
 * Themes and the rose: the two configuration files Gentle Shell already owns, read so this UI can follow
 * them.
 *
 * Pi stores the selected theme as one key of its own `settings.json`, so a read is one file and a write is
 * one key. The catalog is what the machine actually has — Pi's built-ins, the themes gentle-pi ships and the
 * user's own folder — and choosing a name that is not in it is refused on the bridge, not hidden by the UI.
 *
 * `rose` carries the two files as text rather than parsed values: the harness's own rules for them
 * (`parseBannerConfig`, `parseAnimationPolicy`) live in the UI, and a second parser here would be a second
 * answer to the same file.
 */
export type AppearanceState = "ok" | "unavailable";

/** Where one available theme's definition comes from; a later source wins over an earlier one. */
export type ThemeSource = "builtin" | "gentle-pi" | "user";

export interface ThemeCatalogEntry {
	readonly name: string;
	readonly source: ThemeSource;
}

/** One theme as a web UI paints it: its `colors` resolved against the file's own `vars`. */
export interface ResolvedTheme {
	readonly name: string;
	readonly tokens: Readonly<Record<string, string>>;
}

export interface AppearanceTheme {
	/** The theme Pi's settings select, or null when the file names none this bridge can read. */
	readonly current: string | null;
	readonly available: readonly ThemeCatalogEntry[];
	/**
	 * The current theme resolved, or the one the request named. Null when it has no file to resolve: `system`
	 * is synthesised by Pi from the terminal's colours, which a GUI has to answer with the OS scheme instead.
	 */
	readonly tokens: ResolvedTheme | null;
}

/** `banner.json` and `animations.json`, verbatim, so the UI parses them with the harness's own rules. */
export interface AppearanceRose {
	readonly banner: string | null;
	readonly animations: string | null;
}

export interface AppearanceView {
	readonly state: AppearanceState;
	readonly reason: ProfilesFailureReason | null;
	readonly message: string;
	readonly theme: AppearanceTheme;
	readonly rose: AppearanceRose;
}

/**
 * What the agent the bridge launches is configured with, read from its own files.
 *
 * The homes below are the ones `packages/bridge/src/pi-environment.ts` pins for the child process, so
 * `<agentHome>/settings.json`, `<agentHome>/mcp.json` and `<agentHome>/skills` are the configuration
 * this view reports — not `~/.pi/agent`, which is Pi's own. Every file is projected through the
 * library that owns its format; one that cannot be read is `unavailable` with a reason and a
 * message, never an empty list standing in for it.
 *
 * This view itself never writes: the keys it reports are the ones `SettingsKeysView` may set, and that
 * write is always a plan and a digest. MCP servers are the one part of the configuration that carries
 * credentials: their header and environment values, their OAuth secrets and the credentials and query
 * of a URL are never sent, and a secret renders as `<redacted>`.
 */
export type SettingsState = "ok" | "unavailable";

/** Why a part of the configuration cannot be shown, in the panel's own vocabulary. */
export type SettingsFailureReason = "library-missing" | "library-incompatible" | "file-invalid";

/** One key of `settings.json` this view reports, with the value as stored. */
export interface SettingsKeyValue {
	readonly key: string;
	/** A key that is not set, or holds something this view does not show, is null. */
	readonly value: string | number | boolean | null;
}

/** One writable key of `settings.json`: the three names `SettingsKeysView` may set. */
export type SettingsWritableKey = "defaultProvider" | "defaultModel" | "defaultThinkingLevel";

/** One entry of `settings.json`'s `packages`, whichever of the two forms it was written in. */
export interface SettingsPackage {
	readonly source: string;
	readonly autoload: boolean;
	/** Subdirectories of the package that are loaded; empty means the package's own defaults. */
	readonly extensions: readonly string[];
	readonly skills: readonly string[];
	readonly prompts: readonly string[];
	readonly themes: readonly string[];
}

/** `<agentHome>/settings.json`: the packages the agent loads and the keys the sheet shows. */
export interface SettingsConfigSection {
	readonly state: SettingsState;
	readonly reason: SettingsFailureReason | null;
	readonly message: string;
	readonly path: string;
	readonly stored: boolean;
	/** Empty when the file could not be read; the state says which. */
	readonly keys: readonly SettingsKeyValue[];
	readonly packages: readonly SettingsPackage[];
	readonly notes: readonly string[];
}

/** A header or environment name whose value is never sent. */
export interface SettingsSecretName {
	readonly name: string;
	readonly value: "<redacted>";
}

/** One MCP server, with every value that can hold a credential left out. */
export interface SettingsMcpServer {
	readonly name: string;
	readonly transport: "stdio" | "http";
	readonly enabled: boolean;
	readonly exposure: string;
	readonly command: string | null;
	readonly args: readonly string[];
	/** Scheme, host and path only: credentials and the query string are not reported. */
	readonly url: string | null;
	readonly headers: readonly SettingsSecretName[];
	readonly environment: readonly SettingsSecretName[];
	/** True when the server signs in with OAuth or a provider token, whose secret is not reported. */
	readonly oauth: boolean;
}

/** `<agentHome>/mcp.json`, as first written by Pi and edited by the terminal. */
export interface SettingsMcpSection {
	readonly state: SettingsState;
	readonly reason: SettingsFailureReason | null;
	readonly message: string;
	readonly path: string;
	readonly stored: boolean;
	readonly servers: readonly SettingsMcpServer[];
	readonly notes: readonly string[];
}

/** One skill found on disk. `temporary` is Pi's scope for a path `settings.json` names. */
export interface SettingsSkill {
	readonly name: string;
	readonly scope: "user" | "project" | "temporary";
	readonly path: string;
	readonly description: string;
}

/** The skills discovered on disk, with the folders they were looked for in. */
export interface SettingsSkillsSection {
	readonly state: SettingsState;
	readonly reason: SettingsFailureReason | null;
	readonly message: string;
	/** The agent home's own skills folder. */
	readonly path: string;
	/** Extra skill paths `settings.json` names; these are where a `temporary` skill comes from. */
	readonly paths: readonly string[];
	readonly entries: readonly SettingsSkill[];
	readonly notes: readonly string[];
}

export interface SettingsView {
	readonly state: SettingsState;
	readonly reason: SettingsFailureReason | null;
	readonly message: string;
	/** The agent home the bridge launches Pi with (`PI_CODING_AGENT_DIR`). */
	readonly agentHome: string;
	/** Gentle Shell's own config home (`GENTLE_SHELL_CONFIG_HOME`), where profiles live. */
	readonly configHome: string;
	readonly settings: SettingsConfigSection;
	readonly skills: SettingsSkillsSection;
	readonly mcp: SettingsMcpSection;
}

/**
 * A write that was refused, in a vocabulary a panel can render.
 *
 * `stale-plan` means the digest the confirmation carried no longer describes this request, or the plan
 * was already used; `changed-on-disk` means the file moved under the plan. Neither is `unavailable`: the
 * file is fine, the confirmation is not. Keep the two apart from `SettingsFailureReason`, which says why
 * a file cannot be read at all.
 */
export type ConfigRefusalReason = "stale-plan" | "changed-on-disk";

/** Why a write did not happen, readable or refused. */
export type ConfigFailureReason = SettingsFailureReason | ConfigRefusalReason;

/**
 * The plan a write would perform, exactly as the confirmation shows it.
 *
 * `digest` is the sha256 of the canonical plan (operation, target, before, after). An apply must send it
 * back unchanged: the bridge recomputes the plan, so this value is the confirmation, not a formality.
 * The file's content is not sent — a settings file can hold anything — only what the plan names.
 */
export interface ConfigPlanView {
	readonly operation: string;
	readonly target: string;
	readonly digest: string;
	readonly summary: readonly string[];
}

/**
 * The agent's `packages` list, as the settings sheet edits it.
 *
 * Writing is always two steps: `preview` returns a plan and its digest, and `apply` sends that digest
 * back. The bridge installs nothing here: Pi resolves and installs a configured package when it starts,
 * so a write to `settings.json` is the whole effect of an edit made from here.
 */
export type PackagesState = "ok" | "refused" | "unavailable";

export type PackagesOperation = "install" | "remove";

/** What a plan changes, rendered as the list before and after. */
export interface PackagesChange {
	readonly before: readonly SettingsPackage[];
	readonly after: readonly SettingsPackage[];
}

export interface PackagesView {
	readonly state: PackagesState;
	readonly reason: ConfigFailureReason | null;
	readonly message: string;
	/** `<agentHome>/settings.json`, the file this family writes. */
	readonly path: string;
	/** False while the file does not exist yet; an apply creates it. */
	readonly stored: boolean;
	/** The `packages` list as it is on disk now. */
	readonly packages: readonly SettingsPackage[];
	readonly notes: readonly string[];
	/** The confirmation: present for `preview` and `apply`, null for `list`, refused and unavailable. */
	readonly plan: ConfigPlanView | null;
	/** What that plan changes; null when there is no plan. */
	readonly change: PackagesChange | null;
	/** Where the bytes this apply replaced were kept; null when nothing was written. */
	readonly backup: string | null;
}

/**
 * The agent's `mcp.json`, as the settings sheet edits it.
 *
 * The same two steps as `packages`: `preview` returns a plan and its digest, `apply` sends that digest
 * back. This is the family that handles credentials, so nothing that leaves the bridge carries one: the
 * server list and the change are projections with `<redacted>` in place of every header and environment
 * value, the plan names fields rather than values, and the file's own text is never sent.
 *
 * An `update` is a patch, not a whole entry: a field the request does not mention is kept exactly as it
 * is on disk. That is what lets a header hold a secret the sheet never sees — the panel edits the
 * command and never has to send the token back.
 */
export type McpState = "ok" | "refused" | "unavailable";

export type McpOperation = "add" | "update" | "remove";

/**
 * The fields of one server a request may set.
 *
 * Deliberately not the whole entry: `oauth`, `auth` and `toolExposure` are left where they are, because
 * they carry credentials or a nested shape a confirmation cannot show, and the transport is named
 * instead of `type` so the request says what the server is rather than how Pi spells it.
 *
 * A field that is present replaces what is on disk (`headers: {}` removes them all); a field that is
 * absent is kept as it is. A secret therefore never has to travel to the panel and back.
 */
export interface McpServerPatch {
	/** Which transport this server speaks. Required by `add`; an `update` sets it only to change it. */
	readonly transport?: "stdio" | "http";
	/** The command a stdio server runs. */
	readonly command?: string;
	readonly args?: readonly string[];
	readonly cwd?: string;
	/** Environment a stdio server is started with; the values are secrets and are never sent back. */
	readonly env?: Readonly<Record<string, string>>;
	/** The URL of an http server; credentials in it are cut out of every projection. */
	readonly url?: string;
	/** Headers an http server is called with; the values are secrets and are never sent back. */
	readonly headers?: Readonly<Record<string, string>>;
	readonly enabled?: boolean;
	readonly exposure?: string;
	readonly description?: string;
}

/** What a plan changes: one server as it was and as it would be, both already redacted. */
export interface McpChange {
	readonly before: SettingsMcpServer | null;
	readonly after: SettingsMcpServer | null;
}

export interface McpView {
	readonly state: McpState;
	readonly reason: ConfigFailureReason | null;
	readonly message: string;
	/** `<agentHome>/mcp.json`, the file this family writes. */
	readonly path: string;
	/** False while the file does not exist yet; an apply creates it. */
	readonly stored: boolean;
	/** Every server on disk, redacted. Empty when the file could not be read; the state says which. */
	readonly servers: readonly SettingsMcpServer[];
	readonly notes: readonly string[];
	/** The confirmation: present for `preview` and `apply`, null for `list`, refused and unavailable. */
	readonly plan: ConfigPlanView | null;
	/** What that plan changes; null when there is no plan. */
	readonly change: McpChange | null;
	/** Where the bytes this apply replaced were kept; null when nothing was written. */
	readonly backup: string | null;
}

/**
 * One of the bounded keys of the agent's `settings.json`, as the sheet edits it.
 *
 * Not a JSON editor: the writable set is exactly what the read view reports — `defaultProvider`,
 * `defaultModel` and `defaultThinkingLevel` — and every value is checked before a plan exists, so an
 * unknown key or a value Pi would not accept is refused with a reason instead of being written.
 *
 * The same two steps as `packages` and `mcp`: `preview` returns a plan and its digest, `apply` sends
 * that digest back. This family and the packages family write the same file, so they share one write
 * foundation: one backup mechanism, one atomic `0600` write, and one place a plan is spent.
 */
export type SettingsKeysState = "ok" | "refused" | "unavailable";

/** What a plan changes: one key as the file has it and as it would have it. */
export interface SettingsKeyChange {
	readonly key: string;
	/** The value on disk, or null when the key is unset. */
	readonly before: string | null;
	readonly after: string;
}

export interface SettingsKeysView {
	readonly state: SettingsKeysState;
	readonly reason: ConfigFailureReason | null;
	readonly message: string;
	/** `<agentHome>/settings.json`, the file this family writes. */
	readonly path: string;
	/** False while the file does not exist yet; an apply creates it. */
	readonly stored: boolean;
	/** The three writable keys as the file holds them now, or as an apply left them. */
	readonly keys: readonly SettingsKeyValue[];
	readonly notes: readonly string[];
	/** The confirmation: present for `preview` and `apply`, null for refused and unavailable. */
	readonly plan: ConfigPlanView | null;
	/** What that plan changes; null when there is no plan. */
	readonly change: SettingsKeyChange | null;
	/** Where the bytes this apply replaced were kept; null when nothing was written. */
	readonly backup: string | null;
}

/** One tool call an assistant turn made, with the result the session file recorded for it. */
export interface HistoryTool {
	/** Pi's call id, so a result that arrived on a later line is attached to the call that made it. */
	readonly id: string;
	readonly name: string;
	/** The arguments the file holds, parsed when they were JSON. */
	readonly input: unknown;
	readonly output: string;
	readonly isError: boolean;
}

/**
 * One turn of a transcript, as a session file records it.
 *
 * A user turn is text only. An assistant turn carries the reasoning behind it and every tool it called,
 * so a reopened thread shows the work that produced its answers, not only the answers.
 */
export type HistoryEntry =
	| {
			readonly id: string;
			readonly role: "user";
			readonly text: string;
			readonly thinking: null;
			readonly model: null;
	  }
	| {
			readonly id: string;
			readonly role: "assistant";
			readonly text: string;
			readonly thinking: string | null;
			readonly model: string | null;
			readonly tools: readonly HistoryTool[];
	  };

/**
 * One page of a session transcript, read newest first.
 *
 * `before` is the cursor for the next older page, and null once nothing older remains; `total` is how
 * many conversation entries the file holds, so a reader can tell where in the transcript it is.
 */
export interface HistoryPage {
	/** Oldest to newest inside the page. */
	readonly entries: readonly HistoryEntry[];
	/** Cursor to continue from, or null when this page reached the start of the conversation. */
	readonly before: number | null;
	readonly total: number;
}

export interface AgentCounts {
	readonly running: number;
	readonly queued: number;
	readonly waiting: number;
	readonly finished: number;
}

/** One step of a run: what the subagent said, or a tool it called with the output it read back. */
export type AgentItem =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "tool"; readonly name: string; readonly output: string };

/** One run as the tab lists it: no iteration, so the list stays small. */
export interface AgentTaskSummary {
	readonly id: string;
	readonly agent: string;
	readonly label: string;
	readonly status: string;
	readonly model: string | null;
	readonly createdAt: number | null;
	readonly startedAt: number | null;
	readonly endedAt: number | null;
}

/** Every run the open thread's agent published, newest first. */
export interface AgentList {
	readonly counts: AgentCounts;
	readonly tasks: readonly AgentTaskSummary[];
}

/** One run with the iteration it produced, in the order it happened. */
export interface AgentDetail {
	readonly id: string;
	readonly agent: string;
	readonly label: string;
	readonly status: string;
	readonly items: readonly AgentItem[];
	/** True when the read hit its caps, so what is shown is not the whole run. */
	readonly truncated: boolean;
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
	/** One page of a session file's transcript; the newest page when `before` is absent. */
	| {
			readonly kind: "history";
			readonly id: string;
			readonly action: "page";
			readonly sessionPath: string;
			readonly before?: number;
			readonly limit?: number;
	  }
	/** A dropped or pasted file, base64 encoded, for the bridge to write into the agent home. */
	| { readonly kind: "upload"; readonly id: string; readonly name: string; readonly dataBase64: string }
	| { readonly kind: "git"; readonly id: string; readonly action: "status" }
	| { readonly kind: "git"; readonly id: string; readonly action: "diff"; readonly path: string }
	| { readonly kind: "fs"; readonly id: string; readonly action: "tree"; readonly path?: string }
	| { readonly kind: "fs"; readonly id: string; readonly action: "read"; readonly path: string }
	/** Native review, always against the bridge's workspace. */
	| { readonly kind: "review"; readonly id: string; readonly action: "status" | "mode" }
	/** The risk a start would freeze; with a base ref, of committed work against that base. `untracked`
	 * relays the provider's own declaration when untracked files would otherwise refuse the assessment. */
	| {
			readonly kind: "review";
			readonly id: string;
			readonly action: "assess";
			readonly baseRef?: string;
			readonly untracked?: readonly string[];
	  }
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
	/** Themes and the rose's own configuration. `name` asks for one theme instead of the selected one. */
	| { readonly kind: "appearance"; readonly id: string; readonly action: "read"; readonly name?: string }
	/** Choose a theme: the one key Pi reads, refused when the name is not in the catalog. */
	| { readonly kind: "appearance"; readonly id: string; readonly action: "theme"; readonly name: string }
	/** The agent's own configuration: homes, packages, skills, MCP servers and the keys the sheet shows. */
	| { readonly kind: "settings"; readonly id: string; readonly action: "read" }
	/** Plan a change to one of the writable keys: the same family, and a different writer behind it. */
	| {
			readonly kind: "settings";
			readonly id: string;
			readonly action: "preview";
			readonly key: string;
			readonly value: string;
	  }
	/** A write only happens with the digest of the plan the preview returned. */
	| {
			readonly kind: "settings";
			readonly id: string;
			readonly action: "apply";
			readonly key: string;
			readonly value: string;
			readonly digest: string;
	  }
	/** The packages list: read it, plan a change to one source, or apply a plan the confirmation showed. */
	| { readonly kind: "packages"; readonly id: string; readonly action: "list" }
	| {
			readonly kind: "packages";
			readonly id: string;
			readonly action: "preview";
			readonly operation: PackagesOperation;
			readonly source: string;
	  }
	/** A write only happens with the digest of the plan the preview returned. */
	| {
			readonly kind: "packages";
			readonly id: string;
			readonly action: "apply";
			readonly operation: PackagesOperation;
			readonly source: string;
			readonly digest: string;
	  }
	/** The MCP servers: read them, plan one add, edit or removal, or apply the confirmed plan. */
	| { readonly kind: "mcp"; readonly id: string; readonly action: "list" }
	| {
			readonly kind: "mcp";
			readonly id: string;
			readonly action: "preview";
			readonly operation: McpOperation;
			readonly name: string;
			readonly server?: McpServerPatch;
	  }
	| {
			readonly kind: "mcp";
			readonly id: string;
			readonly action: "apply";
			readonly operation: McpOperation;
			readonly name: string;
			readonly server?: McpServerPatch;
			readonly digest: string;
	  }
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
	| { readonly kind: "profiles"; readonly id: string; readonly action: "activate"; readonly name: string }
	/**
	 * Subagent activity of the thread whose session file is `sessionPath`. Without one the bridge answers
	 * with the most recently written presence file, which is the best it can do with no thread named.
	 */
	| { readonly kind: "agents"; readonly id: string; readonly action: "list"; readonly sessionPath?: string }
	| {
			readonly kind: "agents";
			readonly id: string;
			readonly action: "detail";
			readonly sessionPath?: string;
			readonly taskId: string;
	  };;

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
	/** Answer to `{kind:"history", action:"page"}`. */
	| { readonly kind: "history"; readonly id: string; readonly data: HistoryPage }
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
	| ({
			readonly kind: "appearance";
			readonly id: string;
	  } & AppearanceResult)
	| ({
			readonly kind: "settings";
			readonly id: string;
	  } & SettingsResult)
	| ({
			readonly kind: "packages";
			readonly id: string;
	  } & PackagesResult)
	| ({
			readonly kind: "mcp";
			readonly id: string;
	  } & McpResult)
	/** Answer to either `agents` action; which one is known from the request id. */
	| { readonly kind: "agents"; readonly id: string; readonly data: AgentList | AgentDetail }
	| { readonly kind: "error"; readonly id?: string; readonly message: string };

/** One memory answer, tagged with the action that asked for it. */
export type MemoryResult =
	| { readonly action: "context"; readonly data: MemoryContextView }
	| { readonly action: "search"; readonly data: MemorySearchView }
	| { readonly action: "projects"; readonly data: MemoryProjectsView };

/** One permissions answer. */
export type PermissionsResult = { readonly action: "status" | "default"; readonly data: PermissionsView };

/** One appearance answer: the theme that is selected now, whether it was read or just chosen. */
export type AppearanceResult = { readonly action: "read" | "theme"; readonly data: AppearanceView };

/**
 * One settings answer, tagged with the action that asked for it.
 *
 * Reading answers the whole view; a write answers the keys view, because it is about a written file and
 * carries a plan, a change and a backup rather than the skills and MCP servers a read reports.
 */
export type SettingsResult =
	| { readonly action: "read"; readonly data: SettingsView }
	| { readonly action: "preview" | "apply"; readonly data: SettingsKeysView };

/** One packages answer, tagged with the action that asked for it. */
export type PackagesResult = { readonly action: "list" | "preview" | "apply"; readonly data: PackagesView };

/** One MCP answer, tagged with the action that asked for it. */
export type McpResult = { readonly action: "list" | "preview" | "apply"; readonly data: McpView };

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
