import type { PiCommand } from "@gentle-shell/protocol";

/**
 * Commands the bridge forwards to `pi --mode rpc`.
 *
 * Anything outside this list is rejected with an explicit error instead of being handed to Pi's
 * parser, so a UI bug surfaces as a message rather than a silent no-op.
 */
export const PI_COMMANDS = [
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"clear_queue",
	"new_session",
	"get_state",
	"get_messages",
	"set_model",
	"cycle_model",
	"get_available_models",
	"set_thinking_level",
	"cycle_thinking_level",
	"get_available_thinking_levels",
	"set_steering_mode",
	"set_follow_up_mode",
	"compact",
	"set_auto_compaction",
	"set_auto_retry",
	"abort_retry",
	"bash",
	"abort_bash",
	"get_session_stats",
	"export_html",
	"switch_session",
	"fork",
	"clone",
	"get_fork_messages",
	"get_entries",
	"get_tree",
	"set_session_name",
	"get_last_assistant_text",
	"get_commands",
] as const satisfies readonly PiCommand[];

const COMMAND_SET: ReadonlySet<string> = new Set(PI_COMMANDS);

/** Reject unknown commands loudly instead of forwarding them into Pi's parser. */
export function resolveCommand(name: string): PiCommand {
	if (!COMMAND_SET.has(name)) throw new Error(`unsupported command: ${name}`);
	return name;
}
