[English](README.md) · Español

# gentle-ui

<p>
  <a href="https://github.com/Gentleman-Programming/gentle-shell"><img alt="Made with Gentle AI" src="https://img.shields.io/badge/Made%20with-Gentle%20AI-6A4BFF"></a>
  <img alt="Tauri v2" src="https://img.shields.io/badge/shell-Tauri%20v2-24C8DB">
  <img alt="Node >= 22" src="https://img.shields.io/badge/node-%3E%3D22-5FA04E">
  <img alt="pnpm 12" src="https://img.shields.io/badge/pnpm-12-4B5563">
  <img alt="Linux, macOS, Windows" src="https://img.shields.io/badge/platforms-linux%20%7C%20macOS%20%7C%20windows-6E6E6E">
</p>

gentle-ui es una UI de escritorio para [Gentle Shell](https://github.com/Gentleman-Programming/gentle-shell):
una interfaz multiplataforma sobre el harness de agentes Pi. Corre el mismo agente, contra las mismas
sesiones y la misma configuración, y dibuja la aplicación en una ventana nativa en lugar de una
terminal.

## Por qué

La UI de terminal es código de paquete, y sobre RPC las piezas con las que está construida no están
soportadas: `ctx.ui.custom()` devuelve `undefined`, y los setters de header, footer y editor no hacen
nada. Un fork heredaría toda la cadena de entrega y además seguiría limitado a lo que una terminal
puede dibujar. Por eso este repositorio es una capa de presentación, no un fork.

- **Un solo harness, dos ventanas.** La aplicación lanza el proceso real `pi --mode rpc` con el entorno
  propio de Gentle Shell, así que los hilos escritos acá caen donde la terminal los lista, los perfiles
  son el mismo archivo, y las herramientas y skills del agente son las que ya están instaladas.
- **Paridad de funcionalidades donde el transporte lo permite.** Todo lo que es independiente del
  transporte está en la UI. Los comandos que solo existen como overlays de terminal se rechazan en un
  único punto de control, nombrando la superficie que hace ese trabajo, y los modos de permisos
  elevados indican el comando de terminal que los define en lugar de fingir que funcionan.
- **Actualizable sin fork.** El harness se consume como paquetes pinneados, así que una release de
  upstream llega como un bump de versión. En este árbol no vive ninguna copia vendorizada de Gentle
  Shell.
- **Pensado para el mouse y el teclado.** La elección de agente y de perfil vive en el composer y en
  los paneles, no en modales, y cada acción es también una entrada de la paleta y un atajo.

## Qué incluye

### Superficie de chat

- Respuestas en streaming con renderizado de Markdown.
- La cadena de pensamiento del modelo, colapsada por defecto, claramente separada de la respuesta y
  reproducida cuando se reabre un hilo.
- Tool cards colapsables. Las llamadas que tocan archivos renderizan una file-change card con la ruta,
  un conteo `+N −M` y el diff unificado o una vista previa, en lugar del volcado crudo de argumentos.
- Los diálogos de permisos y cuestionarios de las extensiones como tarjetas inline en el transcript.
- Historial paginado hacia atrás desde el archivo de sesión a medida que se hace scroll, con los
  resultados de herramientas plegados en el turno que los llamó; el stream sigue solo mientras se está
  al final, y un control de ir al final aparece cuando no lo estás.
- Una línea que siempre dice qué está haciendo la corrida — pensando, ejecutando una herramienta,
  escribiendo la respuesta, esperando tu aprobación — en lugar de un spinner que desaparece.
- Los prompts enviados en medio de una corrida quedan en cola, el borrador sobrevive a un bridge
  ausente, y una conexión perdida se ve, con Reconnect.

### Chips del composer

Todo lo que cambia cómo corre el próximo mensaje es un chip en el composer, nunca un modal:

- **Modelo** — la lista de modelos del propio agente, con búsqueda.
- **Perfil** — los perfiles que mantiene gentle-pi, el activo marcado `default`, más *Manage
  profiles…*.
- **Permisos** — el modo en el que arrancan los hilos nuevos. El hilo abierto conserva el modo con el
  que arrancó, porque Pi no publica el modo por hilo sobre RPC. Acá solo se pueden escribir los modos
  sin terminal (`normal`, `auto`); los elevados muestran la línea `/gentle:mode default …` que los
  define en una terminal.
- **Adjuntos** — arrastrar archivos o pegar una imagen del portapapeles; cada fila muestra su nombre,
  su tamaño y si el bridge lo aceptó.

### Inspector

El panel derecho, con splitters redimensionables y pestañas contextuales a la selección:

- **Changes** — el estado git del workspace con glifos de estado y `+n −n` por archivo, y un diff
  unificado clasificado en meta, hunk, contexto, agregado y borrado.
- **Files** — el árbol del workspace, primero los directorios, con una vista previa acotada.
- **Tasks** — los documentos `odd/tasks/*.md` con el conteo de sus checkboxes.
- **Agents** — las corridas de subagentes del hilo abierto, las más recientes arriba; un click abre un
  modal con los pasos de esa corrida y se cierra con Escape.
- **Review** — la primera fase del review nativo: la authority registrada con su correction budget
  congelado, el target, la evaluación de riesgo y la tarjeta de consentimiento que lo inicia.
- **Memory** — una vista de solo lectura sobre el proveedor de memoria Engram.
- **Settings** — un sheet desde el pie del rail y `Mod+,` con los datos de la sesión; modelo, perfil y
  modo de permisos siguen vivos en el composer.

### Teclado

`Mod` es ⌘ en macOS y Ctrl en el resto. `Mod K` paleta (acciones, hilos, comandos slash, modelos),
`Mod P` abrir un hilo rápido, `Mod B` rail, `Mod Alt B` inspector, `Mod Enter` enviar, `Esc` interrumpir
o cerrar, `Mod Shift K` cheat sheet, `Mod ,` settings.

### Perfiles y permisos

- **Perfiles** — un sheet que lista los perfiles del propio `profiles.json` de gentle-pi con el modelo,
  el nivel de pensamiento y el tier de cada agente, y permite duplicar, renombrar, borrar y *Use for
  new threads*. Las escrituras son atómicas, y el archivo se respalda siempre que no sea lo último que
  escribió el bridge. Un hilo en ejecución congela su perfil al arrancar, así que un cambio aplica al
  hilo siguiente.
- **Permiso por defecto** — el chip escribe el modo en el que arrancan los hilos nuevos, y el menú
  siempre dice cuál es el modo actual.

## Cómo funciona

```
┌──────────────────────────┐   WebSocket 127.0.0.1 + token   ┌────────────────────────┐
│ apps/desktop             │ ──────────────────────────────▶ │ packages/bridge        │
│ shell Tauri v2           │ ◀────────────────────────────── │ proceso Node           │
│ frontend Solid + Vite    │        mensajes JSON            │ dueño del hijo agente  │
└──────────────────────────┘                                 └───────────┬────────────┘
                                                                         │ JSONL por stdio
                                                                         ▼
                                                              pi --mode rpc
                                                       (agente, tools, sesiones)
```

- **Shell Tauri** (`apps/desktop/src-tauri`) — la ventana nativa, el webview del sistema y, en un build
  empaquetado, el lanzamiento del bridge incluido en el bundle y la lectura del puerto y el token que
  imprime.
- **Frontend Solid** (`apps/desktop/src`) — toda la UI: transcript, composer, inspector, paleta. En
  desarrollo también corre en un navegador común contra el bridge de desarrollo.
- **Bridge Node** (`packages/bridge`) — lanza `pi --mode rpc` con el entorno pinneado de Gentle Shell,
  enmarca el protocolo JSONL, aplica la allowlist de comandos, distribuye los eventos a la UI y
  responde los diálogos de las extensiones.
- **Tipos de wire compartidos** (`packages/protocol`) — las formas de request y de evento contra las
  que compilan ambos lados.

La regla que lo mantiene mantenible: el harness se consume, nunca se bifurca.
`@earendil-works/pi-coding-agent` es una dependencia npm pinneada, y `gentle-pi` se resuelve desde el
paquete instalado al arrancar, con el entorno del launcher fijado en su lugar (`GENTLE_PI_PACKAGE`
permite overridear la raíz del paquete). `pi --mode rpc` solo no es Gentle Shell; el bridge reproduce
exactamente lo que inyecta el launcher, y `docs/architecture.md` explica por qué.

## Primeros pasos

Requisitos: **Node >= 22** y **pnpm 12** (el repositorio pinnea `pnpm@12.4.1` en `package.json`). Una
toolchain de Rust y las dependencias de webkit de Linux solo hacen falta para la ventana de Tauri.

```bash
pnpm install        # todos los paquetes del workspace
pnpm dev            # bridge en :7787 y la UI en http://localhost:1420
pnpm dev:desktop    # la ventana de Tauri (el primer build compila el shell en Rust)
pnpm test           # todos los paquetes: desktop y bridge
pnpm typecheck      # todos los paquetes del workspace
```

Con `pnpm dev` la interfaz se abre en http://localhost:1420 mientras se desarrolla. `pnpm dev:web` y `pnpm dev:bridge`
corren esas dos mitades por separado.

Dos avisos para que nada sorprenda: la suite del bridge lanza un hijo real de `pi --mode rpc` y carga
el harness de gentle-pi, así que necesita ambos instalados en la máquina, y construir instaladores
requiere un build por plataforma (ver `docs/packaging.md`).

## Estructura del repositorio

```
apps/desktop        shell Tauri v2 + UI Solid (corre en un navegador durante el desarrollo)
packages/bridge     proceso Node que es dueño de `pi --mode rpc` y habla WebSocket con la UI
packages/protocol   tipos de wire compartidos
docs/               notas de arquitectura y de empaquetado
odd/tasks/          documentos de features con specs, tareas y evidencia
```

## Documentación

- [docs/architecture.es.md](docs/architecture.es.md) — el diseño: shell, bridge, protocolo, comandos,
  paneles y empaquetado en breve.
- [docs/packaging.es.md](docs/packaging.es.md) — cómo se produce una release: sidecar, layout del
  bundle, CI y workflow de release.
- [README.md](README.md) — this document in English.
- Originales en inglés: [docs/architecture.md](docs/architecture.md),
  [docs/packaging.md](docs/packaging.md).

## Construido sobre Gentle Shell

[Gentle Shell](https://github.com/Gentleman-Programming/gentle-shell) es el harness que esta UI
conduce: el agente, sus herramientas, sus comandos, sus perfiles y su formato de sesión vienen de ahí.
Este repositorio solo agrega una ventana. Como no hay fork, una release de upstream se adopta pasando
a su versión: `@earendil-works/pi-coding-agent` está pinneado en `packages/bridge/package.json`, y
`gentle-pi` es el paquete instalado que el bridge resuelve al arrancar. No hay código vendorizado ni
copia parcheada que rebasear.

## Estado

Funciona, y es honesto sobre lo que falta. Al `develop` del 2026-11-08:

- 29 de las 32 tareas de `odd/tasks/gentle-shell-desktop-ui.md` están tildadas. Abiertas: la segunda
  fase del review nativo (capturas de lentes, veredictos y acknowledgement), el gate de verificación
  del módulo de perfiles del bridge, y el empaquetado.
- **Tests:** 163 de desktop y 216 del bridge en verde, ambas suites corriendo juntas.
- **El empaquetado todavía no se distribuye.** El script del sidecar, los checks de CI y el workflow de
  release existen, pero ningún instalador se produjo ni se lanzó desde este árbol, así que los caminos
  empaquetados están cubiertos por revisión de código, no por una corrida real.
- **La superficie que es solo de terminal sigue siendo de terminal.** Algunos comandos de gentle-pi
  necesitan `ctx.ui.custom()`, que RPC no puede dar, y el chip de permisos rechaza los modos elevados
  con el comando que los define.
