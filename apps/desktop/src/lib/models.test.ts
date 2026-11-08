import assert from "node:assert/strict";
import test from "node:test";
import { setModelParams } from "./models.ts";

test("a model switch names the model with the key Pi reads", () => {
	// Pi's set_model looks up `command.modelId`; `model` made every switch fail with "Model not found".
	assert.deepEqual(setModelParams("anthropic", "claude-opus-5-5"), { provider: "anthropic", modelId: "claude-opus-5-5" });
});
