/**
 * Model resolution has one job that matters more than picking well: never
 * picking something that cannot run. A model ID that is wrong, or right for a
 * provider this user is not on, must degrade to inheriting rather than killing
 * the child at spawn. The precedence — config over definition over tier over
 * inherit — is asserted here because every layer of it is invisible at runtime.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type ModelChoice, qualify, resolveAgentModel } from "../lib/agents/model.ts";

const CATALOGUE: ModelChoice[] = [
	{ id: "opus", provider: "anthropic", cost: { input: 5, output: 25 } },
	{ id: "sonnet", provider: "anthropic", cost: { input: 3, output: 15 } },
	{ id: "haiku", provider: "anthropic", cost: { input: 1, output: 5 } },
	{ id: "grok-cheap", provider: "xai", cost: { input: 0.1, output: 0.5 } },
];

const SESSION = { id: "opus", provider: "anthropic" };

describe("resolveAgentModel", () => {
	test("inherits when nothing is asked for", () => {
		const choice = resolveAgentModel({}, undefined, CATALOGUE, SESSION);
		assert.equal(choice.model, undefined);
		assert.equal(choice.inheritThinking, true);
	});

	test("a cheap tier picks the cheapest model on the session's provider", () => {
		const choice = resolveAgentModel({ tier: "cheap" }, undefined, CATALOGUE, SESSION);
		assert.deepEqual(choice.model, { id: "haiku", provider: "anthropic" });
	});

	test("a cheap tier never crosses to another provider, however cheap", () => {
		const choice = resolveAgentModel({ tier: "cheap" }, undefined, CATALOGUE, SESSION);
		assert.notEqual(choice.model?.id, "grok-cheap");
	});

	test("a cheap child does not inherit the parent's thinking level", () => {
		const choice = resolveAgentModel({ tier: "cheap" }, undefined, CATALOGUE, SESSION);
		assert.equal(choice.inheritThinking, false);
	});

	test("a session already on the cheapest model inherits, keeping its thinking level", () => {
		const onHaiku = { id: "haiku", provider: "anthropic" };
		const choice = resolveAgentModel({ tier: "cheap" }, undefined, CATALOGUE, onHaiku);
		assert.equal(choice.model, undefined);
		assert.equal(choice.inheritThinking, true);
	});

	test("a cheap tier inherits when the provider offers nothing priced", () => {
		const unpriced: ModelChoice[] = [{ id: "local", provider: "mesh" }];
		const choice = resolveAgentModel({ tier: "cheap" }, undefined, unpriced, {
			id: "local",
			provider: "mesh",
		});
		assert.equal(choice.model, undefined);
	});

	test("config beats the definition's own model", () => {
		const choice = resolveAgentModel({ model: "sonnet" }, "haiku", CATALOGUE, SESSION);
		assert.deepEqual(choice.model, { id: "haiku", provider: "anthropic" });
	});

	test("config beats the tier", () => {
		const choice = resolveAgentModel({ tier: "cheap" }, "sonnet", CATALOGUE, SESSION);
		assert.deepEqual(choice.model, { id: "sonnet", provider: "anthropic" });
	});

	test("an unavailable configured model falls back to inheriting and says so", () => {
		const choice = resolveAgentModel({}, "gpt-9", CATALOGUE, SESSION);
		assert.equal(choice.model, undefined);
		assert.equal(choice.inheritThinking, true);
		assert.equal(choice.ignored, "gpt-9");
	});

	test("an unavailable configured model does not silently fall through to the tier", () => {
		const choice = resolveAgentModel({ tier: "cheap" }, "gpt-9", CATALOGUE, SESSION);
		assert.equal(choice.model, undefined, "a typo must not be answered with a surprise model");
		assert.equal(choice.ignored, "gpt-9");
	});

	test("a configured model on another provider is used when it is genuinely available", () => {
		const choice = resolveAgentModel({}, "grok-cheap", CATALOGUE, SESSION);
		assert.deepEqual(choice.model, { id: "grok-cheap", provider: "xai" });
		assert.equal(choice.ignored, undefined);
	});

	test("asking for the model already in use inherits its thinking level", () => {
		const choice = resolveAgentModel({}, "opus", CATALOGUE, SESSION);
		assert.deepEqual(choice.model, { id: "opus", provider: "anthropic" });
		assert.equal(choice.inheritThinking, true);
	});

	test("whitespace-only config is not a request", () => {
		const choice = resolveAgentModel({ tier: "cheap" }, "   ", CATALOGUE, SESSION);
		assert.deepEqual(choice.model, { id: "haiku", provider: "anthropic" });
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
		const choice = resolveAgentModel({ tier: "cheap" }, undefined, ambiguous, SESSION);
		assert.equal(qualify(choice.model as ModelChoice), "anthropic/haiku");
	});

	test("a provider-qualified config entry is accepted", () => {
		const choice = resolveAgentModel({}, "xai/grok-cheap", CATALOGUE, SESSION);
		assert.deepEqual(choice.model, { id: "grok-cheap", provider: "xai" });
	});

	test("a qualified entry naming the wrong provider is not accepted", () => {
		const choice = resolveAgentModel({}, "anthropic/grok-cheap", CATALOGUE, SESSION);
		assert.equal(choice.model, undefined);
		assert.equal(choice.ignored, "anthropic/grok-cheap");
	});

	test("an empty catalogue inherits rather than throwing", () => {
		const choice = resolveAgentModel({ tier: "cheap" }, "haiku", [], SESSION);
		assert.equal(choice.model, undefined);
	});

	test("no session means no provider to be cheap on", () => {
		const choice = resolveAgentModel({ tier: "cheap" }, undefined, CATALOGUE, undefined);
		assert.equal(choice.model, undefined);
	});

	test("ties break on id, so the choice does not wander between runs", () => {
		const tied: ModelChoice[] = [
			{ id: "b-model", provider: "anthropic", cost: { input: 1, output: 1 } },
			{ id: "a-model", provider: "anthropic", cost: { input: 1, output: 1 } },
		];
		assert.equal(resolveAgentModel({ tier: "cheap" }, undefined, tied, SESSION).model?.id, "a-model");
		assert.equal(
			resolveAgentModel({ tier: "cheap" }, undefined, [...tied].reverse(), SESSION).model?.id,
			"a-model",
		);
	});
});
