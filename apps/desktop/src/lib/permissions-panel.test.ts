import assert from "node:assert/strict";
import test from "node:test";
import type { PermissionsView } from "@gentle-shell/protocol";
import { createPermissionsPanel } from "../state/permissions.ts";

function view(mode: "normal" | "auto" | "yolo" = "normal"): PermissionsView {
	return { state: "ok", reason: null, message: "", default: mode, stored: true, settable: ["normal", "auto"] };
}

type Request = { action: string; mode?: string };

function bridgeOver(answer: (request: Request) => Promise<PermissionsView>) {
	const seen: Request[] = [];
	return {
		seen,
		client: {
			permissions(request: Request): Promise<PermissionsView> {
				seen.push(request);
				return answer(request);
			},
		} as never,
	};
}

function panelOver(bridge: ReturnType<typeof bridgeOver>, steps: string[] = []) {
	return createPermissionsPanel({ connect: () => bridge.client, newThread: async () => void steps.push("new-thread") });
}

test("a refresh reads the default for new threads", async () => {
	const panel = panelOver(bridgeOver(async () => view("auto")));
	await panel.refresh();
	assert.equal(panel.view().data?.default, "auto");
});

test("lowering sets the default and then opens a thread that starts in it", async () => {
	const steps: string[] = [];
	const bridge = bridgeOver(async (request) => (request.action === "default" ? view("auto") : view("normal")));
	const panel = panelOver(bridge, steps);
	await panel.refresh();
	await panel.setDefault("auto");

	assert.deepEqual(bridge.seen[bridge.seen.length - 1], { action: "default", mode: "auto" });
	assert.deepEqual(steps, ["new-thread"]);
	assert.equal(panel.view().data?.default, "auto");
	assert.match(panel.view().notice ?? "", /auto/);
});

test("an elevated mode never reaches the bridge, and says where it is done instead", async () => {
	const steps: string[] = [];
	const bridge = bridgeOver(async () => view());
	const panel = panelOver(bridge, steps);
	await panel.setDefault("yolo");
	await panel.setDefault("super-yolo");

	assert.deepEqual(bridge.seen, [], "the request must not even be sent");
	assert.deepEqual(steps, []);
	assert.match(panel.view().error ?? "", /terminal/);
});

test("a refusal from the bridge is shown and no thread is opened", async () => {
	const steps: string[] = [];
	const panel = panelOver(
		bridgeOver(async () => {
			throw new Error("the permission preference is malformed");
		}),
		steps,
	);
	await panel.setDefault("auto");
	assert.match(panel.view().error ?? "", /malformed/);
	assert.deepEqual(steps, []);
	assert.equal(panel.view().busy, false);
});

test("no bridge is an error the person can read", async () => {
	const panel = createPermissionsPanel({ connect: () => null, newThread: async () => undefined });
	await panel.setDefault("auto");
	assert.match(panel.view().error ?? "", /not connected/);
});

test("a refusal leaves the default the bridge last reported on the chip", async () => {
	const steps: string[] = [];
	let refuse = false;
	const bridge = bridgeOver(async (request) => {
		if (request.action === "status") return view("auto");
		if (refuse) throw new Error("the permission preference at /c/mode.json is malformed or unreadable, so it was left alone");
		return view("normal");
	});
	const panel = panelOver(bridge, steps);
	await panel.refresh();
	refuse = true;
	await panel.setDefault("normal");

	assert.equal(panel.view().data?.default, "auto", "the value already on screen stays there");
	assert.match(panel.view().error ?? "", /malformed/);
	assert.equal(panel.view().notice, null);
	assert.deepEqual(steps, [], "a thread is only opened for a change that was applied");
	assert.equal(panel.view().busy, false, "the caller learns the attempt settled by awaiting, not by waiting for busy");
});

test("the panel reports the default the bridge read back, not the one that was asked for", async () => {
	const panel = panelOver(bridgeOver(async (request) => (request.action === "default" ? view("normal") : view("auto"))));
	await panel.refresh();
	await panel.setDefault("auto");

	assert.equal(panel.view().data?.default, "normal");
	assert.match(panel.view().notice ?? "", /normal/, "the notice names what the bridge now reports");
	assert.doesNotMatch(panel.view().notice ?? "", /auto/);
});

test("a write the bridge could not apply is a failure, not a new default", async () => {
	const steps: string[] = [];
	const bridge = bridgeOver(async (request) =>
		request.action === "default"
			? {
					state: "unavailable" as const,
					reason: "file-invalid" as const,
					message: "/c/mode.json is not a permission preference gentle-pi accepts, so it was left alone",
					default: null,
					stored: false,
					settable: ["normal", "auto"],
				}
			: view("auto"),
	);
	const panel = panelOver(bridge, steps);
	await panel.refresh();
	await panel.setDefault("normal");

	assert.match(panel.view().error ?? "", /gentle-pi accepts/);
	assert.equal(panel.view().notice, null);
	assert.deepEqual(steps, []);
	assert.equal(panel.view().data?.default, "auto", "the chip keeps the default it was showing");
	assert.equal(panel.view().busy, false);
});
