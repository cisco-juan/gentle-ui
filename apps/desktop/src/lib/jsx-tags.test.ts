import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const COMPONENTS = join(dirname(fileURLToPath(import.meta.url)), "..", "components");

/**
 * In Solid a capitalised JSX tag is a component call, so `const Tag = "ul"; <Tag>` compiles to
 * `createComponent("ul")` and throws "Comp is not a function" at render. One such tag inside a chat row
 * took the whole transcript down: every later update threw at the same row and nothing rendered again.
 * An element chosen at runtime needs `<Dynamic component={...}>` or explicit branches.
 */
test("no component renders a string held in a capitalised name as a JSX tag", () => {
	const offenders: string[] = [];
	for (const file of readdirSync(COMPONENTS).filter((name) => name.endsWith(".tsx"))) {
		// Comments explain the rule with the very code it forbids, so they are not code.
		const source = readFileSync(join(COMPONENTS, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
		for (const match of source.matchAll(/\b(?:const|let)\s+([A-Z]\w*)\s*=\s*([^;\n]+)/g)) {
			const [, name, value] = match;
			if (name === undefined || value === undefined) continue;
			// A quoted or templated lowercase name ("ul", `h${level}`) is an element name, not a component.
			const holdsTagName = /["'`][a-z]/.test(value) && !value.includes("=>");
			if (holdsTagName && new RegExp(`<${name}[\\s/>]`).test(source)) offenders.push(`${file}: <${name}> is the string ${value.trim()}`);
		}
	}
	assert.deepEqual(offenders, []);
});
