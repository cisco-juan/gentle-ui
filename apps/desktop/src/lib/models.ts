/**
 * The parameters of Pi's `set_model`.
 *
 * Pi finds the model with `command.provider` and `command.modelId`; any other key leaves `modelId`
 * undefined and the answer is "Model not found", so the name of the key is the whole contract.
 */
export function setModelParams(provider: string, modelId: string): { provider: string; modelId: string } {
	return { provider, modelId };
}
