/**
 * The run header is the only place a caller learns which model a child used.
 * The case worth protecting is the quiet one: a configured model that was not
 * available is dropped in favour of inheriting, and without a word in the
 * header that decision is invisible and looks like the config never applied.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentRun } from "../lib/agents/types.ts";
import { emptyUsage } from "../lib/agents/types.ts";
import { formatRuns } from "../lib/task/render.ts";

function run(overrides: Partial<AgentRun> = {}): AgentRun {
	return {
		name: "Look",
		agent: "scout",
		verdict: "pass",
		report: "found it",
		evidence: { changed: [], commands: ["ls"] },
		usage: emptyUsage(),
		turns: 1,
		exitCode: 0,
		ms: 1200,
		...overrides,
	};
}

const NONE = new Set<string>();

describe("formatRuns", () => {
	test("stays quiet when the child ran on the session's model", () => {
		const text = formatRuns([run({ model: "anthropic/opus" })], NONE, "anthropic/opus");
		assert.match(text, /### Look \(scout\) — pass in 1\.2s\n/);
	});

	test("names the model when the child ran on a different one", () => {
		const text = formatRuns([run({ model: "anthropic/haiku" })], NONE, "anthropic/opus");
		assert.match(text, /pass in 1\.2s on anthropic\/haiku/);
	});

	test("says so when a configured model was dropped", () => {
		const text = formatRuns(
			[run({ model: "anthropic/opus", ignoredModel: "typo-4" })],
			NONE,
			"anthropic/opus",
		);
		assert.match(text, /on anthropic\/opus \(configured typo-4 is unavailable\)/);
	});

	test("keeps the caller's verdict and the observed evidence apart", () => {
		const text = formatRuns([run({ verdict: "pass", evidence: { changed: ["a.ts"], commands: [] } })], NONE);
		assert.match(text, /Observed: changed: a\.ts/);
		assert.match(text, /1\/1 units report pass/);
		assert.match(text, /the child's own claim/);
	});

	test("a failed run shows the failure instead of a report", () => {
		const text = formatRuns([run({ failure: "spawn failed" })], NONE);
		assert.match(text, /— failed in 1\.2s/);
		assert.match(text, /spawn failed/);
		assert.doesNotMatch(text, /found it/);
	});

	test("still-running units are listed and suppress the trailer", () => {
		const text = formatRuns([], new Set(["Alpha"]));
		assert.match(text, /still running: Alpha/);
		assert.doesNotMatch(text, /units report pass/);
	});
});
