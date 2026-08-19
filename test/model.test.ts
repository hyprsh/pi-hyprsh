/**
 * Model resolution has one job that matters more than picking well: never
 * picking something that cannot run. A model ID that is wrong, or right for a
 * provider this user is not on, must degrade to inheriting rather than killing
 * the child at spawn. The request comes from an agent definition, which may be
 * a hand-written file in ~/.pi/agent/hypr/agents, so none of it is trusted.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CHEAPEST, type ModelChoice, qualify, resolveAgentModel } from "../lib/agents/model.ts";

const CATALOGUE: ModelChoice[] = [
	{ id: "opus", provider: "anthropic", cost: { input: 5, output: 25 } },
	{ id: "sonnet", provider: "anthropic", cost: { input: 3, output: 15 } },
	{ id: "haiku", provider: "anthropic", cost: { input: 1, output: 5 } },
	{ id: "grok-cheap", provider: "xai", cost: { input: 0.1, output: 0.5 } },
];

const SESSION = { id: "opus", provider: "anthropic" };

describe("resolveAgentModel", () => {
	test("inherits when nothing is asked for", () => {
		const choice = resolveAgentModel({}, CATALOGUE, SESSION);
		assert.equal(choice.model, undefined);
		assert.equal(choice.inheritThinking, true);
	});

	test("cheapest picks the cheapest model on the session's provider", () => {
		const choice = resolveAgentModel({ model: CHEAPEST }, CATALOGUE, SESSION);
		assert.deepEqual(choice.model, { id: "haiku", provider: "anthropic" });
	});

	test("cheapest never crosses to another provider, however cheap", () => {
		const choice = resolveAgentModel({ model: CHEAPEST }, CATALOGUE, SESSION);
		assert.notEqual(choice.model?.id, "grok-cheap");
	});

	test("a cheap child does not inherit the parent's thinking level", () => {
		const choice = resolveAgentModel({ model: CHEAPEST }, CATALOGUE, SESSION);
		assert.equal(choice.inheritThinking, false);
	});

	test("a session already on the cheapest model keeps its thinking level", () => {
		const onHaiku = { id: "haiku", provider: "anthropic" };
		const choice = resolveAgentModel({ model: CHEAPEST }, CATALOGUE, onHaiku);
		// Landing back on the session's own model is not a downgrade, so there is
		// nothing to protect the child from and its effort setting still applies.
		assert.deepEqual(choice.model, onHaiku);
		assert.equal(choice.inheritThinking, true);
	});

	test("cheapest inherits when the provider offers nothing priced", () => {
		const unpriced: ModelChoice[] = [{ id: "local", provider: "mesh" }];
		const choice = resolveAgentModel({ model: CHEAPEST }, unpriced, {
			id: "local",
			provider: "mesh",
		});
		assert.equal(choice.model, undefined);
	});

	test("a named model is used as named", () => {
		const choice = resolveAgentModel({ model: "sonnet" }, CATALOGUE, SESSION);
		assert.deepEqual(choice.model, { id: "sonnet", provider: "anthropic" });
	});

	test("an unavailable model falls back to inheriting and says so", () => {
		const choice = resolveAgentModel({ model: "gpt-9" }, CATALOGUE, SESSION);
		assert.equal(choice.model, undefined, "a typo must not be answered with a surprise model");
		assert.equal(choice.inheritThinking, true);
		assert.equal(choice.ignored, "gpt-9");
	});

	test("a model on another provider is used when it is genuinely available", () => {
		const choice = resolveAgentModel({ model: "grok-cheap" }, CATALOGUE, SESSION);
		assert.deepEqual(choice.model, { id: "grok-cheap", provider: "xai" });
		assert.equal(choice.ignored, undefined);
	});

	test("asking for the model already in use inherits its thinking level", () => {
		const choice = resolveAgentModel({ model: "opus" }, CATALOGUE, SESSION);
		assert.deepEqual(choice.model, { id: "opus", provider: "anthropic" });
		assert.equal(choice.inheritThinking, true);
	});

	test("a whitespace-only model line is not a request", () => {
		const choice = resolveAgentModel({ model: "   " }, CATALOGUE, SESSION);
		assert.equal(choice.model, undefined);
		assert.equal(choice.ignored, undefined);
	});

	// 221 of the 1267 models pi ships are offered by more than one provider. pi's
	// CLI only rescues a bare ambiguous ID when exactly one matching provider is
	// authenticated; with two it errors and the child dies at spawn.
	test("a resolved model always carries its provider, so the spawn is unambiguous", () => {
		const ambiguous: ModelChoice[] = [
			{ id: "haiku", provider: "anthropic", cost: { input: 1, output: 5 } },
			{ id: "haiku", provider: "cloudflare", cost: { input: 1, output: 5 } },
		];
		const choice = resolveAgentModel({ model: CHEAPEST }, ambiguous, SESSION);
		assert.equal(qualify(choice.model as ModelChoice), "anthropic/haiku");
	});

	test("a provider-qualified entry is accepted", () => {
		const choice = resolveAgentModel({ model: "xai/grok-cheap" }, CATALOGUE, SESSION);
		assert.deepEqual(choice.model, { id: "grok-cheap", provider: "xai" });
	});

	test("a qualified entry naming the wrong provider is not accepted", () => {
		const choice = resolveAgentModel({ model: "anthropic/grok-cheap" }, CATALOGUE, SESSION);
		assert.equal(choice.model, undefined);
		assert.equal(choice.ignored, "anthropic/grok-cheap");
	});

	// Omitting --thinking gives the user's global defaultThinkingLevel, not the
	// model's own, so an agent that wants a short leash has to say so. The two
	// axes are independent: a cheap model does not imply cheap thinking.
	test("asking for the cheapest model says nothing about thinking", () => {
		const choice = resolveAgentModel({ model: CHEAPEST }, CATALOGUE, SESSION);
		assert.deepEqual(choice.model, { id: "haiku", provider: "anthropic" });
		assert.equal(choice.thinking, undefined);
	});

	test("a thinking level applies alongside a chosen model", () => {
		const choice = resolveAgentModel({ model: CHEAPEST, thinking: "medium" }, CATALOGUE, SESSION);
		assert.deepEqual(choice.model, { id: "haiku", provider: "anthropic" });
		assert.equal(choice.thinking, "medium");
	});

	test("thinking can be set without touching the model", () => {
		const choice = resolveAgentModel({ thinking: "off" }, CATALOGUE, SESSION);
		assert.equal(choice.model, undefined, "the child still inherits the session's model");
		assert.equal(choice.thinking, "off");
		assert.equal(choice.inheritThinking, false);
	});

	test("a thinking level survives a model that had to be dropped", () => {
		const choice = resolveAgentModel({ model: "gpt-9", thinking: "low" }, CATALOGUE, SESSION);
		assert.equal(choice.ignored, "gpt-9");
		assert.equal(choice.thinking, "low");
	});

	test("an empty catalogue inherits rather than throwing", () => {
		const choice = resolveAgentModel({ model: "haiku" }, [], SESSION);
		assert.equal(choice.model, undefined);
	});

	test("no session means no provider to be cheap on", () => {
		const choice = resolveAgentModel({ model: CHEAPEST }, CATALOGUE, undefined);
		assert.equal(choice.model, undefined);
	});

	test("ties break on id, so the choice does not wander between runs", () => {
		const tied: ModelChoice[] = [
			{ id: "b-model", provider: "anthropic", cost: { input: 1, output: 1 } },
			{ id: "a-model", provider: "anthropic", cost: { input: 1, output: 1 } },
		];
		assert.equal(resolveAgentModel({ model: CHEAPEST }, tied, SESSION).model?.id, "a-model");
		assert.equal(resolveAgentModel({ model: CHEAPEST }, [...tied].reverse(), SESSION).model?.id, "a-model");
	});
});
