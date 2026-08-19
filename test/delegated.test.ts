/**
 * Delegation attribution is a claim about tokens that are not here, so nothing
 * in the running system can contradict it. These tests are the only thing
 * standing between a plausible number and a wrong one.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { formatDelegated } from "../lib/context/ui/usage-view.ts";
import { computeUsage } from "../lib/context/usage.ts";
import { replayDelegated } from "../lib/task/delegated.ts";

let counter = 0;

function taskResult(runs: unknown, text = "x".repeat(400)): SessionEntry {
	counter++;
	return {
		type: "message",
		id: `entry-${counter}`,
		parentId: null,
		timestamp: new Date(counter * 1000).toISOString(),
		message: {
			role: "toolResult",
			toolCallId: `call-${counter}`,
			toolName: "task",
			content: [{ type: "text", text }],
			details: { runs },
			isError: false,
			timestamp: counter * 1000,
		},
	} as SessionEntry;
}

function otherResult(): SessionEntry {
	const entry = taskResult([{ contextTokens: 999_999 }]) as { message: { toolName: string } };
	entry.message.toolName = "read";
	return entry as SessionEntry;
}

describe("replayDelegated", () => {
	test("a branch with no dispatch has nothing to attribute", () => {
		assert.equal(replayDelegated([]), undefined);
		assert.equal(replayDelegated([otherResult()]), undefined);
	});

	test("units and child context sum across every dispatch on the branch", () => {
		const delegated = replayDelegated([
			taskResult([{ contextTokens: 40_000 }, { contextTokens: 20_000 }]),
			otherResult(),
			taskResult([{ contextTokens: 12_000 }]),
		]);
		assert.equal(delegated?.units, 3);
		assert.equal(delegated?.contextTokens, 72_000);
	});

	test("what came back is counted too, so the saving is never shown alone", () => {
		const delegated = replayDelegated([taskResult([{ contextTokens: 40_000 }], "y".repeat(400))]);
		assert.ok((delegated?.resultTokens ?? 0) > 0, "a 400-character result cannot cost zero tokens");
		assert.ok(
			(delegated?.resultTokens ?? 0) < 40_000,
			"the result is the summary, not the child's whole window",
		);
	});

	test("a result from an older version of the pack counts its units, not phantom tokens", () => {
		const delegated = replayDelegated([taskResult([{ name: "Look" }, { name: "Check" }])]);
		assert.equal(delegated?.units, 2);
		assert.equal(delegated?.contextTokens, 0);
	});

	test("a failed unit still read on its own budget, so it still counts", () => {
		const delegated = replayDelegated([taskResult([{ contextTokens: 8000, failure: "died" }])]);
		assert.equal(delegated?.units, 1);
		assert.equal(delegated?.contextTokens, 8000);
	});

	test("details that are not a run list are ignored rather than guessed at", () => {
		assert.equal(replayDelegated([taskResult(undefined)]), undefined);
		assert.equal(replayDelegated([taskResult([])]), undefined);
		assert.equal(replayDelegated([taskResult("runs")]), undefined);
		assert.equal(replayDelegated([taskResult([null])]), undefined);
	});
});

describe("computeUsage", () => {
	test("carries the delegated figure without letting it into the window's own total", () => {
		const usage = computeUsage({
			snapshot: { groups: [], totalTokens: 0 },
			messages: [],
			delegated: { units: 2, contextTokens: 60_000, resultTokens: 1200 },
		});
		assert.equal(usage.delegated?.contextTokens, 60_000);
		assert.equal(usage.estimatedTokens, 0, "tokens read elsewhere are not tokens in this window");
		assert.deepEqual(usage.categories, [], "delegation is not a category on the map");
	});
});

describe("formatDelegated", () => {
	test("states both sides and the ratio between them", () => {
		const line = formatDelegated({ units: 3, contextTokens: 72_000, resultTokens: 1500 });
		assert.match(line, /3 delegated units/);
		assert.match(line, /read elsewhere/);
		assert.match(line, /returned here/);
		assert.match(line, /48× kept out/);
	});

	test("one unit is not pluralised", () => {
		assert.match(
			formatDelegated({ units: 1, contextTokens: 10_000, resultTokens: 1000 }),
			/1 delegated unit:/,
		);
	});

	test("a small ratio keeps a decimal rather than rounding to a flattering integer", () => {
		assert.match(formatDelegated({ units: 1, contextTokens: 1500, resultTokens: 1000 }), /1\.5× kept out/);
	});

	test("no ratio is claimed when there is nothing to divide", () => {
		const line = formatDelegated({ units: 1, contextTokens: 0, resultTokens: 500 });
		assert.doesNotMatch(line, /kept out/);
	});
});
