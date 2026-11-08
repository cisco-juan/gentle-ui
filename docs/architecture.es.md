# Arquitectura

## Forma

```
 ┌─────────────────────────┐        WebSocket (127.0.0.1, token)        ┌──────────────────┐
 │ apps/desktop            │  ────────────────────────────────────────▶ │ packages/bridge  │
 │ Tauri v2 + Solid viewer │  ◀──────────────────────────────────────── │ Node child of pi │
 └─────────────────────────┘        JSON messages + raw records        └──────────────────┘
                                                                                  │ JSONL
                                                                                  ▼
                                                                        pi --mode rpc
                                                                     (agent, tools, sessions)
```

El shell de escritorio renderiza; el bridge es dueño de los procesos y del protocolo; Pi es dueño del
agente. Ninguna parte de Gentle Shell se bifurca: `@earendil-works/pi-coding-agent` y `gentle-pi` son
dependencias pinneadas, así que las releases de upstream llegan como bumps de versión.

## Por qué no bifurcar la TUI

La UI de terminal de Gentle Shell es código de paquete que se mete en los internals privados de layout
de Pi (`tui.layoutRoot` más un nodo de layout con clave de símbolo) para construir su rail, y depende de
`setFooter`/`setHeader`/`setEditorComponent` y de `ctx.ui.custom()`. Sobre RPC eso está explícitamente
sin soporte: `custom()` devuelve `undefined` y los setters de footer/header/editor no hacen nada. Un fork
heredaría toda la cadena de entrega (launcher, descargas del binario en postinstall, `runtime/*.mjs`
generados, guards de versión) y además seguiría limitado a lo que una terminal puede dibujar.

## Arrancar el agente correctamente

`pi --mode rpc` solo **no** es Gentle Shell. El launcher inyecta el paquete con `-e` y pinnea el entorno,
porque gentle-pi no está declarado en los settings del usuario (es el host, no un plugin). Dos detalles
deciden entre funcionar o que `pi` salga con 1:

- `-e` necesita el directorio **resuelto** del paquete, no el symlink de pnpm; los imports de la
  extensión se resuelven desde la ruta lógica y fallan si no.
- una raíz candidata tiene que resolver sus dependencias declaradas — la copia instalada por npm en esta
  máquina declara `pi.extensions` pero no tiene `@heyhuynhgiabuu/pi-pretty` al lado, así que no puede
  cargar.

Variables pinneadas: `PI_CODING_AGENT_DIR` y `GENTLE_PI_AGENT_HOME` (el mismo agent home que la TUI, para
que las sesiones caigan donde las busca el índice de sesiones), `GENTLE_SHELL_USER_PI_HOME`,
`GENTLE_SHELL_CONFIG_HOME`, `PI_PROGRAM_STATUS_APP=gentle-shell`, y `GENTLE_SHELL_INTERACTIVE_HOST=1` para
que los diálogos y la actividad de subagentes viajen por RPC. La resolución vive en
`packages/bridge/src/pi-environment.ts`; el paquete se overridea con `GENTLE_PI_PACKAGE`.

Efecto medido: 30 comandos sin ningún `gentle:*` antes, 86 comandos con 36 `gentle:*` después.

## Los comandos tienen un host

El paquete registra 36 comandos y unos dieciséis están atados a la terminal: overlays, vistas fullscreen
y modales que no existen sobre RPC, donde `ctx.ui.custom()` devuelve undefined y el handler o avisa o no
hace nada en silencio. El shell de escritorio lleva la clasificación en `apps/desktop/src/lib/commands.ts`
y rechaza esos comandos en el único punto de control por el que pasa cada prompt, nombrando la superficie
que hace ese trabajo en su lugar.

El primer argumento decide, porque cambia el comando: `gentle:profiles` a secas abre el picker fullscreen
de modelos e incluso lanza, mientras que `gentle:profiles export` nunca lo toca; `gentle:mode status`
solo lee, mientras que `gentle:mode yolo` muta permisos, algo que se rechaza fuera de una sesión de
terminal. Los comandos desconocidos se reenvían a propósito: rechazar un comando real es peor que dejar
que el agente responda.

Varios de estos tienen un request RPC que reemplaza el comando entero: la elección de modelo es
`set_model` y `get_available_models`, la lista de comandos es `get_commands`, los números de sesión son
`get_session_stats`, y `gentle:changes` necesita que el host haga el diff por su cuenta — que es
exactamente por lo que el inspector tiene una capa de git.

## El protocolo que hablamos

`pi --mode rpc` es JSONL sobre stdin/stdout, enmarcado con LF. El `readline` de Node no sirve: corta en
`U+2028`/`U+2029`, que son legales dentro de strings JSON.

- **Comandos** (`stdin`, un registro con `id` opcional): `prompt`, `steer`, `follow_up`, `abort`,
  `clear_queue`, `new_session`, `get_state`, `get_messages`, `set_model`, `cycle_model`,
  `get_available_models`, thinking levels, `compact`, `bash`, `abort_bash`, `get_session_stats`,
  `export_html`, `switch_session`, `fork`, `clone`, `get_tree`, `get_entries`, `set_session_name`,
  `get_commands`. La allowlist vive en `packages/bridge/src/commands.ts`.
- **Respuestas**: `{"type":"response","id","command","success","data"|"error"}`.
- **Eventos**: `agent_start`, `turn_*`, `message_start|update|end` (streaming de deltas vía
  `contentIndex`), `tool_execution_start|update|end`, `queue_update`, `compaction_*`, `auto_retry_*`,
  `agent_settled`, `extension_error`, `bash_execution_update`.
- **Diálogos**: `extension_ui_request` con `method` `select`, `confirm`, `input` o `editor` bloquea al
  agente hasta que respondemos `{"type":"extension_ui_response","id","value"|"confirmed"|"cancelled"}`.
  Son los prompts de permisos y los cuestionarios; la UI los renderiza como tarjetas inline.
- **Fire-and-forget**: `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`.

`agent_end` termina una corrida de bajo nivel; `agent_settled` es la única señal de que Pi no va a
continuar automáticamente (pueden seguir retries, compactación, steering y follow-ups). La UI se queda en
"running" hasta settled.

## Lo que la UI recibe gratis y lo que reconstruye

Gratis por RPC y por los archivos de sesión: hilos (`get_tree`, `switch_session`, `fork`, `clone`),
transcript (`get_messages` más los eventos de streaming), actividad de herramientas, permisos, selección
de modelo y de nivel de pensamiento, comandos y skills (`get_commands`), stats, compactación, bash,
actividad de subagentes (publicada por gentle-pi como payloads estructurados de `setWidget`), memoria
(proveedor externo).

Reconstruido por nosotros: cada panel (rail, inspector, paleta, cheat sheet), el composer, la vista de
diff, la lista de tareas y la superficie de review. Eran componentes de la TUI; nada de eso es
transporte.

## Distribución de la funcionalidad

1. **Rail izquierdo** (colapsable): Sessions, Git, Files, Tasks, Memory, Agents, Settings; debajo, el
   árbol proyecto → hilo con búsqueda inline.
2. **Centro de chat**: mensajes, tool cards colapsables, diffs inline, tarjetas de permisos.
3. **Inspector derecho**: las mismas vistas como pestañas, contextuales a la selección.
4. **Composer**: perfil, modelo, effort, modo de permisos y adjuntos como chips inline — sin modales.
5. **Paleta** (`Mod K`): cada acción y cada comando slash por nombre.

Los keybindings usan `Mod` (⌘ en macOS, Ctrl en el resto). Base: `Mod K` paleta, `Mod P` quick open,
`Mod B` rail, `Mod Alt B` inspector, `Mod Enter` enviar, `Esc` interrumpir, `Mod Shift K` cheat sheet.

## Empaquetado

Tauri compila por sistema operativo; los artefactos salen de una matriz de CI (Linux `.AppImage`/`.deb`,
macOS `.dmg`, Windows `.msi`), nunca de compilación cruzada. El webview es el del sistema (webkit2gtk en
Linux, WKWebView en macOS, WebView2 en Windows), así que el CSS se limita a lo que los tres respetan.
Node viaja como sidecar de Tauri para que los usuarios nunca instalen Node ni Pi. La firma de código es
una decisión de distribución, no de build.
