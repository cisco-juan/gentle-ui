import { existsSync } from "node:fs";
import type { PermissionMode, PermissionsView, ProfilesFailureReason } from "@gentle-shell/protocol";
import {
	GentlePiLibraryError,
	gentleHomes,
	importModules,
	requireFunctions,
	resolveExtensionRoot,
	type GentleOptions,
} from "./gentle-pi-library.ts";

/**
 * The permission mode new threads start in, read and written with gentle-pi's own library.
 *
 * A thread's mode lives in memory and only a terminal session may change it (gentle-pi refuses anything
 * else on purpose), so the one thing that is a file is the default the next thread starts with. This module
 * exposes that file and nothing more, and with a rule the file itself does not have:
 *
 *   the default may be lowered from here, never raised.
 *
 * The bridge is reachable by every local process that holds its token, the agent included. If it would
 * write `yolo` or `super-yolo` on request, any of them could remove the approvals of every later thread
 * without a person at a terminal. So the refusal is made here, on the server, for any request that is not
 * exactly `normal` or `auto`, whatever the UI shows. Raising stays a terminal job: `/gentle:mode default yolo`.
 */

/** The modes this bridge writes. Anything else, a real mode included, is refused. */
export const SETTABLE_MODES: readonly PermissionMode[] = ["normal", "auto"];

const REQUIRED = ["resolvePermissionModePolicy", "writePermissionModePolicy"] as const;

interface PolicyResolution {
	mode: PermissionMode;
	malformed: boolean;
	source: "global_file" | "default";
	globalFile: string;
}

interface PermissionsLibrary {
	resolvePermissionModePolicy(options: { gentlePiConfigHome?: string }): PolicyResolution;
	writePermissionModePolicy(mode: PermissionMode, options: { gentlePiConfigHome?: string }): string;
}

export interface PermissionsOptions extends GentleOptions {
	/** Load the library some other way; a test points this at a stand-in. */
	readonly loadLibrary?: (root: string) => Promise<unknown>;
}

const loaded = new Map<string, Promise<PermissionsLibrary>>();

async function library(options: PermissionsOptions): Promise<PermissionsLibrary> {
	if (options.loadLibrary !== undefined) {
		return requireFunctions<PermissionsLibrary>(await options.loadLibrary(options.extension ?? ""), REQUIRED, "permission policy");
	}
	const root = resolveExtensionRoot(options);
	const cached = loaded.get(root);
	if (cached !== undefined) return cached;
	const pending = importModules(root, ["permission-mode-policy"]).then((modules) =>
		requireFunctions<PermissionsLibrary>(modules, REQUIRED, "permission policy"),
	);
	// A failed load is not remembered: installing or fixing gentle-pi must not need a bridge restart.
	pending.catch(() => loaded.delete(root));
	loaded.set(root, pending);
	return pending;
}

/** The default for new threads, or why it cannot be told. Reading never writes. */
export async function permissionsStatus(options: PermissionsOptions = {}): Promise<PermissionsView> {
	let lib: PermissionsLibrary;
	try {
		lib = await library(options);
	} catch (error) {
		if (error instanceof GentlePiLibraryError) return unavailable(error.reason, error.message);
		throw error;
	}
	return viewOf(lib, options);
}

/**
 * Set the default new threads start in, to `normal` or `auto`.
 *
 * `mode` arrives from the wire as an unchecked value, so it is compared as is: no trimming, no case
 * folding, nothing that could turn a near miss into a different mode.
 */
export async function permissionsSetDefault(mode: unknown, options: PermissionsOptions = {}): Promise<PermissionsView> {
	if (mode === "yolo" || mode === "super-yolo") {
		throw new Error(`"${mode}" is not set from the UI: raising permissions is done in a terminal session, with /gentle:mode default ${mode}.`);
	}
	if (mode !== "normal" && mode !== "auto") {
		throw new Error(`${JSON.stringify(mode) ?? String(mode)} is not a permission mode this can set; use normal or auto.`);
	}

	const lib = await library(options);
	const { configHome } = gentleHomes(options);
	// gentle-pi refuses to overwrite a preference file it cannot read; that refusal is surfaced as it is.
	const current = lib.resolvePermissionModePolicy({ gentlePiConfigHome: configHome });
	if (current.malformed) {
		throw new Error(`the permission preference at ${current.globalFile} is malformed or unreadable, so it was left alone: repair it before saving.`);
	}
	lib.writePermissionModePolicy(mode, { gentlePiConfigHome: configHome });
	return viewOf(lib, options);
}

function viewOf(lib: PermissionsLibrary, options: PermissionsOptions): PermissionsView {
	const { configHome } = gentleHomes(options);
	const resolution = lib.resolvePermissionModePolicy({ gentlePiConfigHome: configHome });
	if (resolution.malformed) {
		return unavailable("file-invalid", `${resolution.globalFile} is not a permission preference gentle-pi accepts, so it was left alone. Fix or remove it, then reload.`);
	}
	return {
		state: "ok",
		reason: null,
		message: "",
		default: resolution.mode,
		stored: resolution.source === "global_file" && existsSync(resolution.globalFile),
		settable: SETTABLE_MODES,
	};
}

function unavailable(reason: ProfilesFailureReason, message: string): PermissionsView {
	return { state: "unavailable", reason, message, default: null, stored: false, settable: SETTABLE_MODES };
}
