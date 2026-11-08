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
