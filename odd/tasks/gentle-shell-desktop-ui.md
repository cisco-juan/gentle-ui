# Gentle Shell Desktop UI

A cross-platform desktop frontend for the Gentle Shell / Pi agent harness. The harness is consumed as
pinned npm dependencies (`@earendil-works/pi-coding-agent`, `gentle-pi`), never forked, so upstream
releases flow in as version bumps. The UI is a Tauri v2 shell (system webview) around a Vite frontend,
with a Node bridge that drives the `pi` agent process.

Status: every task is done except T9 phase two and the review-declaration follow-ups (T40). Bridge speaks to `pi --mode rpc` over a
tokenised loopback WebSocket and re-answers extension dialogs; 216 bridge and 163 desktop tests green, and native
assess of `e6eeb76..HEAD` reads medium and under budget, so no review is due. See `docs/architecture.md`.

Note: machine-local paths (screenshots, session files) in this document were redacted with
`<screenshot: ...>` for publication; the words around them are the user's own.

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
`<screenshot: reference layout>` (three zones: sidebar, chat, right
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

S17. Subagents are listed newest first, and a subagent opens a view of its own run.
Quote: "Ordenar los agentes para que los mas reciente arriba y al darle click a un subagente este abra un modal con la iteracion para ver como se ejecuta"

S18. The right inspector belongs to the open thread; it must not keep showing the previous chat's data.
Quote: "Los datos del sidbar de la derecha deben pertenecer al proyecto que esta seleccionado (es decir al chat) cuando cambio entre chats se mantiene el mismo contenido"

S19. Every option of the permission menu must be readable, including the selected one.
Quote: "El componente de seleccion de permisos debe ser mas ancho, no se la opcion seleccionada"

S21. The product is named Gentle UI wherever it names itself.
Quote: "vamos a cambiarla a Gentle UI todo lo relacionado con el nombre"

S22. Starting a chat shows the Gentle Shell rose, the way the terminal does.
Quote: "La rosa de gentle shell, al iniciar un chat como lo hace le TUI"

S23. The sidebar carries the branding.
Quote: "Agregar branding en el sidebar"

S24. Closing the left sidebar shrinks it to a rail of icons instead of removing it.
Quote: "Cuado se cierre el sidebar de la izquiera que no se elimine completamente, que se encoja en una version con iconos"

S25. Themes: the UI follows Gentle Shell's own theme configuration, and choosing a theme there changes this UI too.
Quote: "Tener temas, usar las configuraciones de temas de gentleshell que afecten a nuestra version, cosa que cambie le UI con la seleccion del tema"

S20. A jump-to-end control appears while the reader has scrolled away from the end of the chat.
Quote: "Debemos tener un boton que aparezca solo cuando estemos haciendo scroll en el chat para ir al final"

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
T9  [~] Native review (RDD) panel: candidate, lenses, verdict, acknowledgement. S1
    Phase one done — cd987b1 — mode, authority, frozen budget, target, risk assessment, the consent card and
    start. T39 and T40 then closed the assessment paths (base ref, untracked declaration) end to end.
    Phase two contract, read from the provider itself (`gentle-ai review --help`, contract
    `gentle-ai.review-integration/v1`, protocol 1.5, gentle-ai 4.3.1): the verbs that finish a review are
    `capture-result`, `capture-correction-plan`, `capture-refuter`, `capture-unachievable`, `capture-validation`,
    `acknowledge-approved`, plus the read-only `lens-context`, `inspect-candidate`, `validate`, `reopen-results` and
    `schema`. Running them from this app needs two things it does not have yet: a reviewer step that produces a
    result worth capturing (model runs, with the cost that implies), and a decision about who may trigger an
    acknowledgement. Both are the user's to make, so phase two is being taken in two halves: an observer surface
    first (show the transition and name the verb without pretending to run it), then the capture half. Lens captures, verdicts and acknowledgement are phase two.
T10 [x] Packaging: node sidecar, per-OS artifacts via CI matrix, dependency bump workflow. S2 S6
    The pipeline had never been run; three real runs later it produces artifacts on all three platforms
    (run 42535375693, commit 1527cc8): `<name>-0.1.0-1.x86_64.rpm` 74.5 MB,
    `<name>_0.1.0_amd64.AppImage` 148.5 MB, `<name>_0.1.0_amd64.deb` 74.1 MB,
    `<name>_0.1.0_aarch64.dmg` 65.8 MB, `<name>_aarch64.app.tar.gz` 64.8 MB,
    `<name>_0.1.0_x64_en-US.msi` 66.7 MB and `<name>_0.1.0_x64-setup.exe` 37.7 MB, all in the **draft**
    release `v0.1.0` — nothing is published until a person says so.
    Four defects came out of actually running it: tauri-action's `npm run tauri` ran from the repo root
    where the app's binaries are not on PATH (`vite: not found`); `macos-14` is no longer a supported
    runner label; the sidecar assumed a Windows archive has a `bin/` directory; and pnpm's isolated
    node_modules is a symlink forest Tauri cannot copy (see 1527cc8, with tests and docs in both
    languages). Route: inline plus one writer for the script. Risk: item 5 (delivery) — which is why it
    was proven by running it, not by reading the workflow.
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
T20 [x] UI: Profiles sheet, composer chip, bare `/gentle:profiles` opens the sheet, "use for new threads". S11
    Verified read-only in the running app: the composer chip lists the five real profiles with the active one marked
    `default`, and "Manage profiles…" opens the Profiles sheet with the same five, plus Duplicate / Rename / Delete /
    "Use for new threads", the orchestrator mode switch (organic, full-delegation) and each agent's model, thinking
    and tier. Nothing was written to the user's file during this check.
T21 [x] Docs and log for the profiles work. S11
    `docs/architecture.md` covers the command's argument behaviour (56-57) and the composer chips (106), and L9 holds
    the design: where the file lives, why the bridge reads and writes it with gentle-pi's own library, the backup
    rule, and what the reader drops silently. Risk: none (documentation).

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
T24 [x] Tool calls that touch files render a file-change card with the path and the change; the raw argument dump
    stops being the only view. S13
    `fileChangeOf()` reads a change out of the arguments (`write` whole file, `edit` old/new hunks, `edits` as
    array/single object/JSON string), never throws on hostile input, and returns null for every other tool. The
    card shows basename, directory, `+N −M`, and either the diff or a 40-line preview. 12 tests, RED first.
    Verified in the app: "▾ <path> 131 lines done" expanding to the preview. Route: one writer, then the parent
    reviewed and split the commit. Risk: none (a view over arguments already on screen).
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

T33 [x] Rename the product to Gentle UI: `productName`, bundle identifier, window title, installer and
    artifact names, and the readme's own name. The harness stays Gentle Shell; only what names *this*
    product changes. S21
T34 [x] A chat start shows the Gentle Shell rose the way the TUI does. S22
    The art is copied verbatim from gentle-pi's `extensions/startup-banner.ts` (17 lines, not 18 as the
    explorer first counted — 17 is what the harness holds and what is asserted), with the same palette, fade,
    flash and shimmer, and the three `animations.json` policies. It draws on a chat start only, is
    `aria-hidden`, and reserves its box. One real bug came out of looking at it: `.rose-banner` measured its
    own width (112px), which is below the width rule, so only the wordmark ever drew; it spans the column now.
    Verified in the app: 17 rows, first line ending `⣠⣾⣷⣶⣦⣤⣤⣄⣠⣄⣀`, identical to the terminal.
    Still open, split out as T38: the harness's own `banner.json` and `animations.json` are not read at runtime
    yet — the webview has no file access, so the app draws the documented defaults.
T35 [x] The sidebar carries the product's branding. S23
    `✿ Gentle UI` in the rail header, in both modes, using the terminal's own prompt glyph and existing colour
    tokens; the narrow fallback reads `✿ Gentle UI ✿`. Verified in the app.
T36 [x] Closing the left sidebar shrinks it to an icon rail instead of removing it; the collapse is a mode,
    not a disappearance. S24
    Two modes persisted beside the layout width: full rail, or a 56px icon rail (clamped 48-96) whose buttons
    keep a name through `aria-label` plus a tooltip. The toggle is reachable in both states and dragging the
    divider out expands the rail. The old `railOpen: false` state migrates to collapsed. Verified in the app:
    268 -> 56 -> 268.
T39 [x] The Review panel must not report a provider error as its own state when the real answer is "there is
    nothing uncommitted to assess". S1 S10
    Reproduced from a screenshot of the panel: `review assess failed (exit 1): Error: the review assess
    candidate has no pending changes; already-committed work can be assessed by rerunning
    \`gentle-ai review assess --base-ref <commit>\` naming the base to compare against`, shown in red under
    RISK with `COLLECT empty_candidate_base_ref_required` below it. The panel asks for an assessment of
    pending changes on every open, and after every commit there are none.
    Fix: the bridge forwards an optional `--base-ref` (refusing anything that could be read as another flag),
    the panel recognises this answer as "nothing pending" instead of an error, and offers the committed
    assessment it can actually run — the previous commit as the base — with the same read-only guarantees.
    Landed in two commits (`ae5cf32`, `fc6b6b8`). `isNothingPendingError` has three tests with RED observed by
    removing the module and running them again; the classifier matches the provider's sentence verbatim, which
    is the one this report quoted. Verified live against the running bridge: a base ref is forwarded, and
    `--cwd` as a ref is refused with the panel's own message instead of reaching the provider's argv.
    Seen on screen once the browser came back: the RISK block reads "Nothing is uncommitted, so there are no
    pending changes to assess. The last commit can be assessed against its parent." with the action beside it,
    and no `.inspector-error` anywhere in the panel.
    The action's own result is now proven twice over. Through the real client, in the app, on a clean tree: the
    panel went from "Nothing is uncommitted…" to `tier medium · changed 10 paths · 540 lines · review due no ·
    why under_budget` with an `executable_change` reason, and no error. And at the provider: `assess` with
    `baseRef: "HEAD~1"` answers a real assessment (`kind=base-diff`), where the bare call answers the
    nothing-pending message. Reaching that took fixing the client too — see T40 and L20.

T41 [ ] The Review panel runs a lens: fetch the provider's own lens context, run the reviewer, and submit the
    result. S1
    Contract read from the provider, not guessed: `review lens-context` emits "the finished reviewer lens context
    for one selected lens" and states that "every token is carried verbatim by the collect transition; nothing else
    is accepted, and nothing is left for the caller to assemble". The submission shape is pinned by
    `review schema capture-result-dry-run` (`schema: gentle-ai.review-capture-result-dry-run/v1`,
    `operation: review/capture-result`, `lineage_id`, `lens`, `selected_order`, `subject_hash`,
    `admission_decision`, `validation`). The reviewer's model is the thread's current model unless the user
    changes it here, and every submission is proven with the provider's dry run before it is admitted for real.

T42 [ ] Acknowledgement from the panel, behind an explicit confirmation. S1
    Decision (user, 2026-11-09): "si, ambas" — the lenses run from the UI and the acknowledgement may be given
    from the UI too, with the same explicit-confirmation pattern already used for permissions and for writing
    `settings.json`. `acknowledge-approved` remains the provider's own continuation, replayed verbatim; the panel
    never composes it.

T40 [x] The Review panel must offer the untracked-file declaration. S1 S10
    Found while probing T39: an untracked file anywhere in the clone makes the provider refuse an assessment
    **even with a base ref**, so "assess the last commit" cannot succeed while one exists. The provider names the
    command in its message; the panel should offer it as the action it already does for a clean tree, instead of
    printing the refusal. This is a prerequisite of T39's button working, not a nice-to-have.
    The bridge relays only the provider's own `intended_untracked_selection` binding — `target_identity`,
    `projection`, `base_tree`, `candidate_tree`, `eligible_paths_json`, `expected_untracked_inventory` — and
    derives `--untracked-scope=select --expected-untracked-inventory=… --intended-untracked=…` from it, refusing
    any other token (a non-flag, `--consent`, a foreign `--cwd`, or something that is not an untracked flag). When
    status offers no usable selection the panel says so and offers nothing.
    `BridgeClient.review()` was dropping every field but `action`; it now forwards `baseRef` and the declaration,
    with a test pinning the exact wire JSON for all four shapes.
    Verified live against the real provider on a scratch workspace holding one untracked file: status carried
    `intended_untracked_selection_required` with the digest and paths, and assess with those tokens answered
    `medium · 1 path · 1 line`. 185 desktop and 241 bridge tests green, RED first on every new test.

T38 [x] The rose honours the harness's own `banner.json` and `animations.json` at runtime (shown/hidden, colour,
    policy), which needs one read the webview cannot make by itself. S22
    Deliberately split from T34 so the art landing did not wait on a new wire family. The bridge answers
    `banner.json` and `animations.json` as text and the UI parses them with the rules `rose.ts` already had, so
    there is one parser and not two; on this machine `banner.json` is absent, so the documented defaults apply and
    `animations.json` reports `policy: quality`, which is what the app draws.

T37 [x] Themes come from Gentle Shell's configuration: the UI reads the selected theme and follows it, and a
    change of theme there changes the UI. S25
    The bridge reads the catalog from the three places themes live (Pi's built-ins, gentle-pi's package themes,
    the user's own directory), resolves the selected theme's `colors` against its `vars`, and answers the token
    map; the desktop overrides this app's own CSS variables with it and restores them when nothing resolves.
    Choosing a theme writes only the `theme` key of `settings.json`, atomically, after backing the previous bytes
    up, and refuses any name it did not just read in the catalog.
    Verified in the app: `--bg #060407`, `--surface #100A0F`, `--text #F6EFF3`, `--accent #F43888` — the user's own
    `Gentleman-Sexy`, not the app's old palette — and the Settings sheet lists the six real names with the current
    one marked. 17 tests, RED first.
    Known limit, recorded instead of hidden: Pi's built-in `dark` and `light` are written in `okhsl()`, which CSS
    cannot paint, so their tokens are dropped and the app's defaults stand for those; the harness's own themes are
    hex and apply fully. A conversion on the bridge would fix it and is not part of this pass.

## Log

L1. "Estmos buscando crear un UI para gentle-shell https://github.com/Gentleman-Programming/gentle-shell,
estoy pensando en hacer un fork del proyecto y crear una interface inspirada en este tema que tengo de
herdrapp <screenshot: reference layout>, buscamos que tenga todas las
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
Sibar de la derecha tiene un tamano max y se rompe cuando crece: <screenshot: inspector overflow>

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

T29 [x] Agents tab: newest first, and a click on a subagent opens a modal showing that run's iteration. S17
    The tab no longer renders the `setWidget` line: the bridge reads gentle-pi's own presence files
    (`<agent home>/gentle-agents/presence/`), picks the incarnation whose session hash matches the open session
    file, and projects it — newest first by `startedAt`, items clamped (4000 chars, last 200) with a `truncated`
    flag, never throwing on a broken payload. Two actions, `list` and `detail`, so the list stays small. A row is
    a real button; the modal shows the run's steps (text and tool output), closes on Escape and restores focus.
    15 bridge tests and 9 desktop tests, RED first. Verified in the app with a two-session fixture: rows newest
    first, a click showed text → `read` with output → text, Escape closed it. Route: one writer, then the parent
    verified and committed. Risk: item 3 (a new wire family) — the reader is confined to the presence directory
    and refuses any path outside it.
T30 [x] Inspector data is scoped to the open thread: switching chats must not leave the previous thread's
    changes, files, tasks, memory or agents on screen. S18
    Agents is the only per-thread tab and it is now keyed by `activePath()`: a switch empties the tab, closes the
    modal and drops any answer still in flight for the previous thread (generation counter). Verified in the app:
    switching from one session to the other showed that session's runs, not the previous one's.
    Open follow-up: Changes/Files/Tasks/Memory/Review are workspace-scoped by design and still refetch only when
    their tab is opened — they can look stale after a switch, which is a different bug from this one and is not
    covered here. The user decides whether they should refresh on switch or say they are workspace-wide.
T31 [x] The permission menu is wide enough for the selected mode to be readable. S19
    300px instead of 240px, and the current row now carries a check plus a `current` label: a background tint alone
    was the whole signal. Verified in the app: width 300, row reads "✓ normal CURRENT". Risk: none.
T32 [x] A jump-to-end button appears in the chat only while the reader is away from the end. S20
    One reactive fact (`away`, derived from the same follow-the-stream decision) drives a sticky pill; clicking it
    resumes following. Verified in the app: pill present 7.7k px from the end, and after clicking it the transcript
    sat at the end (0) with the pill gone. Risk: none.

T28 [x] A thread opens showing the oldest row of its first page for a moment before it lands on the newest one:
    the follow effect ran before the skeleton left and the height settled. S16
    Found while verifying T27; measured, not guessed. Fixed by tracking `loading` in the follow effect, so the pin
    runs again once the skeleton is gone and the scroll height is real. Verified in the app: the first frame with
    rows already sits at the end (atEnd 0), where before it showed atEnd 3245 and jumped later. Risk: none.

Observation while closing T20: `profiles.json` holds a profile literally named `NaN`, next to `current`,
`Claude-Grok`, `OnlyGrok` and `grok-opencode`. The UI renders it faithfully, so it is data, not a display bug — most
likely created by an earlier session from a numeric parse. Left untouched: deleting a profile is the user's call.

L23. 2026-11-09. The user authorised both halves of phase two ("si, ambsa" for "sí, ambas"): lenses run from the
UI, and the acknowledgement may be given there behind an explicit confirmation. The reviewer's model is taken to be
the thread's current model — what the user already selected and pays for — and that choice is recorded here as a
default they can change, not as a silent decision. Every capture is proven with the provider's own dry run before
anything is admitted, so building the pipeline costs nothing until someone deliberately runs a real review.

L22. 2026-11-09. T39 and T40 are closed by the same proof, and it is worth writing down what that proof is,
because the earlier claim was wrong. In the running app, on a clean tree, the Review panel showed "Nothing is
uncommitted…"; clicking "assess the last commit" replaced it with `tier medium · changed 10 paths · 540 lines ·
review due no · why under_budget` and a reason line, with no error in the panel and none in the console. At the
bridge, the same call shape returns `candidateKind=base-diff`, and the bare call returns the nothing-pending
message. With an untracked file present, status carries `intended_untracked_selection_required` and the assess
call with the relayed tokens answers a real assessment. That is three paths — panel, wire, provider — agreeing,
which is what the earlier "the bridge forwards it" never established.

L21. 2026-11-09. A commit message lies about its own content and it will stay that way, deliberately. `4294e8b`
is titled "docs(odd): record the silent field drop behind T39 and what it taught" and it also carries 344 lines of
the okhsl theme work, because the parent ran `git add -A` while another writer was mid-edit. The code is green and
correct — the focused appearance suite is 18/18 and the conversion is bit-identical to Pi's — but the history says
"docs" where a feature landed. Rewriting a public branch to fix a message was judged worse than the mismatch, so it
stays and is recorded here. Rule adopted for the rest of this work: stage explicit paths while a worker is editing,
never `-A`.

L20. 2026-11-09. T39 was reported as "the bridge forwards the base ref" and that was only half true, which is
worth recording as a lesson rather than as a detail. The bridge did forward it — proven by a raw WebSocket probe
against the running bridge — but the panel reaches the bridge through `BridgeClient.review()`, and that method sent
`{kind, id, action}` and dropped every other field, so the panel's "assess the last commit" never carried a base. A
probe that bypasses the real client proves the far end and says nothing about the near end.
Found by the worker assigned to T40, which refused to build on a path that could not reach the bridge and asked for
the surface instead of inventing one. `apps/desktop/src/lib/bridge.ts` and its test are now in that task's scope: the
assess overload forwards `baseRef` and the relayed untracked declaration, pinned by a test on the wire payload, and
the same class of silent drop is now covered for `assess`. Lesson for the rest of this work: verify through the
path the UI actually uses, and treat a missing test on that path as a finding, not as an absence.

L19. 2026-11-09. `v0.1.0` is published, as the user authorized before the style work: "Gentle UI 0.1.0",
https://github.com/cisco-juan/gentle-ui/releases/tag/v0.1.0, seven artifacts (`Gentle.UI_0.1.0_amd64.AppImage`
148.5 MB, `_amd64.deb` 74.1 MB, `-0.1.0-1.x86_64.rpm` 74.5 MB, `_0.1.0_aarch64.dmg` 65.7 MB,
`_aarch64.app.tar.gz` 64.8 MB, `_0.1.0_x64_en-US.msi` 66.7 MB, `_0.1.0_x64-setup.exe` 37.7 MB) produced by run
42626178021 on the renamed `develop`.
Two decisions taken here and worth keeping: the seven stale `Gentle.Shell_*` assets the earlier runs left in the
same draft were deleted before publishing — shipping both names would have handed out pre-rename binaries — and
`main` was fast-forwarded to `develop` (13 commits) so the default branch holds exactly what the release ships.
Still open: the bundle identifier, the `okhsl()` built-in themes, T9 phase two, T40, and the settings session's
uncommitted work in the main tree.

L18. 2026-11-08. The user reported the Review panel turning red on its own: "arreglar este bug", with a
screenshot showing the provider's own message about a candidate with no pending changes and the
`empty_candidate_base_ref_required` transition. Queued as T39. The bridge half is written first because it
does not collide with the appearance unit in flight; the protocol, router and panel changes wait for that
worker to release those files rather than two writers editing them at once.

Slice boundary, 2026-11-08: `develop` reached 1314 authored lines over 6 commits since `main` with the rename
and the styles work (`23f90e4`). The next unit — the appearance family for themes and the banner config — starts a
new slice and is not stacked on this one.

L17. 2026-11-08. The user accepted publishing and asked for the product name to become Gentle UI
("vamos a cambiarla a Gentle UI todo lo relacionado con el nombre"), but wants styles first:
"Antes de publicar me gustaria agreagr algunas cosas de estilos. 1. La rosa de gentle shell, al iniciar un chat
como lo hace le TUI 2. Agregar branding en el sidebar 3. Cuado se cierre el sidebar de la izquiera que no se
elimine completamente, que se encoja en una version con iconos" and "Tener temas, usar las configuraciones de
temas de gentleshell que afecten a nuestra version, cosa que cambie le UI con la seleccion del tema".
So the draft `v0.1.0` stays a draft: rename and styles land first, then the release is published.
Evidence gathered before planning: the `gentle-shell` binary is a Node launcher
(`gentle-pi/bin/gentle-shell.mjs`), it enforces a default `theme` field in Pi's settings file
(`DEFAULT_THEME_NAME` in `scripts/install-tui-mode-setting.mjs`), and `animations.json` in the config home
carries `{"schema":"gentle-pi.animations/v1","policy":"quality"}`. The rose itself and the theme token catalog
are being located before anything is drawn: an invented rose would be the wrong brand, and an invented theme
mapping would be a skin that does not match the terminal.

L16. 2026-11-08. Publishing and packaging. The repository is public at github.com/cisco-juan/gentle-ui,
default branch `main`, with `develop` pushed alongside it, MIT license, and README plus docs mirrored in
English and Spanish. Machine-local paths in these notes and one test fixture were redacted before the first
push, and the check for them is part of the delivery: zero `/home/<user>`, zero mail addresses.
The artifact name the pipeline writes is `<productName>` from `tauri.conf.json`, which still says
"Gentle Shell", so the releases are named `Gentle.Shell_...` while the repository is `gentle-ui`. Left as is
for now because renaming the product changes the bundle identifiers and the installer names; the user decides.

L15. 2026-11-08. Integration, as the user asked ("ve pasando todo a develop"): `develop` was created from
`feat/desktop-ui` (the settings-editor work, 8 commits) and `feat/desktop-transcript` was merged into it. Seven
conflicts, all additive — both branches grew `packages/protocol/src/index.ts`, the request router in
`packages/bridge/src/server.ts` and the composer's permission menu. Resolution: every family kept (settings,
packages, mcp, history, agents share one wire file and one router), and the settings branch's wording kept for the
permission row ("default" / "set in a terminal"), which says more than the label this branch had for the same fact.
After the merge: typecheck clean for protocol, bridge and desktop; 163 desktop and 216 bridge tests green — both
suites running together for the first time. Smoke test in the app on `develop`: a thread opened with 72 rows (27
thinking, 35 tools, 1 file card), all six inspector tabs answered, no console or page errors. The main tree
(`feat/desktop-ui`) and the settings session's uncommitted work were not touched.

L14. 2026-11-08. Delivery plan the user announced for when these tasks are done, verbatim: "al finalizar todas
estas tareas vamos a crear el repo en mi perfil, lo llamaremos gentle-ui, tendremos la documentacion completa en
inlges y espanol, haremos referencia a gentle shell y sus herramientas, ademas, tendremos 2 ramas, master/main y
develop, el repo sera publico, y pondremos la medalla de maded with gentle ia".
Not executed, and deliberately not started here. Points to settle at that moment, because they change what gets
published: the owner and exact slug (`gentle-ui`), the license, whether the history is squashed or carries these
work-unit commits, what belongs in the public tree (this repo's `odd/` working notes and any screenshot or session
path that names the user's machine), and the badge wording ("Made with Gentle AI") and where it points. Creating
the repository and pushing are separate human decisions under ordinary policy.

L13. 2026-11-08. Four UI adjustments after using the app, verbatim:
"Ordenar los agentes para que los mas reciente arriba y al darle click a un subagente este abra un modal con la
iteracion para ver como se ejecuta" / "Los datos del sidbar de la derecha deben pertenecer al proyecto que esta
seleccionado (es decir al chat) cuando cambio entre chats se mantiene el mismo contenido" / "El componente de
seleccion de permisos debe ser mas ancho, no se la opcion seleccionada" / "Debemos tener un boton que aparezca solo
cuando estemos haciendo scroll en el chat para ir al final".
Order chosen: T31 and T32 are small and land with the transcript work; T29 and T30 touch the inspector together, so
they are one unit with one writer, and they wait for the worker holding `styles.css` to finish rather than editing
the same file from two places.

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

