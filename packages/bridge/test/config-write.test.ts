// The reusable write foundation: a plan the UI can show, and an apply that performs exactly that plan.
//
// Nothing in this file is about Pi. The module under test knows a target file, a change function and a
// digest, so the rules a settings writer must never break are proven here without any family in the
// way: a preview writes nothing at all, an apply without the digest the confirmation showed is refused,
// an apply of a plan that was already used is refused, a file that changed after the preview is never
// overwritten, and a file that cannot be read or parsed is left exactly as it was.
//
// Every test works on real files in scratch homes under the temp directory. Nothing is mocked.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
	ConfigWriteError,
	configApply,
	configPreview,
	planDigest,
	type ConfigFileState,
	type ConfigWriteRequest,
} from "../src/config-write.ts";

interface Scratch {
	readonly root: string;
	readonly configHome: string;
	readonly agentHome: string;
	/** `<agentHome>/settings.json`, the target this file's generic requests write. */
	readonly path: string;
}

const scratchRoots: string[] = [];
after(() => {
	for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
});

function scratch(): Scratch {
	const root = mkdtempSync(join(tmpdir(), "gentle-config-write-"));
	scratchRoots.push(root);
	const configHome = join(root, "config");
	const agentHome = join(root, "agent");
	for (const dir of [configHome, agentHome]) mkdirSync(dir, { recursive: true });
	return { root, configHome, agentHome, path: join(agentHome, "settings.json") };
}

/** Every file under `dir` with its bytes, so "wrote nothing" is a comparison, not a claim. */
function snapshot(dir: string): Map<string, string> {
	const files = new Map<string, string>();
	const walk = (current: string): void => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) {
				files.set(`${relative(dir, path)}/`, "");
				walk(path);
			} else {
				files.set(relative(dir, path), readFileSync(path, "utf8"));
			}
		}
	};
	walk(dir);
	return files;
}

function sourcesIn(current: ConfigFileState): string[] {
	const raw = current.value?.["packages"];
	return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : [];
}

/** A generic request: append one source to `packages`, the smallest change a family could ask for. */
function adding(path: string, source: string): ConfigWriteRequest {
	return {
		operation: "packages.install",
		family: "settings",
		path,
		change: (current) => ({
			next: { ...(current.value ?? {}), packages: [...sourcesIn(current), source] },
			summary: [`packages: add ${JSON.stringify(source)}`],
		}),
	};
}

/** A refusal is a typed reason plus a message; a caller never has to read the text to know why. */
function refusal(reason: string): (error: unknown) => boolean {
	return (error) => error instanceof ConfigWriteError && error.reason === reason;
}

test("a preview computes the plan and its digest and writes nothing at all", async () => {
	const s = scratch();
	const original = `{\n    "defaultProvider": "anthropic",\n    "packages": []\n}\n`;
	writeFileSync(s.path, original);
	const before = [snapshot(s.agentHome), snapshot(s.configHome)];

	const preview = await configPreview(adding(s.path, "npm:gentle-plain"));

	assert.equal(preview.plan.operation, "packages.install");
	assert.equal(preview.plan.target, s.path);
	assert.equal(preview.plan.before, original);
	assert.deepEqual(JSON.parse(preview.plan.after), { defaultProvider: "anthropic", packages: ["npm:gentle-plain"] });
	assert.match(preview.digest, /^[0-9a-f]{64}$/);
	assert.deepEqual(preview.summary, ['packages: add "npm:gentle-plain"']);

	// Byte for byte: no settings file touched, no backup folder, no temp file, no lock left behind.
	assert.deepEqual([snapshot(s.agentHome), snapshot(s.configHome)], before);
});

test("the digest covers the whole plan: the same plan repeats it, any other plan changes it", async () => {
	const s = scratch();
	writeFileSync(s.path, `{\n  "packages": []\n}\n`);

	const first = await configPreview(adding(s.path, "npm:one"));
	const second = await configPreview(adding(s.path, "npm:one"));
	const other = await configPreview(adding(s.path, "npm:two"));

	assert.equal(first.digest, second.digest, "one plan, one digest");
	assert.notEqual(first.digest, other.digest, "a different source is a different plan");
	// The digest is a sha256 over the canonical plan, so an independent hashing of the same four
	// fields must agree with it.
	assert.equal(
		planDigest({ after: first.plan.after, before: first.plan.before, operation: "packages.install", target: s.path }),
		first.digest,
	);
	assert.notEqual(planDigest({ ...first.plan, target: `${s.path}.other` }), first.digest);
});

test("an apply without the digest the confirmation showed is refused and nothing is written", async () => {
	const s = scratch();
	const original = `{\n  "packages": []\n}\n`;
	writeFileSync(s.path, original);

	for (const digest of [undefined, "", "   ", 42]) {
		await assert.rejects(() => configApply(adding(s.path, "npm:x"), digest, { configHome: s.configHome }), /digest/);
		assert.equal(readFileSync(s.path, "utf8"), original);
	}
	assert.deepEqual(readdirSync(s.agentHome), ["settings.json"]);
});

test("an apply whose digest does not match the recomputed plan is refused as a stale plan", async () => {
	const s = scratch();
	const original = `{\n  "packages": []\n}\n`;
	writeFileSync(s.path, original);

	const preview = await configPreview(adding(s.path, "npm:one"));
	// The UI confirmed "npm:one" and the caller sends something else: the plan is not the confirmed one.
	await assert.rejects(
		() => configApply(adding(s.path, "npm:two"), preview.digest, { configHome: s.configHome }),
		refusal("stale-plan"),
	);
	// A digest this process never previewed is refused the same way.
	await assert.rejects(
		() => configApply(adding(s.path, "npm:one"), "0".repeat(64), { configHome: s.configHome }),
		refusal("stale-plan"),
	);
	assert.equal(readFileSync(s.path, "utf8"), original);
});

test("an apply after the file changed on disk is refused and the file is left untouched", async () => {
	const s = scratch();
	writeFileSync(s.path, `{\n  "packages": []\n}\n`);
	const preview = await configPreview(adding(s.path, "npm:one"));

	// The terminal, or Pi itself, wrote the file between the confirmation and the apply.
	const changed = `{\n  "packages": ["npm:from-the-terminal"]\n}\n`;
	writeFileSync(s.path, changed);

	await assert.rejects(() => configApply(adding(s.path, "npm:one"), preview.digest, { configHome: s.configHome }), refusal("changed-on-disk"));
	assert.equal(readFileSync(s.path, "utf8"), changed, "the newer content wins; nothing is overwritten");
	assert.deepEqual(readdirSync(s.agentHome), ["settings.json"], "nothing was written and nothing was left behind");
});

test("a successful apply writes the entry, keeps a backup, and preserves indentation and final newline", async () => {
	const s = scratch();
	const original = `{\n    "defaultProvider": "anthropic",\n    "packages": []\n}\n`;
	writeFileSync(s.path, original);
	const preview = await configPreview(adding(s.path, "npm:gentle-plain"));

	const applied = await configApply(adding(s.path, "npm:gentle-plain"), preview.digest, { configHome: s.configHome });

	const written = readFileSync(s.path, "utf8");
	assert.deepEqual(JSON.parse(written), { defaultProvider: "anthropic", packages: ["npm:gentle-plain"] });
	assert.equal(written, preview.plan.after, "the file is exactly the plan that was confirmed");
	assert.match(written, /\n {4}"defaultProvider"/, "the file's own indentation is kept");
	assert.ok(written.endsWith("\n"), "the file's final newline is kept");
	assert.equal(statSync(s.path).mode & 0o777, 0o600, "the file is private");
	assert.deepEqual(readdirSync(s.agentHome), ["settings.json"], "the write is atomic: no temp file survives");

	// The previous bytes are kept, in this family's own folder.
	const backups = readdirSync(join(s.configHome, "settings-backups"));
	assert.equal(backups.length, 1);
	assert.match(backups[0] ?? "", /^settings\..+\.json$/);
	assert.equal(applied.backup, join(s.configHome, "settings-backups", backups[0] ?? ""));
	assert.equal(readFileSync(applied.backup ?? "", "utf8"), original);
});

test("a first write keeps no backup, a repeat of our own bytes keeps none either, and an outside change does", async () => {
	const s = scratch();
	const first = await configPreview(adding(s.path, "npm:one"));
	const appliedFirst = await configApply(adding(s.path, "npm:one"), first.digest, { configHome: s.configHome });
	assert.equal(appliedFirst.backup, null, "a file that did not exist has nothing to keep");
	assert.ok(!existsIn(s.configHome, "settings-backups"), "no backup folder is created for nothing");

	// A second write whose "before" is exactly what this process wrote needs no backup: it would only
	// duplicate our own work.
	const second = await configPreview(adding(s.path, "npm:two"));
	const appliedSecond = await configApply(adding(s.path, "npm:two"), second.digest, { configHome: s.configHome });
	assert.equal(appliedSecond.backup, null);

	// A change made outside this process is kept before it is replaced.
	const outside = `{\n  "packages": ["npm:from-the-terminal"]\n}\n`;
	writeFileSync(s.path, outside);
	const third = await configPreview(adding(s.path, "npm:three"));
	const appliedThird = await configApply(adding(s.path, "npm:three"), third.digest, { configHome: s.configHome });
	assert.notEqual(appliedThird.backup, null);
	assert.equal(readFileSync(appliedThird.backup ?? "", "utf8"), outside);
});

function existsIn(dir: string, name: string): boolean {
	try {
		return readdirSync(dir).includes(name);
	} catch {
		return false;
	}
}

test("applying the same digest twice fails the second time and leaves the first result", async () => {
	const s = scratch();
	writeFileSync(s.path, `{\n  "packages": []\n}\n`);
	const preview = await configPreview(adding(s.path, "npm:one"));

	await configApply(adding(s.path, "npm:one"), preview.digest, { configHome: s.configHome });
	const afterFirst = readFileSync(s.path, "utf8");

	await assert.rejects(() => configApply(adding(s.path, "npm:one"), preview.digest, { configHome: s.configHome }), refusal("stale-plan"));
	assert.equal(readFileSync(s.path, "utf8"), afterFirst);
});

test("a target that is not JSON is unavailable, and is never replaced by the plan", async () => {
	for (const text of ["{not json", "[]", "null", '"settings"', "{"]) {
		const s = scratch();
		writeFileSync(s.path, text);

		await assert.rejects(() => configPreview(adding(s.path, "npm:one")), refusal("file-invalid"));
		await assert.rejects(
			() => configApply(adding(s.path, "npm:one"), "0".repeat(64), { configHome: s.configHome }),
			refusal("file-invalid"),
		);
		assert.equal(readFileSync(s.path, "utf8"), text, "a file this cannot read is left alone");
		assert.deepEqual(readdirSync(s.agentHome), ["settings.json"]);
	}
});

test("a target that cannot be read at all is unavailable, not created over", async () => {
	const s = scratch();
	// A directory where the settings file belongs: reading it fails, and nothing may be written there.
	mkdirSync(s.path);

	await assert.rejects(() => configPreview(adding(s.path, "npm:one")), refusal("file-invalid"));
	assert.deepEqual(readdirSync(s.agentHome), ["settings.json"]);
});
