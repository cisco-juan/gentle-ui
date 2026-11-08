import type { SettingsSecretName } from "@gentle-shell/protocol";

/**
 * What may be shown of a value that can hold a credential: nothing.
 *
 * Every family that exposes the agent's configuration needs the same three rules, and a second copy of a
 * security projection is a copy that can drift. They live here so both a read and a write answer are
 * redacted by the same code.
 */

/** A name with no value: the panel may show that a header or a variable exists, never what it holds. */
export function secretNames(raw: unknown): SettingsSecretName[] {
	if (!isStringRecord(raw)) return [];
	return Object.keys(raw)
		.sort((left, right) => left.localeCompare(right))
		.map((name) => ({ name, value: "<redacted>" as const }));
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Scheme, host and path only.
 *
 * A URL is the one field where a credential needs no name to live: `?token=…` and `user:pass@host` both
 * work, so both are cut out along with the fragment. An unparsable URL is not repeated either — it
 * could hold anything.
 */
export function redactedUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return "<redacted>";
	}
	url.username = "";
	url.password = "";
	url.search = "";
	url.hash = "";
	return url.toString();
}

/** `--name=value` is redacted when the name reads like a credential; a bare token cannot be told apart. */
const SECRET_ARGUMENT_NAME = /(key|token|secret|password|passwd|credential|auth)/i;
const PAIRED_ARGUMENT = /^(-{0,2}[A-Za-z0-9_-]+)=(.+)$/;

export function redactedArgument(argument: string): string {
	const name = PAIRED_ARGUMENT.exec(argument)?.[1];
	if (name === undefined || !SECRET_ARGUMENT_NAME.test(name)) return argument;
	return `${name}=<redacted>`;
}
