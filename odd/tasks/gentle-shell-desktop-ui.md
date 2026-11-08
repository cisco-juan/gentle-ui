# Gentle Shell Desktop UI

A cross-platform desktop frontend for the Gentle Shell / Pi agent harness. The harness is consumed as
pinned npm dependencies (`@earendil-works/pi-coding-agent`, `gentle-pi`), never forked, so upstream
releases flow in as version bumps. The UI is a Tauri v2 shell (system webview) around a Vite frontend,
with a Node bridge that drives the `pi` agent process.

Status: T1-T8, T11-T18, T22, T23, T25-T27 done; T9 has phase one; T10, T19-T21, T24 and T28 open. Bridge speaks to
`pi --mode rpc` over a tokenised loopback WebSocket and re-answers extension dialogs; 116 bridge and 125
desktop tests green. See `docs/architecture.md`.

## Specs

S1. The product must expose every feature Gentle Shell already has.
Quote: "buscamos que tenga todas las funcionalidades que tiene gentle shell"

S2. Upstream changes must stay absorbable without maintaining a hard fork.
Quote: "que se pueda actualizar con los cambios a futuro que puedan ir surgiendo"
Decision: consume the harness as semver-pinned dependencies; the UI is a presentation layer only.

S3. Features must be distributed so they are easy to understand, and agent/profile selection belongs in
the chat surface rather than a separate modal.
Quote: "debemos distribuir las funcionalides para que sean facil de entender, por ejemplo en este tema
podemos seleccionar los agentes aqui en el chat, ahi podriamos mejor seleccionar los perfiles, y ver como
distribuimos mejor el UI de todas las funcionalidades."

S4. Keyboard combinations must reach every feature.
Quote: "Tener combinacion de teclas para acceder a funcionalidades"

S5. Files must be copyable and pasteable as part of the development flow.
Quote: "que soporte copiar y pegar archivos y todo es que puedan ayudar bastante en el desarrollo."

S6. Windows, Linux and macOS are all first-class targets.
Quote: "para confirmar, con estas herramientas sigue siendo compatible con windows, linux y mac?"

S7. Visual reference is the layout captured at
`/home/cisco/Pictures/Screenshots/Screenshot_20261108_085213.png` (three zones: sidebar, chat, right
panel). The screenshot is stock Gentle Shell; the redesign is about distribution and skin, not a new app
model.
Note: the user described the reference as "herdrapp"; the image itself is Gentle Shell. Treat the layout,
not the branding, as the reference.

S8. The right inspector must follow its column when it is dragged wider.
Quote: "Sibar de la derecha tiene un tamano max y se rompe cuando crece"

S9. A slash command must not error or freeze the shell.
Quote: "cuando intentamos usar un comando como el /gentle:profile da error o se queda congelado"

S10. Everything built so far is audited, and what the audit finds is fixed.
Quote: "queremos que hagas una verificacion de todo lo creado y crear un plan para mejorar la experiencia y/o arreglar cualquier bug que encuentres."

S11. Profiles must work from the UI, by editing the file Gentle Shell keeps them in if that is the way.
Quote: "creo que la posible solucion seria modificar el archivo o db que usa gentleshell directamente, puedes revisar el repo para validar como funciona, el plan es que todo funcione desde le la UI"
Decision (user, 2026-11-08): "use this profile" makes it the global default and opens a new thread that starts with it;
the open thread is not changed, because binding a session needs Pi's own process.

S12. The transcript must show the work, not only its conclusion: the model's thinking chain and what it ran.
Quote: "la sesion en la Terminal muestra informacion como el codigo, la cadenas de pensamientos, n la UI solo esta
mostrando el texto final"

S13. File modifications need their own components in the transcript.
Quote: "tener componentes que muestren las modificaciones de archivos y cadanas de pensamientos como el UI"

S14. The UI must always say it is still working.
Quote: "debemos tener algun feedback en le UI que nos diga que esta trabajando aun"

S15. A running agent must never block reading the chat.
Quote: "cuando esta working el chat esta bloqueado, no puedo hacer scroll por ejemplo, creo que es por momentos"

S16. Chat history must load lazily as the transcript is scrolled.
Quote: "El chat solo muestra la ultima iteracion, deberia ir haciendo lazyloading del historial del chat con el scroll"

## Tasks

T1  [x] Workspace scaffold: git init, pnpm workspace, `apps/desktop` (Tauri v2 + Solid + Vite), `packages/bridge`. S6 — 64eb88d
T2  [x] Bridge: spawn `pi --mode rpc`, JSONL framing, command allowlist, event fan-out, extension dialogs. S1 — 3f87bac
T3  [x] Session and project model: list, create, switch threads; sidebar navigation. S1 S3 S7 — 67b2f6c
    Search across threads is still pending (tracked with the palette task). The bridge indexes the
    session directory because Pi has no list-sessions command: 75 real sessions listed in ~185 ms.
T4  [x] Chat view: streaming messages, collapsible tool cards, inline permission approvals, composer. S1 S3 — a033bb3
    Verified end to end: a prompt typed in the UI ran bash, rendered the tool card with its result,
    streamed the assistant reply, and committed it with model and cost. Screenshot capture in the
    headless browser returns blank frames (environment), so the proof is the DOM transcript.
T5  [x] Composer chips: model, profile and permission mode pickers (no modals). S3 — 0925460
T6  [x] Right inspector tabs: Changes, Files, Tasks, Memory, Agents, Review. S3 S7 — cc9924b
    The Memory tab is a read-only view over an Engram MCP session; Review landed with T9 phase one.
T7  [x] Command palette plus a Mod-based keybinding layer and cheat sheet. S4 — ff6b45b
T8  [x] File drag and drop, clipboard image paste, copy path (upload fallback in dev). S5 — 810c1e7
    Real Tauri paths remain unimplemented; the tested path is the upload fallback, which also works
    when the file cannot be reached from the app.
T9  [ ] Native review (RDD) panel: candidate, lenses, verdict, acknowledgement. S1
    Phase one done — cd987b1 — mode, authority, frozen budget, target, risk assessment, the consent card and
    start. Lens captures, verdicts and acknowledgement are phase two.
T10 [ ] Packaging: node sidecar, per-OS artifacts via CI matrix, dependency bump workflow. S2 S6
T11 [x] A slash command never leaves the shell on "working": a handled prompt ends the run, Esc always leaves it,
    `prompt` is not timed out in the bridge, `extension_error` is shown, each record is sent once. S9 — 3306652
    Route: inline. Risk item 4. Native assess of this commit alone was not run: the CLI assesses `base..HEAD`,
    so isolating it needs a checkout of the commit (see L8).
T12 [x] The inspector fills the column it is dragged to; the tab strip fades while a tab is clipped; splitters start
    from the rendered width. S8 — 5ce7219. Route: inline. Risk none.
T13 [x] A mistyped slash command is caught with a "did you mean"; the permission chip stops faking a mode. S9 — b487ffc
    Route: inline. Risk none.
T14 [x] Chat state: prompts sent mid-run are queued, tool cards stay open, the draft survives a missing bridge, scroll
    follows only at the bottom, new and switched threads reset the run and forget a stale remembered thread.
    S10 — 17e21c6. Route: inline. Risk none.
T15 [x] A lost bridge connection is visible and Reconnect works; a failed handshake closes its socket; an unsendable
    permission answer keeps the question open. S10 — c8e57a7. Route: inline. Risk item 4.
    Native review granted, two lenses (resilience, reliability), approved and acknowledged
    (lineage review-912987e91c7312fa).
T16 [x] Memory buttons no longer stick; permission cards handle editors, IME, timeouts and labels; Escape, focus and
    slash suggestions work from the keyboard; sidebar search and button fixed. S10 — 7f7342b, 7f89f6f
    Route: inline. Risk none. Native assess over both: medium, under budget, no review due.
T17 [x] Housekeeping: T6 checked, Settings copy no longer promises a palette that shipped, this record. S10 — this commit


T18 [x] A model switch from the chip names the model with the key Pi reads (`modelId`, not `model`); every switch failed
    with "Model not found". S11 — adbcc5f. Route: inline. Risk none.
T19 [ ] Bridge: profiles module over gentle-pi's own library (loaded with jiti), `profiles` protocol messages, backup
    whenever the file is not what the bridge last wrote (in `profiles-backups/`), atomic writes, refusal of values its
    reader would drop, notes for what it drops silently. S11 — 2b5454b and the fix that follows it.
    Route: inline. Risk items 1 and 3 (writes a file another program owns). Gate pending: independent verifier, then
    native review. Checked off when both are done.
T20 [ ] UI: Profiles sheet, composer chip, bare `/gentle:profiles` opens the sheet, "use for new threads". S11
T21 [ ] Docs and log for the profiles work. S11

T22 [x] The permission chip writes the default new threads start in, offers every mode, and says which modes are
    terminal-only. The fake thread mode (`chat.permissionMode()`, hard-coded `normal`) is gone with its no-op
    stub, and the palette reports the default the bridge read. S11 — this commit
    Route: inline. Risk items 2 and 3 (writes a preference another program owns; changes a shared contract).
    Only lowering is offered; the elevated modes show the terminal line instead of a broken click. Verified in
    the browser against the running bridge: chip reads `normal`, four rows, `normal` marked current, `yolo`
    refused with its command, `auto` written and marked current after the new thread. 125 desktop tests green.

T23 [x] Transcript shows the model's thinking chain, collapsed by default, and a reopened thread keeps it. S12
    `streamIntent()` decides text vs thinking vs nothing from the stream; `thinking_delta` lands in one item per
    block, `thinking_end` closes it, and `thinkingOf()` replays the block for a reopened thread. RED first
    (missing export), 13/13 lib tests green. Verified in the running app: a real turn rendered
    "thinking · <peek> · 230 chars" above its answer. Route: inline plus one writer for the component and
    styles. Risk none.
T24 [ ] Tool calls that touch files render a file-change card with the path and the change; the raw argument dump
    stops being the only view. S13
T25 [x] A run is visibly in progress at every moment (thinking, tool running, streaming), not only while the draft
    is empty. S14
    `activityOf()` names what is happening ("thinking", "running bash", "writing the answer", "waiting for your
    approval"), and the transcript line is no longer gated on an empty draft. RED first, 4 tests. Route and risk:
    same commit as T23.
T26 [x] The transcript stays scrollable while a run is in flight: nothing transparent covers it, and
    follow-the-stream never fights the reader. S15
    Two causes, both fixed: `.menu-backdrop` was `position: fixed; inset: 0` over the whole app, so any open
    composer menu swallowed the wheel; it is gone, replaced by a capture-phase `pointerdown` listener that closes
    the menu without covering anything. And `followAfterWheel()` settles "stop following" on the wheel gesture
    itself, so a token arriving before the scroll event can no longer pin the reader back to the end. RED first,
    2 tests. Verified in the browser: with a menu open, `elementFromPoint` over the chat is the chat and no
    backdrop exists — the scroll itself could not be measured because that thread fits its pane (see T27).
T27 [x] Chat history loads progressively with the scroll instead of arriving whole or stopping at the last
    iteration. S16
    History is now read from the session JSONL, not from Pi's `get_messages` tail: `pageHistory()` pages backwards
    with an entry cursor, folds each `toolResult` into the assistant turn that called it, and keeps the thinking
    blocks. The bridge refuses any path outside the session roots it lists; `get_messages` stays as the fallback
    and tells the UI there is nothing older. 12 bridge tests and 5 desktop tests, RED first. Verified in the
    running app on the 1430-line thread: 3 rows before, 72 rows (3 users, 27 thinking blocks, 35 tools) after
    opening, and scrolling up brought the next 40 entries to 152 rows while the reader stayed put.
    Risk: item 3 (a new protocol family) — one reader, no unreadable path outside the session root.

## Log

L1. "Estmos buscando crear un UI para gentle-shell https://github.com/Gentleman-Programming/gentle-shell,
estoy pensando en hacer un fork del proyecto y crear una interface inspirada en este tema que tengo de
herdrapp /home/cisco/Pictures/Screenshots/Screenshot_20261108_085213.png, buscamos que tenga todas las
funcionalidades que tiene gentle shell, que se pueda actualizar con los cambios a futuro que puedan ir
surgiendo. debemos distribuir las funcionalides para que sean facil de entender, por ejemplo en este tema
podemos seleccionar los agentes aqui en el chat, ahi podriamos mejor seleccionar los perfiles, y ver como
distribuimos mejor el UI de todas las funcionalidades. Tener combinacion de teclas para acceder a
funcionalidades, que soporte copiar y pegar archivos y todo es que puedan ayudar bastante en el desarrollo.
continua"

L2. "1. si 2.si." — approves installing the Rust toolchain and consuming the harness as a dependency
instead of forking it.

L3. "para confirmar, con estas herramientas sigue siendo compatible con windows, linux y mac?" — raises S6.
Environment verified: webkit2gtk-4.1 2.54.2, gtk+-3.0 3.24.52, libsoup3, librsvg, openssl, base-devel all
present on the Linux host; rustup installing in the background.

L4. Verification of T4 (chat) and T3 (sessions), observed through the DOM because headless screenshot
capture on this machine returns uniform frames even for a trivial HTTP page — an environment defect,
not an app defect (elementFromPoint, computed colours and layout rects are all correct).
- T4: a prompt typed in the UI ran `bash cat package.json`, rendered the tool card with `done · 7ms`,
  streamed the reply, and committed it with model and cost.
- T3: 75 real sessions listed in the rail grouped by project with title and relative time; clicking a
  row switched the thread, replayed 4 history bubbles, marked the row active, with no console errors.
- Bridge-level probe: `switch_session` answered `ok` in 77 ms and `get_messages` returned 243 messages
  in 37 ms on the largest project session.
Known gap from this slice: the thread the app opens on connect is a fresh session, so no rail row is
active until the first prompt creates its file.

L5. Ten UI defects reported from real use, with screenshots: (1) the `/` list hides the `gentle:*` commands,
(2) the rail scrolls its own header away, (3) rail rows look bare next to the reference, (4) the footer
moves with the scroll and hides, (5) the composer chips look clickable but are not, (6) the rail needs to
match the rest of the shell, (7) settings should live at the bottom of the rail, (8) card borders and
accent bars read as generated filler, (9) scrolling the chat scrolls the page and drags the input, and
(10) answers arrive as raw markdown.

Resolved in 0925460: (2)(4)(6)(7)(8)(9) layout and visual pass, (5) chips drive set_model and the agent's
own commands, (10) markdown rendered from JSX nodes. Verified through the DOM: the document does not
scroll, the chat scrolls without moving the composer, the rail scrolls without moving its footer, the
model popover lists 50 models, and `**bold**`/`` `code` ``/fenced code all render as elements.
(1) closed in 9c50919 and 47e1a51: a bare `pi --mode rpc` never loads gentle-pi — the launcher injects
it with `-e` and pins the environment. The bridge now resolves the package root, realpaths it (the pnpm
symlink breaks the extension's own imports) and checks that its dependencies resolve, which rejects the
npm copy that has no dependency tree. Result: 86 commands, 36 `gentle:*`, `/gentle:profiles` reachable
from the composer chip, and a bare `/` opens on the shell's own commands first. (3) remains: second
design pass on the rail rows.

L6. Inspector and palette landed together and were verified in the browser, not just by typecheck.
- Changes: branch `feat/desktop-ui`, 12 changed files with status glyphs and `+n −n`; opening one renders a
  48-line unified diff classified into meta/hunk/context/add/remove.
- Tasks: parses `odd/tasks/*.md` and counts checked tasks; the doc now carries a checkbox per task so the
  count means something.
- Files: tree with directories first; Agents: honest empty state until the agent publishes activity.
- Palette: Mod+K opens 220 items in four groups, filtering finds `/gentle:guide`, Escape closes; rail folds
  with Mod+B; Mod+P narrows to threads; Mod+Enter sends from the focused textarea.
Security note: the workspace reader resolves every path twice — lexically and through `realpath`, including
the parent directory — and has tests for `..`, absolute paths, a symlinked directory, and a symlink that
stays inside the root.

L7. Editable layout and the first real visual pass. Commits 8735972 (screenshot loop) and 9022ffd.
Panels are drag-resizable, toggleable from the status line and the palette, and the arrangement persists per
install; verified by dragging the inspector to 480px and reloading, after which the grid still reported it.
Three defects were only visible in a capture, not in the DOM: module-scope Solid JSX made every shared icon
render an empty svg, the new splitters shifted the grid so the transcript sat in a 6px column, and the chevrons
pointed the wrong way. Informational agent notices now fade in the status line instead of stacking in the
transcript.

L8. 2026-11-08. The user asked for an audit and a plan, then approved it. Request, verbatim:
"Estamos trabajando en una UI para gentle shell,  queremos que hagas una verificacion de todo lo creado y crear un
plan para mejorar la experiencia y/o arreglar cualquier bug que encuentres.

Puntos que yo he encontrado:
Sibar de la derecha tiene un tamano max y se rompe cuando crece: file:///home/cisco/Pictures/Screenshots/Screenshot_20261108_125005.png

cuando intentamos usar un comando como el /gentle:profile da error o se queda congelado"
Baseline before any change: typecheck clean, 43 desktop and 83 bridge tests green; the bugs were runtime and UX
bugs the tests did not cover.

Root causes, each reproduced or read in the code before the fix:
- Inspector: `inspector.css` gave the panel `width: 360px`; a grid item with a fixed width does not stretch into its
  track, so dragging widened the track and left the panel at 360px. The left rail sets no width and resized fine.
- `/gentle:profile` is not a command; `/gentle:profiles` is. The freeze was real for every extension command: Pi
  answers `prompt` with `disposition: "handled"` and emits neither `agent_start` nor `agent_settled`, the UI
  set `running` on send and only cleared it on `agent_settled`, and Esc never reset it. A command that waits on a
  dialog also hit the bridge's 30 s timeout, because Pi holds the `prompt` answer until the person replies.
- Bare `/gentle:profiles` needs `ctx.ui.custom`, which returns `undefined` over RPC, so the shell correctly
  redirects to the model chip.

Decisions and evidence worth keeping:
- Thread changes do not clear `setStatus` entries: they belong to the Pi process, not the session, and are not
  re-emitted on a switch.
- The profile chip stays on "default": the extension publishes no active-profile status over RPC (the only
  `setStatus` key it uses is `gentle:auto-usage`). Showing it needs gentle-pi to expose it, or a native panel.
- The permission chip no longer changes its label: `gentle:mode` and `gentle:yolo` refuse changes outside a terminal.
- A refresh and a search in the Memory panel now have separate generation counters; the old shared one left the
  overtaken read's busy flag set. Reproduced with a failing test first.
- Test-first held where a runnable test applies: RED was observed for the bridge timeout and record duplication, the
  new helpers, the `BridgeClient` close handling and the memory race. Keyboard, focus and layout changes have no
  tests, only typecheck and build.

Open:
- A native review of T11 alone, because it removes a timeout (item 4). It needs a checkout of 3306652 to be assessed
  in isolation. Not done; the user decides.
- Nothing here was exercised against a live Pi in the running app. Manual pass still owed: drag the inspector to 620,
  run `/gentle:doctor`, a command that opens a dialog, kill the bridge and Reconnect, expand a running tool card.
- A native Profiles panel (needs its own spec), exposing the active profile and permission mode over RPC, T9 phase two
  and T10.

L9. 2026-11-08. After the audit the user ran the app and showed the "/gentle:profiles only works in a terminal" notice,
and asked for profiles to work from the UI. Request, verbatim:
"tenemos este error, creo que la posible solucion seria modificar el archivo o db que usa gentleshell directamente,
puedes revisar el repo para validar como funciona, el plan es que todo funcione desde le la UI"

What was found (read from the installed gentle-pi 4.7.0 and Pi 1.5.0, not assumed):
- Profiles live in `<config home>/profiles.json` (`~/.gentle-shell/gentle-ai/` here): `{kind, version, active, profiles,
  workflow}`, each profile a map agent -> `{model, thinking, tier}`, `orchestrator` being the main model. Plain JSON, no
  hashes, no lock. gentle-pi's `lib/agent-profiles.ts` has the whole CRUD plus an atomic write, and its reader drops what
  it does not recognise without saying so.
- Node will not strip types under `node_modules`, but Pi ships `jiti` 2.7.0; it resolves from the Pi directory that sits
  next to gentle-pi (Pi's `exports` hides its package.json and has no CJS main, so resolving through those fails).
- A running thread freezes its profile at start; the terminal's "Use" binds a session by appending a custom entry from
  inside the Pi process, cross-checked against memory. Nothing outside the process can do that, and writing the session
  file by hand would break it. Hence the user's choice above. A repository pin overrides `active` for subagents (never for
  the orchestrator), so activation reports it.
- Pi has no RPC to reload settings or extensions; a file edit reaches a thread only through a new one.
- The bridge module refuses values gentle-pi's reader would silently drop (a model id with a space, an unknown thinking
  level or tier, an orchestrator model that is not provider/model) and refuses to write over a file it does not accept.
  What the reader drops is reported as notes, because the next save removes it: invalid profile and agent names, a stale
  default, a bad mode, and (found by the independent verifier) unknown top-level keys and unknown fields inside a route,
  which gentle-pi's own reader discards without a word. Verified read-only against the real file: 5 profiles of 13
  routes each, active `grok-opencode`, 40 ms, file untouched.
- Backups go to `<config home>/profiles-backups/`, not `backups/`: gentle-ai keeps timestamped snapshot directories
  (manifest.json + snapshot.tar.gz) there and a loose file could confuse it. A backup is made whenever the file is not
  exactly what the bridge last wrote, so an edit by the terminal in between is kept too.
- Independent verifier (T19): 10 probes against a copy of the real file, no blockers, real files untouched. Advisories
  fixed: backup folder, backups of outside edits, `__proto__`/`constructor`/`prototype` agent names refused, unknown
  `action` answered with an error, silent drops named. Left as is: a save of an unchanged profile reorders its agent
  keys (orchestrator first, then alphabetical); the data is equal.

Open: per-thread binding needs a gentle-pi verb (for example `/gentle:profiles use <name>`); fallbacks and pin editing are
not part of this pass; the terminal and the bridge can both write the file and the last writer wins.

L10. 2026-11-08. Continuing the interrupted session, the permission mode came next: the bridge and the client were
committed (`2db84a9`, `d9911ad`) but the composer chip still called a no-op stub, so choosing a mode did nothing.
What was built and why:
- The chip now shows the default new threads start in, read from `permissions status`, and never the open thread's
  mode: Pi publishes no mode over RPC, so any other label would be a guess. The popover says the open thread keeps
  the mode it started with.
- Four rows for the four modes. `normal`/`auto` write the default and open a thread that starts in it; `yolo` and
  `super-yolo` carry their terminal line and are refused by the panel and again by the bridge.
- `permissionRows()` decides the rows from the bridge's answer, with the local rule standing in before it arrives.
  RED first: `SyntaxError: does not provide an export named 'permissionRows'`, then 8/8 green.
- `chat.permissionMode` and `chat.setPermissionMode` were deleted rather than left as dead code: the accessor
  hard-coded `normal` and the stub's only effect was a notice claiming nothing had happened. The palette fact now
  reports the default the bridge read.
- Wrong turn, recorded because it cost real state: the "isolated" verification bridge was pointed at a temporary
  config home, but the page under test kept talking to the already-running dev bridge on 7787, so clicking `auto`
  wrote `~/.gentle-shell/gentle-ai/permission-mode.json` for real. Reverted to `normal` through the app's own chip,
  which is the human-controlled path; the file now exists with the built-in default where it may not have existed
  before, so behaviour is unchanged. `VITE_BRIDGE_URL` did not override the endpoint in a plain browser run — that
  needs its own look before the next verification relies on it.

T28 [ ] A thread opens showing the oldest row of its first page for a moment before it lands on the newest one:
    the follow effect runs before the skeleton leaves and the height settles. Visible in the app (empty → top →
    bottom within a few seconds); must not be a jump the reader can catch. S16
    Found while verifying T27; measured, not guessed.

L12. 2026-11-08. While verifying T26, opening the user's long thread ("Estmos buscando crear un UI para gen",
hundreds of turns on disk) rendered three rows and no scroll: `loadHistory` asks Pi for `get_messages` and shows
what comes back, and what comes back is the tail. That is the user's "el chat solo muestra la ultima iteracion",
now reproduced. T27 needs paging from the session file the bridge already indexes for the rail, not a larger
`get_messages` request.

L11. 2026-11-08. The user ran the app against real work and asked for four things, verbatim:
"la sesion en la Terminal muestra informacion como el codigo, la cadenas de pensamientos, n la UI solo esta mostrando
el texto final" / "debemos tener algun feedback en le UI que nos diga que esta trabajando aun, y tener componentes que
muestren las modificaciones de archivos y cadanas de pensamientos como el UI" / "cuando esta working el chat esta
bloqueado, no puedo hacer scroll por ejemplo, creo que es por momentos" / "El chat solo muestra la ultima iteracion,
debria ir haciendo lazyloading del historial del chat con el scroll".
Evidence read before planning (not assumed):
- `chat.ts` handles `message_update` only for `text_delta`; Pi's wire does send `thinking_start/thinking_delta/thinking_end`
  (Pi `docs/json.md`), so the thinking chain is dropped by the client, not missing upstream.
- No Pi event reports a file edit or a diff; a change is visible only inside a tool's `args`/`result`.
  `ToolCard.summary()` shows one string per call (`command`, `path`, `file_path`, `pattern`, `query`) and nothing else
  until expanded, so a file change is currently invisible.
- The in-transcript "working" pulse exists but only while the draft is empty, so it disappears as soon as text streams.
- `.menu-backdrop` is `position: fixed; inset: 0` over the whole app: a composer menu left open covers the chat and
  swallows wheel events. Candidate cause of the blocked scroll, to be reproduced before it is fixed.
- `loadHistory` replays user and assistant text only, deliberately dropping tool and system traffic, so a reopened
  thread loses the work that produced those answers.

