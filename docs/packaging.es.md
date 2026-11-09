# Empaquetado

Cómo se produce una release de Gentle UI para Linux, macOS y Windows. La versión corta: Tauri compila
por sistema operativo, una matriz de CI corre ese build en cada OS, y el bridge de Node viaja dentro del
bundle porque los usuarios no tienen Node ni Pi instalados.

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

## Estado

| Pieza | Estado |
| --- | --- |
| Identidad del producto (`productName`, título de la ventana, set de iconos, `bundle.targets`) | hecho |
| `bundle.resources` que lleva el bundle del bridge | hecho, cableado a `bridge/**/*` |
| `docs/packaging.es.md` (este archivo) | hecho |
| CI: install, `pnpm -r typecheck`, `pnpm test` en `ubuntu-latest` | hecho |
| Release: tag `v*` + dispatch, matriz sobre tres OS, acción de Tauri | hecho |
| Rust lanza el bridge y responde su handshake | hecho: `src-tauri/src/bridge_process.rs`, ver [Lo que arranca el lado Rust](#lo-que-arranca-el-lado-rust) |
| `pnpm package:sidecar` (produce `src-tauri/bridge/`) | hecho: `scripts/package-sidecar.mjs`, cableado en `beforeBuildCommand` |
| `bundle.externalBin` | ausente a propósito, ver [Por qué no hay `externalBin`](#por-qué-no-hay-externalbin) |
| El frontend lee el puerto y el token de producción | hecho: `apps/desktop/src/lib/bridge-endpoint.ts`, ver [El handshake](#el-handshake) |

Un `tauri build` puebla `src-tauri/bridge/` (vía `beforeBuildCommand`), lo empaqueta en el bundle, y la app
empaquetada ya lo consume: Rust arranca el Node incluido, lee el puerto y el token que imprime el bridge,
y el webview los pide antes de su primera conexión. Lo que eso todavía no puede probar en una máquina de
desarrollo está listado en [Lo que sigue sin probarse](#lo-que-sigue-sin-probarse).

## Identidad

`apps/desktop/src-tauri/tauri.conf.json`:

- `productName: "Gentle UI"` — pasa a ser el nombre de la app (`Gentle UI.app`, `Gentle UI.exe`) y los
  nombres de archivo por defecto de los artefactos; el identificador del bundle queda intacto a propósito, así
  una instalación existente conserva sus datos;
- `title` de la ventana: `"Gentle UI"` — lo que muestra la barra de título de la única ventana;
- `identifier: "dev.gentleshell.desktopui"` — sin cambios, para que los directorios de datos de usuario
  existentes sigan funcionando;
- `bundle.targets: "all"` — lo que el host pueda producir;
- `bundle.icon` — el set existente de `icons/` (`icon.icns` para macOS, `icon.ico` para Windows, los PNG
  para Linux). Regenerarlos todos desde un solo origen con `pnpm tauri icon path/to/logo.png` en lugar de
  editarlos a mano.

El paquete de Cargo es `gentle-shell-desktop` con lib `gentle_shell_desktop_lib` (`src/main.rs` llama a
`gentle_shell_desktop_lib::run()`). Tauri renombra el binario compilado a `productName` al empaquetar, así
que el nombre de Cargo nunca llega al usuario.

## Artefactos

| Runner | Bundles | Nombres de archivo |
| --- | --- | --- |
| `ubuntu-latest` | `.AppImage`, `.deb` | `Gentle UI_0.1.0_amd64.AppImage`, `gentle-ui_0.1.0_amd64.deb` |
| `macos-latest` | `.dmg` (arm64) | `Gentle UI_0.1.0_aarch64.dmg` |
| `windows-latest` | `.msi` | `Gentle UI_0.1.0_x64_en-US.msi` |

Los nombres de `.deb` los pasa a minúsculas y guiones el empaquetador de Debian; todo lo demás usa
`productName`. Rust nunca se compila de forma cruzada: cada artefacto sale de su propio runner.
Arquitecturas adicionales son una entrada de la matriz más un sidecar acorde, nunca un flag del compilador
(`--target x86_64-apple-darwin` también necesita el sidecar compilado para ese triple).

## Por qué el bridge es la parte difícil

La UI son archivos estáticos, pero el bridge es un programa Node: lanza `pi --mode rpc`, mantiene el
índice de sesiones y es dueño de la allowlist de herramientas. No se puede compilar dentro del binario de
Rust, y la máquina de un usuario no tiene Node. Así que el bundle tiene que llevar un runtime de Node y el
bridge compilado, y Rust tiene que arrancarlo al iniciar. El nombre que Tauri le da a "un ejecutable que
viaja dentro del bundle" es **sidecar**.

Hay dos maneras de cumplirlo, ambas válidas:

1. **Runtime de Node + paquete del bridge (elegida).** Enviar `node` y el bridge compilado con sus
   dependencias de producción, y después `Command::new(node).arg(main_js)`. Predecible, depurable, sin
   bundler en la ruta de release; cuesta ~110 MB sin comprimir, que los instaladores comprimen.
2. **Bundle de un solo archivo.** Producir un ejecutable autocontenido con el soporte SEA de Node
   (`node --experimental-sea-config` más `postject`) o `@yao-pkg/pkg`, y declararlo como `externalBin`.
   Más chico y más simple de lanzar, pero el payload incluye un árbol de módulos nativos de `pi` y el paso
   de SEA hay que repetirlo por cada target triple; tratarlo como una optimización posterior.

Todo lo que sigue asume la opción 1.

## El layout del bundle

Se produce en `apps/desktop/src-tauri/bridge/` (gitignored) y se copia al bundle con
`bundle.resources: ["bridge/**/*"]`, así que en runtime queda en el directorio de recursos como
`$RESOURCE/bridge/`:

```
bridge/
├── node                      # node.exe on Windows, chmod 755 elsewhere
├── app/
│   ├── dist/main.js          # packages/bridge build output, entry point
│   ├── dist/*.js
│   ├── node_modules/         # production dependencies only (ws, the pinned harness)
│   └── package.json
└── manifest.json             # { nodeVersion, platform, arch, bridgeVersion, linkFree, files }
```

El directorio está trackeado por un único marcador `.gitkeep` y por lo demás gitignored. El marcador no es
cosmético: el build de Tauri falla la compilación cuando un glob de `bundle.resources` no matchea nada
("glob pattern bridge/**/* path not found or didn't match any files"), así que sin él un clone limpio no
podría correr `cargo check` ni `tauri dev`. `pnpm package:sidecar` preserva el marcador cuando reemplaza el
bundle.

`main.js` importa `ws` y el harness de Pi, así que un `dist/main.js` pelado no alcanza: el árbol de
dependencias de producción tiene que viajar con él (`--prod`, sin dependencias de desarrollo, sin archivos
de test).

## Producir el bundle: `pnpm package:sidecar`

Implementado en `scripts/package-sidecar.mjs` y expuesto como el script `package:sidecar` de
`apps/desktop`, que `tauri.conf.json` corre antes de cada build
(`"beforeBuildCommand": "pnpm package:sidecar && pnpm build"`), así que ningún instalador puede producirse
sin el bridge adentro.

```bash
pnpm --filter @gentle-shell/desktop package:sidecar                # host platform
pnpm --filter @gentle-shell/desktop package:sidecar -- --plan      # resolve only, no network
pnpm --filter @gentle-shell/desktop package:sidecar -- --platform linux-arm64 --plan
NODE_SIDECAR_VERSION=22.23.2 pnpm --filter @gentle-shell/desktop package:sidecar
```

El script trabaja en un directorio `mkdtemp` fuera del worktree y mueve el bundle terminado a
`src-tauri/bridge/` solo al final, así que un fallo nunca deja medio bundle que un build posterior daría
por bueno. Pasos:

1. Resolver el host en un par `(platform, arch)` soportado. Cualquier otra cosa es un fallo ruidoso que
   lista la matriz soportada — un runtime de Node de arquitectura equivocada produce una app que se
   instala y después no puede lanzar su bridge:

   | Host | Distribución de Node | Binario |
   | --- | --- | --- |
   | `linux x64` | `node-v<a.b.c>-linux-x64.tar.gz` | `bin/node` |
   | `linux arm64` | `node-v<a.b.c>-linux-arm64.tar.gz` | `bin/node` |
   | `darwin x64` | `node-v<a.b.c>-darwin-x64.tar.gz` | `bin/node` |
   | `darwin arm64` | `node-v<a.b.c>-darwin-arm64.tar.gz` | `bin/node` |
   | `win32 x64` | `node-v<a.b.c>-win-x64.zip` | `node.exe` |

   La versión está pinneada en el script (actualmente la línea 22.x LTS) y se overridea con
   `NODE_SIDECAR_VERSION` para un bump controlado; no se hereda de la máquina del desarrollador.
2. Descargar ese archivo desde `https://nodejs.org/dist/v<a.b.c>/`, verificarlo contra `SHASUMS256.txt`
   del mismo directorio, y extraerlo en un directorio `mkdtemp` nuevo fuera del worktree. Fallo de red o de
   checksum: fallo ruidoso, nada se escribe en `src-tauri/`.
3. Compilar el bridge: `pnpm --filter @gentle-shell/bridge build`.
4. Armar el payload de producción en `bridge/app/`: `pnpm --filter @gentle-shell/bridge deploy --prod`
   materializa el paquete del workspace con sus dependencias de producción, y después el destino
   deployado se reinstala en su lugar con `--node-linker=hoisted`. La segunda instalación no es cosmética:
   el layout aislado que pnpm usa por defecto es un bosque de symlinks, y Tauri copia `bridge/` como árbol
   de recursos sin seguirlos — un build de release falló con
   `resource path '.../node_modules/.pnpm/.../json-schema-to-ts' doesn't exist` antes de esto. Por eso el
   bundle queda hoisteado, y el script recorre tanto el payload como el bundle staged y falla nombrando el
   primer symlink que sobreviva. Cuando `deploy` no funciona en el pnpm instalado, una copia de `dist/`
   más un `package.json` con las dependencias `workspace:` eliminadas (el bridge importa
   `@gentle-shell/protocol` solo como tipos) y un `pnpm install --prod` hoisteado en el directorio staged
   hacen lo mismo.
   En cualquier caso el resultado tiene que contener `app/dist/main.js`, `ws` y
   `@earendil-works/pi-coding-agent` resolubles, y ningún symlink; el script verifica eso y falla si no.
5. Copiar el binario de Node a `bridge/node(.exe)`, poner el bit de ejecución en POSIX, escribir
   `manifest.json`, imprimir las rutas y tamaños producidos, y borrar el directorio scratch.

`--plan` imprime la plataforma resuelta, la URL del archivo, la URL de los checksums y las rutas destino
sin tocar la red — útil en una máquina donde no se quiere descargar un runtime, y la manera barata de
probar una entrada nueva de plataforma. `--platform` overridea la detección, que es cómo se prueba que un
host no soportado falla:

```console
$ pnpm --filter @gentle-shell/desktop package:sidecar -- --platform sunos-sparc --plan
package:sidecar: platform "sunos-sparc" is not supported, no bundle was produced.
  supported platforms: linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64
  a bundle can only be produced on (or for) one of these; run this script on a machine or CI
  runner of that platform, or force the target with --platform <id>
$ echo $?
1
```

## Por qué no hay `externalBin`

El mecanismo `externalBin` de Tauri envía un ejecutable por target triple y lo renombra al empaquetar,
usando la convención `<declared-name>-<rust-target-triple>[.exe]`:

```
apps/desktop/src-tauri/binaries/gentle-bridge-x86_64-unknown-linux-gnu
apps/desktop/src-tauri/binaries/gentle-bridge-aarch64-unknown-linux-gnu
apps/desktop/src-tauri/binaries/gentle-bridge-x86_64-apple-darwin
apps/desktop/src-tauri/binaries/gentle-bridge-aarch64-apple-darwin
apps/desktop/src-tauri/binaries/gentle-bridge-x86_64-pc-windows-msvc.exe
```

declarado como

```json
"bundle": { "externalBin": ["binaries/gentle-bridge"] }
```

**No** está declarado, a propósito: nada en este repositorio puede producir esos archivos todavía, y Tauri
falla el build cuando falta un `externalBin` declarado. Una declaración sin artefactos rompe todos los
builds en todas las plataformas — peor que la brecha documentada. Pasa a ser el mecanismo correcto cuando
exista el bundle de un solo archivo (opción 2 de arriba); el script tiene que emitir entonces los nombres
con sufijo de plataforma de arriba, y la búsqueda en runtime se muda de `$RESOURCE/bridge/node` al helper
de sidecar.

## Lo que arranca el lado Rust

Implementado en `apps/desktop/src-tauri/src/bridge_process.rs`, cableado en `src/lib.rs`. El contrato que
mantiene:

- **Deshabilitado en desarrollo.** `scripts/dev.mjs` ya es dueño del ciclo de vida del bridge en el puerto
  7787; un binario de release no debe lanzar un segundo. Se condiciona con `cfg!(debug_assertions)`
  (`tauri dev` corre en debug) y loguea una línea en lugar de lanzar.
- **Resolver a través del directorio de recursos**, nunca una ruta relativa: `app.path().resource_dir()`
  da la ubicación específica de la plataforma de `bridge/` (`Contents/Resources` dentro del `.app`, al
  lado del ejecutable en Linux y Windows). Un `bridge/node(.exe)` o un `bridge/app/dist/main.js` faltante
  se reporta como fallo, no se reintenta para siempre.
- **Lanzar** `$RESOURCE/bridge/node(.exe)` con `$RESOURCE/bridge/app/dist/main.js`, puerto `0` para que el
  OS elija uno libre. No se pasa token: el bridge genera uno aleatorio y lo imprime. El hijo corre en un
  thread de fondo para que un arranque lento de Node nunca congele la ventana.
- **Leer una línea de handshake** del stdout del hijo (`{"event":"ready","port":…,"token":…}`), acotada
  por un timeout de 10 s que cubre tanto la lectura como la espera. El thread lector sigue drenando stdout
  después y logueándolo como `bridge: …`: cerrar el pipe bajo el hijo convertiría su próxima línea de log
  en `EPIPE` y lo mataría.
- **Ser dueño del ciclo de vida**: el `Child` vive en estado manejado, y tanto `WindowEvent::CloseRequested`
  como `RunEvent::Exit` lo terminan, así que salir de la app nunca deja un huérfano con la sesión del
  agente tomada. Un bridge cuyo handshake falló se mata de inmediato; un bridge que reportó un puerto y
  después salió se reporta a la UI como error, no como un endpoint usable.

El módulo usa solo `std::process`, `serde` y `serde_json`: un solo spawn no justifica `tauri-plugin-shell`
más sus entradas de capabilities.

## El handshake

El bridge imprime exactamente una línea en stdout cuando está escuchando (`packages/bridge/src/main.ts`):

```json
{"event":"ready","port":47831,"token":"…"}
```

Esa línea es el contrato entre las dos mitades. Rust guarda el resultado parseado y lo expone como un solo
comando de Tauri:

```rust
#[tauri::command]
pub fn bridge_endpoint(state: tauri::State<'_, BridgeState>) -> Result<BridgeEndpoint, String>
```

El comando, y no un evento, porque el frontend necesita la respuesta exactamente una vez, al arrancar, y
la necesita como un valor que pueda esperar: `invoke("bridge_endpoint")` es request/response, mientras que
un evento significaría escuchar algo que puede haberse emitido antes de que el webview se suscribiera.
Tampoco necesita una entrada de capability: los comandos de la app no están restringidos por
`capabilities/`. Cuando la espera se agota, falta el bundle, o el hijo ya salió, el comando responde
`Err(message)` con un mensaje escrito para el usuario; nunca paniquea y nunca adivina un puerto.

`apps/desktop/src/lib/bridge-endpoint.ts` es dueño del lado del frontend, con tres fuentes en orden:

1. `VITE_BRIDGE_URL` cuando está seteada — `scripts/dev.mjs` la setea, así que una sesión de navegador
   sigue usando el bridge de desarrollo en 7787 con token `dev` y nunca le pregunta nada a Tauri;
2. si no, dentro del webview de Tauri (`"__TAURI_INTERNALS__" in window`), `bridge_endpoint`;
3. si no, el default de desarrollo `ws://127.0.0.1:7787/?token=dev`.

La API de Tauri se importa dinámicamente, así que una sesión de navegador no carga nada de ella. Un rechazo
del paso 2 se muestra en la UI como el error de arranque que es; caer al puerto de desarrollo ahí
escondería un bundle roto detrás de un timeout de conexión. `App.tsx` espera la resolución antes de
`connect()`, lo que deja la UI en su estado `connecting` existente mientras arranca el bridge empaquetado.

## Lo que sigue sin probarse

Los caminos de código están puestos y `cargo check`, `pnpm -r typecheck` y la suite de desktop cubren su
lógica, pero nada de lo siguiente corrió sobre un bundle real, porque producirlo necesita `tauri build`
(descarga del runtime de Node, minutos de compilación de Rust) y una GUI:

- que `bundle.resources` realmente deje `bridge/` donde `resource_dir()` lo busca en cada OS, y que el
  `node` copiado conserve su bit de ejecución dentro de `.AppImage`, `.deb`, `.dmg` y `.msi`;
- que el bundle de macOS arranque Node bajo las reglas de Gatekeeper/notarización, y que Windows Defender
  no ponga en cuarentena un `node.exe` incluido;
- que un primer arranque en frío complete el handshake dentro del timeout de 10 s en hardware lento (el
  timeout es la única cota; nunca se midió contra un binario de release real);
- que `CloseRequested` y `RunEvent::Exit` se disparen antes de que el OS reclame la ventana en cada
  escritorio, para que ningún `node` sobreviva a un cierre;
- la apariencia del banner de fallo de arranque en el shell empaquetado, que se revisó solo como código.

Cerrar esa lista es un artefacto por OS más un lanzamiento, que es lo que produce el workflow de release.

## CI

`.github/workflows/ci.yml`, en `ubuntu-latest`, Node 22, pnpm `12.4.1` (igual que `packageManager` en el
`package.json` de la raíz): `pnpm install --frozen-lockfile`, `pnpm -r typecheck`, `pnpm test` (que es
`pnpm -r test`, así que tanto `apps/desktop` como `packages/bridge`).

Limitación conocida, documentada en el workflow: la suite del bridge arranca un hijo real de
`pi --mode rpc` y carga el harness de gentle-pi, así que falla en un runner pelado que no tenga ninguno de
los dos. CI todavía no aprovisiona el harness.

## Release

`.github/workflows/release.yml` corre con un tag `v*` y con dispatch manual (con un input `tag`), como
matriz sobre `ubuntu-latest` (`.AppImage`, `.deb`), `macos-14` (`.dmg`) y `windows-latest` (`.msi`), cada
uno instalando Node 22, pnpm `12.4.1`, Rust stable y las dependencias de webkit de Linux
(`libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf`), y después
`tauri-apps/tauri-action` compila y adjunta los artefactos a una release **draft** de GitHub.

Un maintainer corta una release con:

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

Ensayarlo localmente sin publicar (este es el comando que debe quedar fuera de las corridas de agentes,
compila Rust por minutos):

```bash
pnpm --filter @gentle-shell/desktop package:sidecar     # downloads the Node runtime, builds the bridge
pnpm --filter @gentle-shell/desktop tauri build         # reused: tauri build runs it again itself
```

### Firma de código

Los builds sin firmar funcionan y avisan en el primer arranque. Firmar necesita secretos que todavía no
existen en este repositorio, nombrados como los lee la toolchain de Tauri upstream: `APPLE_CERTIFICATE`,
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`
para la firma y notarización de macOS, y `TAURI_SIGNING_PRIVATE_KEY` /
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` para las firmas del updater y del instalador. La firma en Windows
necesita un certificado (`bundle.windows.certificateThumbprint` o un comando de firma en
`tauri.conf.json`) antes que un nombre de secreto.

## Checklist de verificación

Chequeos baratos que un cambio de empaquetado tiene que mantener en verde:

```bash
node -e "JSON.parse(require('node:fs').readFileSync('apps/desktop/src-tauri/tauri.conf.json','utf8'))"
node --check scripts/package-sidecar.mjs
pnpm --filter @gentle-shell/desktop package:sidecar -- --plan      # no network, resolves only
pnpm -r typecheck
pnpm test
(cd apps/desktop/src-tauri && cargo check)                        # the spawn path must stay warning-free
```

Lo que solo un build real puede probar, y por lo tanto queda sin probar hasta que corra CI: que los
recursos se copien al bundle, que el sidecar arranque bajo las reglas de sandboxing de cada OS, que los
instaladores `.dmg` y `.msi` funcionen, y que la notarización de macOS pase cuando exista la firma. La
parte de spawn y handshake de esa lista está itemizada en
[Lo que sigue sin probarse](#lo-que-sigue-sin-probarse).
