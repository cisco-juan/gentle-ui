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
T5  Composer chips: profile, model, effort, permission mode, attachments (no modals). S3
T6  Right inspector tabs: Changes, Files, Tasks, Memory, Agents/jobs. S3 S7
T7  Command palette plus a Mod-based keybinding layer and cheat sheet. S4
T8  File drag and drop, clipboard image paste, copy path (real paths in Tauri, upload fallback in dev). S5
T9  Native review (RDD) panel: candidate, lenses, verdict, acknowledgement. S1
T10 Packaging: node sidecar, per-OS artifacts via CI matrix, dependency bump workflow. S2 S6

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
