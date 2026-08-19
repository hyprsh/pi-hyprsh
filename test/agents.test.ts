/**
 * Everything a caller believes about a child passes through these three:
 * whether it stated a verdict, whether its spend was counted, and whether the
 * run is worth accepting. Each fails silently — a missed verdict reads as
 * `unknown`, dropped usage reads as free work — so each is pinned here.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import { agentDefinitions } from "../lib/agents/definitions.ts";
import { readVerdict, stripVerdict } from "../lib/agents/run.ts";
import { type AgentRun, addUsage, emptyUsage, succeeded } from "../lib/agents/types.ts";

type UsageOverrides = Omit<Partial<Usage>, "cost"> & { cost?: Partial<Usage["cost"]> };

function usage(overrides: UsageOverrides = {}): Usage {
	const base = emptyUsage();
	return { ...base, ...overrides, cost: { ...base.cost, ...overrides.cost } };
}

function run(overrides: Partial<AgentRun> = {}): AgentRun {
	return {
		name: "One",
		agent: "worker",
		verdict: "pass",
		report: "done",
		evidence: { changed: [], commands: [] },
		usage: emptyUsage(),
		turns: 1,
		exitCode: 0,
		ms: 10,
		...overrides,
	};
}

describe("readVerdict", () => {
	test("reads the verdict off the last line", () => {
		assert.equal(readVerdict("I did the work.\n\nVERDICT: PASS"), "pass");
	});

	test("is case-insensitive", () => {
		assert.equal(readVerdict("verdict: issues"), "issues");
		assert.equal(readVerdict("Verdict: Blocked"), "blocked");
	});

	test("tolerates surrounding whitespace", () => {
		assert.equal(readVerdict("work\n   VERDICT:   PASS   \n"), "pass");
	});

	test("a report with no verdict is unknown, not a failure", () => {
		assert.equal(readVerdict("I did the work and said nothing else."), "unknown");
	});

	test("a verdict word inside a sentence is not a verdict", () => {
		assert.equal(readVerdict("The VERDICT: PASS marker goes at the end."), "unknown");
	});

	test("an unrecognised verdict word is unknown", () => {
		assert.equal(readVerdict("VERDICT: MAYBE"), "unknown");
	});

	test("the first verdict line wins", () => {
		assert.equal(readVerdict("VERDICT: ISSUES\nmore\nVERDICT: PASS"), "issues");
	});
});

describe("stripVerdict", () => {
	test("removes the marker and the blank line it left behind", () => {
		assert.equal(stripVerdict("I did the work.\n\nVERDICT: PASS\n"), "I did the work.");
	});

	test("leaves a report without a verdict untouched", () => {
		assert.equal(stripVerdict("I did the work."), "I did the work.");
	});
});

describe("addUsage", () => {
	test("accumulates totals and nested cost together", () => {
		const total = addUsage(
			usage({ input: 10, totalTokens: 30, cost: { input: 0.5, total: 1.5 } }),
			usage({ input: 5, output: 2, totalTokens: 7, cost: { input: 0.25, total: 0.75 } }),
		);
		assert.equal(total.input, 15);
		assert.equal(total.output, 2);
		assert.equal(total.totalTokens, 37);
		assert.equal(total.cost.input, 0.75);
		assert.equal(total.cost.total, 2.25);
	});

	test("an undefined addend leaves the total alone", () => {
		const before = usage({ input: 10, cost: { total: 1 } });
		assert.deepEqual(addUsage(before, undefined), before);
	});

	test("a child reporting no cost does not erase the running cost", () => {
		const partial = { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 4 } as Usage;
		const total = addUsage(usage({ cost: { total: 2 } }), partial);
		assert.equal(total.input, 3);
		assert.equal(total.cost.total, 2);
	});

	test("summing an empty fan-out gives zero, not NaN", () => {
		const total = [].reduce<Usage>((into, add) => addUsage(into, add), emptyUsage());
		assert.deepEqual(total, emptyUsage());
	});
});

describe("agentDefinitions", () => {
	// lib/task classifies a child as a writer by this exact test, and only writers
	// are serialised. An agent that gains `write` without gaining `edit`, or a new
	// writing agent altogether, must not slip through as read-only.
	test("an agent that can edit can also write", () => {
		for (const agent of agentDefinitions()) {
			if (agent.tools.includes("edit")) assert.ok(agent.tools.includes("write"), agent.name);
		}
	});

	test("every definition on disk parses and names its tools", () => {
		const names = agentDefinitions().map((agent) => agent.name);
		assert.deepEqual([...names].sort(), ["reviewer", "scout", "worker"]);
	});

	test("worker is the only agent that writes", () => {
		const writers = agentDefinitions()
			.filter((agent) => agent.tools.includes("write"))
			.map((agent) => agent.name);
		assert.deepEqual(writers, ["worker"]);
	});
});

describe("succeeded", () => {
	test("accepts a clean pass", () => {
		assert.equal(succeeded(run()), true);
	});

	test("rejects a pass that also carries a failure", () => {
		assert.equal(succeeded(run({ failure: "spawn failed" })), false);
	});

	test("rejects a nonzero exit however the child described itself", () => {
		assert.equal(succeeded(run({ exitCode: 1 })), false);
	});

	test("rejects a child that never stated a verdict", () => {
		assert.equal(succeeded(run({ verdict: "unknown" })), false);
	});
});
