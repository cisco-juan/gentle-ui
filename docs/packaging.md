# Packaging

How a Gentle Shell release is produced for Linux, macOS and Windows. The short version: Tauri compiles
per operating system, a CI matrix runs that build on each OS, and the Node bridge travels inside the
bundle because users do not have Node or Pi installed.

```
                   apps/desktop/src-tauri/bridge/          (generated, gitignored)
                   ├── node / node.exe                     Node runtime for the target platform
                   ├── app/dist/main.js                    packages/bridge build output
                   ├── app/node_modules/                   bridge production dependencies
                   └── manifest.json                       what was packed, for support
                                    │
                    bundle.resources │ (tauri.conf.json)
                                    ▼
   .AppImage / .deb        .dmg        .msi     →  $RESOURCE/bridge/...
```

## Status

| Piece | State |
| --- | --- |
| Product identity (`productName`, window title, icon set, `bundle.targets`) | done |
| `bundle.resources` carrying the bridge bundle | done, wired to `bridge/**/*` |
| `docs/packaging.md` (this file) | done |
| CI: install, `pnpm -r typecheck`, `pnpm test` on `ubuntu-latest` | done |
| Release: tag `v*` + dispatch, matrix over three OSes, Tauri action | done |
| Rust spawns the bridge and forwards the handshake | **pending.** Specified below; the Rust side is not written yet, so the bundle ships unused |
| `pnpm package:sidecar` (produces `src-tauri/bridge/`) | done: `scripts/package-sidecar.mjs`, wired into `beforeBuildCommand` |
| `bundle.externalBin` | deliberately absent, see [Why no `externalBin`](#why-no-externalbin) |
| Frontend reads the production port/token | **pending**, it is app source (`apps/desktop/src`), see [The handshake](#the-handshake) |

Today a `tauri build` populates `src-tauri/bridge/` (via `beforeBuildCommand`) and packs it into the
bundle, but nothing consumes it: the webview still looks for `ws://127.0.0.1:7787/?token=dev`, i.e. the
development bridge, until the two remaining rows land. A release build therefore needs network access
(the Node runtime download) and a host in the supported platform matrix.

## Identity

`apps/desktop/src-tauri/tauri.conf.json`:

- `productName: "Gentle Shell"` — becomes the app name (`Gentle Shell.app`, `gentle-shell` package name,
  `Gentle Shell.exe`) and the default artefact file names;
- window `title: "Gentle Shell"` — what the title bar of the single window shows;
- `identifier: "dev.gentleshell.desktopui"` — unchanged, so existing user data directories keep working;
- `bundle.targets: "all"` — whatever the host can produce;
- `bundle.icon` — the existing `icons/` set (`icon.icns` for macOS, `icon.ico` for Windows, the PNGs for
  Linux). Regenerate all of them from one source with `pnpm tauri icon path/to/logo.png` rather than
  editing them by hand.

The Cargo package is `gentle-shell-desktop` with lib `gentle_shell_desktop_lib` (`src/main.rs` calls
`gentle_shell_desktop_lib::run()`). Tauri renames the compiled binary to `productName` while bundling,
so the Cargo name never reaches the user.

## Artefacts

| Runner | Bundles | File names |
| --- | --- | --- |
| `ubuntu-latest` | `.AppImage`, `.deb` | `Gentle Shell_0.1.0_amd64.AppImage`, `gentle-shell_0.1.0_amd64.deb` |
| `macos-14` | `.dmg` (arm64) | `Gentle Shell_0.1.0_aarch64.dmg` |
| `windows-latest` | `.msi` | `Gentle Shell_0.1.0_x64_en-US.msi` |

`.deb` names are lowercased and dasherised by the Debian packager; everything else uses `productName`.
Rust is never cross-compiled: each artefact comes from its own runner. Additional architectures are a
matrix entry plus a matching sidecar, never a compiler flag (`--target x86_64-apple-darwin` also needs
the sidecar built for that triple).

## Why the bridge is the hard part

The UI is static files, but the bridge is a Node program: it spawns `pi --mode rpc`, holds the session
index and owns the tool allowlist. It cannot be compiled into the Rust binary, and a user's machine has
no Node. So the bundle must carry a Node runtime and the built bridge, and Rust must start it on
launch. Tauri's name for "an executable shipped inside the bundle" is a **sidecar**.

Two ways to satisfy that, both valid:

1. **Node runtime + bridge package (chosen).** Ship `node` and the built bridge with its production
   dependencies, then `Command::new(node).arg(main_js)`. Predictable, debuggable, no bundler in the
   release path; costs ~110 MB uncompressed, which the installers compress.
2. **Single-file bundle.** Produce one self-contained executable with Node's SEA support
   (`node --experimental-sea-config` plus `postject`) or `@yao-pkg/pkg`, then declare it as an
   `externalBin`. Smaller and simpler to spawn, but the payload includes a native `pi` module tree and
   the SEA step must be repeated per target triple; treat it as a later optimisation.

Everything below assumes option 1.

## The bundle layout

Produced at `apps/desktop/src-tauri/bridge/` (gitignored) and copied into the bundle by
`bundle.resources: ["bridge/**/*"]`, so at runtime it sits in the resource directory as
`$RESOURCE/bridge/`:

```
bridge/
├── node                      # node.exe on Windows, chmod 755 elsewhere
├── app/
│   ├── dist/main.js          # packages/bridge build output, entry point
│   ├── dist/*.js
│   ├── node_modules/         # production dependencies only (ws, the pinned harness)
│   └── package.json
└── manifest.json             # { nodeVersion, platform, arch, bridgeVersion }
```

The directory is tracked by a single `.gitkeep` marker and otherwise gitignored. The marker is not
cosmetic: Tauri's build script fails the compile when a `bundle.resources` glob matches nothing
("glob pattern bridge/**/* path not found or didn't match any files"), so without it a fresh clone
could not run `cargo check` or `tauri dev` at all. `pnpm package:sidecar` preserves the marker when it
replaces the bundle.

`main.js` imports `ws` and the Pi harness, so a bare `dist/main.js` is not enough: the production
dependency tree has to travel with it (`--prod`, no dev dependencies, no test files).

## Producing the bundle: `pnpm package:sidecar`

Implemented in `scripts/package-sidecar.mjs` and exposed as the `package:sidecar` script of
`apps/desktop`, which `tauri.conf.json` runs before every build
(`"beforeBuildCommand": "pnpm package:sidecar && pnpm build"`), so no installer can be produced
without the bridge inside it.

```bash
pnpm --filter @gentle-shell/desktop package:sidecar                # host platform
pnpm --filter @gentle-shell/desktop package:sidecar -- --plan      # resolve only, no network
pnpm --filter @gentle-shell/desktop package:sidecar -- --platform linux-arm64 --plan
NODE_SIDECAR_VERSION=22.23.2 pnpm --filter @gentle-shell/desktop package:sidecar
```

The script works in a `mkdtemp` directory outside the worktree and moves the finished bundle into
`src-tauri/bridge/` only at the end, so a failure never leaves a half bundle that a later build would
trust. Steps:

1. Resolve the host into a supported `(platform, arch)` pair. Anything else is a loud failure listing
   the supported matrix — a wrong-architecture Node runtime produces an app that installs and then
   cannot spawn its bridge:

   | Host | Node distribution | Binary |
   | --- | --- | --- |
   | `linux x64` | `node-v<a.b.c>-linux-x64.tar.gz` | `bin/node` |
   | `linux arm64` | `node-v<a.b.c>-linux-arm64.tar.gz` | `bin/node` |
   | `darwin x64` | `node-v<a.b.c>-darwin-x64.tar.gz` | `bin/node` |
   | `darwin arm64` | `node-v<a.b.c>-darwin-arm64.tar.gz` | `bin/node` |
   | `win32 x64` | `node-v<a.b.c>-win-x64.zip` | `node.exe` |

   The version is pinned in the script (currently the 22.x LTS line) and overridable with
   `NODE_SIDECAR_VERSION` for a controlled bump; it is not inherited from the developer's machine.
2. Download that archive from `https://nodejs.org/dist/v<a.b.c>/`, verify it against `SHASUMS256.txt`
   from the same directory, and extract into a fresh `mkdtemp` directory outside the worktree. Network
   or checksum failure: loud failure, nothing written to `src-tauri/`.
3. Build the bridge: `pnpm --filter @gentle-shell/bridge build`.
4. Lay out the production payload into `bridge/app/`: `pnpm --filter @gentle-shell/bridge deploy --prod`
   (which materialises the workspace package with its production dependencies), retried without
   `--legacy`, or — when neither `deploy` form works on the installed pnpm — a copy of `dist/` plus a
   `package.json` with the `workspace:` dependencies dropped (the bridge imports
   `@gentle-shell/protocol` as types only) and a `pnpm install --prod` inside the staged directory.
   Either way the result must contain `app/dist/main.js` and resolvable `ws` and
   `@earendil-works/pi-coding-agent`; the script asserts all three and fails otherwise.
5. Copy the Node binary to `bridge/node(.exe)`, set the executable bit on POSIX, write
   `manifest.json`, print the produced paths and sizes, and remove the scratch directory.

`--plan` prints the resolved platform, archive URL, checksums URL and target paths without touching the
network — useful on a machine where downloading a runtime is not wanted, and the cheap way to check a
new platform entry. `--platform` overrides detection, which is how an unsupported host is proven to
fail:

```console
$ pnpm --filter @gentle-shell/desktop package:sidecar -- --platform sunos-sparc --plan
package:sidecar: platform "sunos-sparc" is not supported, no bundle was produced.
  supported platforms: linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64
  a bundle can only be produced on (or for) one of these; run this script on a machine or CI
  runner of that platform, or force the target with --platform <id>
$ echo $?
1
```

## Why no `externalBin`

Tauri's `externalBin` mechanism ships one executable per target triple and renames it during bundling,
using the convention `<declared-name>-<rust-target-triple>[.exe]`:

```
apps/desktop/src-tauri/binaries/gentle-bridge-x86_64-unknown-linux-gnu
apps/desktop/src-tauri/binaries/gentle-bridge-aarch64-unknown-linux-gnu
apps/desktop/src-tauri/binaries/gentle-bridge-x86_64-apple-darwin
apps/desktop/src-tauri/binaries/gentle-bridge-aarch64-apple-darwin
apps/desktop/src-tauri/binaries/gentle-bridge-x86_64-pc-windows-msvc.exe
```

declared as

```json
"bundle": { "externalBin": ["binaries/gentle-bridge"] }
```

It is **not** declared, on purpose: nothing in this repository can produce those files yet, and Tauri
fails the build when a declared `externalBin` is missing. A declaration without artefacts breaks every
build on every platform — worse than the documented gap. It becomes the right mechanism when the
single-file bundle (option 2 above) exists; the script must then emit the platform-suffixed names
above, and the runtime lookup moves from `$RESOURCE/bridge/node` to the sidecar helper.

## What the Rust side must spawn

`apps/desktop/src-tauri/src/lib.rs` grows a bridge module. Contract:

- **Disabled in development.** `scripts/dev.mjs` already owns bridge lifecycle on port 7787; a release
  binary must not spawn a second one. Gate on `cfg!(debug_assertions)` (`tauri dev` runs debug).
- **Resolve through the resource directory**, never a relative path: `app.path().resource_dir()` gives
  the platform-specific location of `bridge/` (`Contents/Resources` inside the `.app`, next to the
  executable on Linux and Windows).
- **Spawn** `$RESOURCE/bridge/node(.exe)` with `$RESOURCE/bridge/app/dist/main.js`, port `0` so the OS
  picks a free port. Do **not** pass a token: the bridge generates a random one and prints it.
- **Read one handshake line** from the child's stdout (`{"event":"ready","port":…,"token":…}`) and
  forward it to the webview. Everything after that line is the child's own logging, which belongs in
  the app's log, not in the webview.
- **Own the lifetime**: keep the `Child` in managed state, kill it on `RunEvent::Exit` and on window
  close, so quitting the app never leaves an orphan holding the agent session.

The shape, using only crates already in `Cargo.toml` (`std::process`, `serde`, `serde_json`):

```rust
#[derive(Clone, serde::Serialize)]
struct BridgeReady {
    port: u16,
    token: String,
}

fn spawn_bridge(app: &tauri::AppHandle) -> tauri::Result<std::process::Child> {
    let dir = app.path().resource_dir()?.join("bridge");
    let node = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    let entry = dir.join("app").join("dist").join("main.js");
    let mut child = std::process::Command::new(node)
        .arg(entry)
        .args(["--port", "0"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .spawn()?;
    // then: read the first stdout line with BufReader, parse it with serde_json, emit
    // "bridge://ready" through `Emitter`, and store the child for shutdown.
    let _ = &mut child;
    Ok(child)
}
```

Those calls (`Manager::path`, `Emitter::emit`, background thread or `tauri::async_runtime::spawn`)
belong in the module that implements this, not in this document.

## The handshake

The bridge already prints exactly one line on stdout once it is listening
(`packages/bridge/src/main.ts`):

```json
{"event":"ready","port":47831,"token":"…"}
```

That line is the contract between the two halves, and Rust has two ways to hand it to the UI:

1. **Event (preferred).** Rust emits `bridge://ready` with `{ port, token }`; the frontend listens with
   `@tauri-apps/api/event` and builds `ws://127.0.0.1:<port>/?token=<token>`. `core:default` in
   `capabilities/default.json` already allows `listen`, so no capability change is needed.
2. **Init script.** Rust calls `webview.eval()` (or `WebviewWindowBuilder::initialization_script`)
   with `window.__GENTLE_BRIDGE__ = { port, token }` before the app boots. Works without any event
   plumbing, but couples the frontend to a global instead of a typed event.

Either way the frontend change is small and lives in app source: today `apps/desktop/src/App.tsx` has

```ts
const BRIDGE_URL = import.meta.env.VITE_BRIDGE_URL ?? "ws://127.0.0.1:7787/?token=dev";
```

so production needs a third branch — "no build-time URL, ask the host" — that awaits the event and then
constructs the client. Until that branch exists, a release bundle cannot reach its own bridge; that is
the pending row in [Status](#status), and it is deliberately not part of the packaging change.

## CI

`.github/workflows/ci.yml`, on `ubuntu-latest`, Node 22, pnpm `12.4.1` (matching `packageManager` in the
root `package.json`): `pnpm install --frozen-lockfile`, `pnpm -r typecheck`, `pnpm test` (which is
`pnpm -r test`, so both `apps/desktop` and `packages/bridge`).

Known limitation, documented in the workflow: the bridge suite starts a real `pi --mode rpc` child and
loads the gentle-pi harness, so it fails on a bare runner that has neither. CI does not provision the
harness yet.

## Release

`.github/workflows/release.yml` runs on a `v*` tag and on manual dispatch (with a `tag` input), as a
matrix over `ubuntu-latest` (`.AppImage`, `.deb`), `macos-14` (`.dmg`) and `windows-latest` (`.msi`),
each installing Node 22, pnpm `12.4.1`, stable Rust and the Linux webkit dependencies
(`libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf`), then
`tauri-apps/tauri-action` builds and attaches the artefacts to a **draft** GitHub release.

A maintainer cuts a release with:

```bash
# 1. version bump: tauri.conf.json "version" (and apps/desktop/package.json, packages/*/package.json)
git commit -am "release: v0.1.0"
git push origin feat/desktop-ui

# 2. tag and push — this is what triggers the matrix
git tag v0.1.0
git push origin v0.1.0

# 3. or, without a tag: Actions -> Release -> Run workflow, tag input v0.1.0

# 4. review the draft release, download one artefact per OS and launch it, then publish
```

Rehearsing locally without publishing (this is the command that must stay out of agent runs, it
compiles Rust for minutes):

```bash
pnpm --filter @gentle-shell/desktop package:sidecar     # downloads the Node runtime, builds the bridge
pnpm --filter @gentle-shell/desktop tauri build         # reused: tauri build runs it again itself
```

### Code signing

Unsigned builds work and warn on first launch. Signing needs secrets that do not exist in this
repository yet, named as the Tauri toolchain reads them upstream: `APPLE_CERTIFICATE`,
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`
for macOS signing and notarisation, and `TAURI_SIGNING_PRIVATE_KEY` /
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` for updater and installer signatures. Windows signing needs a
certificate (`bundle.windows.certificateThumbprint` or a signing command in `tauri.conf.json`) before
it needs a secret name.

## Verification checklist

Cheap checks that a packaging change must keep green:

```bash
node -e "JSON.parse(require('node:fs').readFileSync('apps/desktop/src-tauri/tauri.conf.json','utf8'))"
node --check scripts/package-sidecar.mjs
pnpm --filter @gentle-shell/desktop package:sidecar -- --plan      # no network, resolves only
pnpm -r typecheck
pnpm test
```

What only a real build can prove, and therefore stays unproven until CI runs: that the resources are
copied into the bundle, that the sidecar starts under each OS's sandboxing rules, that the `.dmg` and
`.msi` installers work, and that macOS notarisation passes once signing exists.
