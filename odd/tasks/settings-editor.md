# Settings editable desde la UI

El sheet de Settings deja de ser solo lectura: modelo, perfil, modo de permisos, paquetes, skills,
servidores MCP y claves de `settings.json` se modifican desde la UI, con backup y confirmación antes de
cada escritura.

## Specs

- **S1** — «actualmente los settings solo muestra la info, no tenemos las opciones para modificar».
- **S2** — Alcance elegido: «Todo, incluido MCP y settings.json» — «Configuración completa del agente editable desde la UI, con guardas y confirmaciones.»
- **S3** — «mcp → alta/baja/edición de servidores MCP y su transporte»
- **S4** — «settings.json → edición de claves del agente»
- **S5** — «Backups y confirmaciones obligatorias antes de escribir»
- **S6** — Pendiente heredado de la lista anterior: «5. No puedo cambiar el modo, selecciono uno nuevo y no hace nada». El chip del composer y el sheet de Settings tienen que cambiar el modo por defecto de verdad.

Restricciones derivadas (no son frases del usuario; hacen cumplir S5 sobre el código real):

- **C1** — Se edita la configuración del agente que el bridge lanza: `<agentHome>` = `~/.gentle-shell/agent`
  (`PI_CODING_AGENT_DIR`), y `<configHome>` = `~/.gentle-shell/gentle-ai`. Nunca `~/.pi/agent`.
- **C2** — Un archivo que el bridge no puede leer o validar no se reemplaza ni se asume por defecto: se
  reporta `unavailable` con la razón, como ya hacen `profiles.ts` y `permissions.ts`.
- **C3** — Toda escritura es atómica, con permiso `0600`, y deja un backup del contenido anterior en
  `<configHome>/<familia>-backups/` cuando el disco difiere de lo último que escribió este proceso.
- **C4** — Ningún valor secreto (headers, api keys, tokens) va a logs, a la vista de solo lectura ni a un
  mensaje de error; se redacta como `<redacted>`.
- **C5** — El bridge es alcanzable por cualquier proceso local con el token, incluido el agente: una
  escritura exige un digest del plan exacto que la UI muestra en su confirmación.

## Tasks

| ID | Task | Spec | Route | Commit |
| --- | --- | --- | --- | --- |
| T1 | bridge: familia `settings` de solo lectura (rutas, paquetes, skills descubiertos, MCP redactado, claves) | S1 | worker | pending |
| T2 | bridge: protocolo preview/apply con digest para toda escritura de configuración | S5, C5 | worker | pending |
| T3 | bridge: escritor de paquetes con la API de Pi (listar/instalar/quitar) sobre `settings.json` | S2, S5 | worker | pending |
| T4 | bridge: escritor de MCP (alta/baja/edición, stdio y http) con validación y redacción | S3, S5 | worker | pending |
| T5 | bridge: escritor de claves acotadas de `settings.json` con valores tipados | S4, S5 | worker | pending |
| T6 | desktop: chip de permisos cableado al cliente real, estado compartido con el sheet | S6 | worker | pending |
| T7 | desktop: Settings editable (paquetes, skills, MCP, claves) con skeletons y confirmaciones | S1, S2, S3, S4 | worker | pending |
| T8 | docs: `docs/architecture.md` y la leyenda del sheet dejan de decir que no se edita | S1, S2 | inline | pending |

## Log

- **L1** — Pedido original, verbatim: «actualmente los settings solo muestra la info, no tenemos las opciones para modificar».
- **L2** — Decisión de alcance, verbatim: «Todo, incluido MCP y settings.json» — «Configuración completa del agente editable desde la UI, con guardas y confirmaciones.» Se descartaron las opciones parciales (solo modelo/perfil/modo; paquetes y skills sin MCP; solo lectura con instrucciones).
- **L3** — Evidencia del relevamiento (explorer, con `path:line`):
  - El bridge lanza Pi con `PI_CODING_AGENT_DIR=~/.gentle-shell/agent` (`packages/bridge/src/pi-environment.ts:74-87`), así que esa es la config a editar; `~/.pi/agent` no es la del agente.
  - Pi 1.5.0 exporta escritores reales: `DefaultPackageManager` (`install`, `installAndPersist`, `remove`, `removeAndPersist`, `addSourceToSettings`, `getInstalledPath`, resolve) y `SettingsManager` (`create`, `getPackages`/`setPackages`, `getSkillPaths`/`setSkillPaths`, `getExtensionPaths`, `flush`, `drainErrors`) con `FileSettingsStorage.withLock("global"|"project")`.
  - MCP: `loadMcpConfig`, `addMcpServerConfig`, `updateMcpServerConfig`, `removeMcpServerConfig`, `validateMcpServerConfig` existen en `dist/extensions/mcp/config.js` pero **no** se exportan desde el índice y el `exports` map bloquea el import profundo: hay que importar el archivo compilado por ruta absoluta.
  - Skills: solo hay lectura (`loadSkills`, `loadSkillsFromDir`). No existe enable/disable; un skill está presente o no en disco. Lo editable es la lista de rutas de skills en settings.
  - El RPC de Pi no tiene ningún comando de configuración, y el CLI sí (`pi install/remove/update/list`, `pi mcp add|remove|list`).
  - `apps/desktop/src/components/Sheets.tsx:55-61` contiene la leyenda estática «Packages, skills and MCP servers are read from the agent's own configuration; this shell does not edit them yet.» y `App.tsx:213-219` arma los hechos con `PROJECT_LABEL`, `chat.model()`, `profiles.effectiveName()`, `chat.permissionMode()`, `chat.commands().length`, `chat.threads().length`.
  - Ningún test del repo toca `mcp.json`, entradas `packages` ni rutas de skills: estas familias son las primeras.
- **L4** — Se hereda de la sesión anterior el estado de T19/T20 (permisos): el bridge y el cliente están commiteados en `2db84a9` y `d9911ad`, y el chip del composer todavía no los usa. Eso es S6/T6 de este documento.
