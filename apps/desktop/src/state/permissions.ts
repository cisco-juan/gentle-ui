import { createSignal, type Accessor } from "solid-js";
import type { PermissionsView } from "@gentle-shell/protocol";
import type { BridgeClient } from "../lib/bridge";
import { isSettable } from "../lib/permissions.ts";

/**
 * Permission-default panel state.
 *
 * Only a lowering is ever sent: an elevated mode is refused here before the request exists, and again by
 * the bridge on the server. Raising the default is a terminal job, and the message says so.
 */
export interface PermissionsPanelView {
	readonly data: PermissionsView | null;
	readonly busy: boolean;
	readonly error: string | null;
	readonly notice: string | null;
}

export interface PermissionsPanelOptions {
	readonly connect: () => BridgeClient | null;
	/** Open a fresh thread, which starts in the default that was just set. */
	readonly newThread: () => Promise<void>;
}

export interface PermissionsPanel {
	readonly view: Accessor<PermissionsPanelView>;
	refresh(): Promise<void>;
	/** Set the default for new threads and open one that starts in it. */
	setDefault(mode: string): Promise<void>;
}

export function createPermissionsPanel(options: PermissionsPanelOptions): PermissionsPanel {
	const [view, setView] = createSignal<PermissionsPanelView>({ data: null, busy: false, error: null, notice: null });

	async function refresh(): Promise<void> {
		const client = options.connect();
		if (client === null) return;
		try {
			const data = await client.permissions({ action: "status" });
			setView((value) => ({ ...value, data, error: null }));
		} catch (error) {
			setView((value) => ({ ...value, error: messageOf(error) }));
		}
	}

	async function setDefault(mode: string): Promise<void> {
		if (!isSettable(mode)) {
			setView((value) => ({
				...value,
				error: `"${mode}" is set in a terminal session, not from here: raising permissions needs a person at the terminal.`,
				notice: null,
			}));
			return;
		}
		const client = options.connect();
		if (client === null) {
			setView((value) => ({ ...value, error: "the bridge is not connected" }));
			return;
		}

		setView((value) => ({ ...value, busy: true, error: null, notice: null }));
		try {
			const data = await client.permissions({ action: "default", mode });
			// The chip shows the default the bridge reports, never the one that was asked for. An answer that
			// carries no default means nothing was applied, so the previous value stays and no thread opens.
			if (data.state !== "ok" || data.default === null) {
				setView((value) => ({
					...value,
					error: data.message.length > 0 ? data.message : "the bridge did not save the new default",
				}));
				return;
			}
			const applied = data.default;
			setView((value) => ({ ...value, data }));
			await options.newThread();
			setView((value) => ({ ...value, notice: `New threads now start in ${applied}, and a new thread was opened.` }));
		} catch (error) {
			setView((value) => ({ ...value, error: messageOf(error) }));
		} finally {
			setView((value) => ({ ...value, busy: false }));
		}
	}

	return { view, refresh, setDefault };
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
