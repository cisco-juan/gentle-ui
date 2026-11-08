# Gentle Shell Desktop UI

A cross-platform desktop frontend for the Gentle Shell / Pi agent harness. The harness is consumed as
pinned npm dependencies (`@earendil-works/pi-coding-agent`, `gentle-pi`), never forked, so upstream
releases flow in as version bumps. The UI is a Tauri v2 shell (system webview) around a Vite frontend,
with a Node bridge that drives the `pi` agent process.

Status: T1, T2, T3 and T4 done. Bridge speaks to `pi --mode rpc` over a tokenised loopback WebSocket and
re-answers extension dialogs; 7 tests green against the real binary. See `docs/architecture.md`.

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
T6  [ ] Right inspector tabs: Changes, Files, Tasks, Memory, Agents, Review. S3 S7
    Changes, Files, Tasks, Agents and Review are done; the Memory tab is still open.
T7  [x] Command palette plus a Mod-based keybinding layer and cheat sheet. S4 — ff6b45b
T8  [x] File drag and drop, clipboard image paste, copy path (upload fallback in dev). S5 — 810c1e7
    Real Tauri paths remain unimplemented; the tested path is the upload fallback, which also works
    when the file cannot be reached from the app.
T9  [ ] Native review (RDD) panel: candidate, lenses, verdict, acknowledgement. S1
    Phase one done — cd987b1 — mode, authority, frozen budget, target, risk assessment, the consent card and
    start. Lens captures, verdicts and acknowledgement are phase two.
T10 [ ] Packaging: node sidecar, per-OS artifacts via CI matrix, dependency bump workflow. S2 S6

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
