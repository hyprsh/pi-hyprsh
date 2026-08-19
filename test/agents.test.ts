/**
 * Everything a caller believes about a child passes through these three:
 * whether it stated a verdict, whether its spend was counted, and whether the
 * run is worth accepting. Each fails silently — a missed verdict reads as
 * `unknown`, dropped usage reads as free work — so each is pinned here.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import { type AgentDefinition, loadAgentDefinitions, writes } from "../lib/agents/definitions.ts";
import { CHEAPEST } from "../lib/agents/model.ts";
import { readVerdict, recordEvidence, stripVerdict } from "../lib/agents/run.ts";
import { type AgentRun, addUsage, type Evidence, emptyUsage, succeeded } from "../lib/agents/types.ts";

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

/**
 * The packaged roster only. `agentDefinitions()` layers whatever is in the
 * developer's own ~/.pi/agent/hypr/agents over it, so asserting the shipped
 * agents through it would pass or fail on a machine's contents rather than the
 * repository's.
 */
const packaged = () => loadAgentDefinitions(join(tmpdir(), "hyprsh-no-user-agents"));

describe("packaged agent definitions", () => {
	// lib/task classifies a child as a writer by this exact test, and only writers
	// are serialised. An agent that gains `write` without gaining `edit`, or a new
	// writing agent altogether, must not slip through as read-only.
	test("an agent that can edit can also write", () => {
		for (const agent of packaged()) {
			if (agent.tools.includes("edit")) assert.ok(agent.tools.includes("write"), agent.name);
		}
	});

	test("every definition on disk parses and names its tools", () => {
		const names = packaged().map((agent) => agent.name);
		assert.deepEqual([...names].sort(), ["reviewer", "scout", "worker"]);
	});

	test("scout asks for the cheapest model; the writing agent does not", () => {
		const models = Object.fromEntries(packaged().map((agent) => [agent.name, agent.model]));
		assert.equal(models.scout, CHEAPEST);
		assert.equal(models.worker, undefined, "a weaker model must not be writing the code");
		assert.equal(models.reviewer, undefined, "a weaker model must not be judging the work");
	});

	test("worker is the only agent that writes", () => {
		const writers = packaged()
			.filter(writes)
			.map((agent) => agent.name);
		assert.deepEqual(writers, ["worker"]);
	});

	// Omitting --thinking leaves the child on the user's own global level, which
	// is the right default: measured on a scout task, low and high produced 311
	// and 328 reasoning tokens, so a shipped level would have bought nothing.
	test("no shipped agent pins a thinking level", () => {
		for (const agent of packaged()) assert.equal(agent.thinking, undefined, agent.name);
	});
});

/**
 * ~/.pi/agent/hypr/agents is the only way to change a shipped agent without
 * editing a packaged file that the next update overwrites. A file there stands
 * in for the packaged agent whole, so nothing about a dispatch depends on a
 * merge the reader cannot see.
 */
describe("loadAgentDefinitions", () => {
	function userDir(files: Record<string, string>): string {
		const dir = mkdtempSync(join(tmpdir(), "hyprsh-agents-"));
		for (const [name, contents] of Object.entries(files)) {
			writeFileSync(join(dir, name), contents, "utf-8");
		}
		return dir;
	}

	const byName = (agents: ReturnType<typeof loadAgentDefinitions>, name: string) =>
		agents.find((agent) => agent.name === name);

	test("an absent user directory leaves the packaged roster alone", () => {
		const agents = loadAgentDefinitions(join(tmpdir(), "hyprsh-no-such-agents-dir"));
		assert.deepEqual(
			agents.map((agent) => agent.name),
			["reviewer", "scout", "worker"],
		);
	});

	test("a file of the same name replaces the packaged agent whole", () => {
		const agents = loadAgentDefinitions(
			userDir({
				"scout.md": [
					"---",
					"name: scout",
					"description: My own scout.",
					"tools: read, grep",
					"model: sonnet",
					"thinking: high",
					"---",
					"",
					"Look, then stop.",
				].join("\n"),
			}),
		);
		const scout = byName(agents, "scout");
		assert.equal(agents.length, 3, "replacing an agent must not add one");
		assert.equal(scout?.model, "sonnet");
		assert.equal(scout?.thinking, "high");
		assert.deepEqual(scout?.tools, ["read", "grep"]);
		assert.equal(scout?.systemPrompt, "Look, then stop.");
	});

	test("a file naming an agent that does not ship joins the roster", () => {
		const agents = loadAgentDefinitions(
			userDir({
				"auditor.md": "---\nname: auditor\ndescription: Reads licences.\ntools: read\n---\n\nAudit.",
			}),
		);
		assert.equal(byName(agents, "auditor")?.description, "Reads licences.");
		assert.equal(byName(agents, "scout")?.model, CHEAPEST, "the packaged agents are untouched");
	});

	// A child inherits this pack, so `task` exists inside it. The allowlist is the
	// only thing keeping fan-out from nesting, and a user file is not exempt.
	test("a user agent cannot grant itself the delegation tool", () => {
		const agents = loadAgentDefinitions(
			userDir({
				"boss.md": "---\nname: boss\ndescription: Delegates.\ntools: read, task\n---\n\nDelegate.",
			}),
		);
		assert.deepEqual(byName(agents, "boss")?.tools, ["read"]);
	});

	// A hand-written file is re-read on every start, so one bad edit must cost the
	// agent it names and nothing else.
	test("a user file with no usable tools is skipped, keeping the packaged agent", () => {
		const agents = loadAgentDefinitions(
			userDir({ "scout.md": "---\nname: scout\ndescription: Broken.\n---\n\nNothing." }),
		);
		assert.equal(byName(agents, "scout")?.model, CHEAPEST);
		assert.equal(agents.length, 3);
	});

	// lib/task runs readers together and writers one at a time, in one shared
	// tree. An agent counted as a reader because it has `edit` but not `write`
	// would run concurrently with another writer and be refused writable paths.
	test("an agent with edit but no write still counts as a writer", () => {
		const agents = loadAgentDefinitions(
			userDir({
				"patcher.md": "---\nname: patcher\ndescription: Patches.\ntools: read, edit\n---\n\nPatch.",
			}),
		);
		assert.equal(writes(byName(agents, "patcher") as AgentDefinition), true);
	});

	// The name becomes a filename in lib/agents/run.ts, which writes the system
	// prompt to it. A name carrying a path would write outside the temp directory.
	test("a name that is not a plain identifier is refused", () => {
		const agents = loadAgentDefinitions(
			userDir({
				"evil.md": '---\nname: "../../pwned"\ndescription: Escapes.\ntools: read\n---\n\nEscape.',
			}),
		);
		assert.deepEqual(
			agents.map((agent) => agent.name),
			["reviewer", "scout", "worker"],
		);
	});

	test("a thinking level pi does not know is dropped rather than passed to the child", () => {
		const agents = loadAgentDefinitions(
			userDir({
				"scout.md": "---\nname: scout\ndescription: Mine.\ntools: read\nthinking: very-hard\n---\n\nGo.",
			}),
		);
		assert.equal(byName(agents, "scout")?.thinking, undefined);
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

/**
 * Evidence is the reason a caller can believe a child at all: the files and
 * commands are read off the event stream rather than out of the child's own
 * report. Every miss here is silent — a run that changed a file looks like a
 * run that changed nothing, which reads as a child that did less harm than it did.
 */
describe("recordEvidence", () => {
	const blank = (): Evidence => ({ changed: [], commands: [] });

	test("write and edit both name the file under file_path", () => {
		const evidence = blank();
		recordEvidence(evidence, "write", { file_path: "lib/new.ts", content: "x" });
		recordEvidence(evidence, "edit", { file_path: "lib/old.ts", edits: [] });
		assert.deepEqual(evidence.changed, ["lib/new.ts", "lib/old.ts"]);
	});

	// The two tools have disagreed about the key before, and the fallback is the
	// only thing keeping a rename of it from emptying the changed list.
	test("path counts as the file when file_path is absent", () => {
		const evidence = blank();
		recordEvidence(evidence, "write", { path: "lib/new.ts" });
		assert.deepEqual(evidence.changed, ["lib/new.ts"]);
	});

	test("file_path wins when a call carries both", () => {
		const evidence = blank();
		recordEvidence(evidence, "edit", { file_path: "lib/real.ts", path: "lib/other.ts" });
		assert.deepEqual(evidence.changed, ["lib/real.ts"]);
	});

	// A child editing one file ten times changed one file.
	test("the same file written twice is listed once", () => {
		const evidence = blank();
		recordEvidence(evidence, "edit", { file_path: "lib/same.ts" });
		recordEvidence(evidence, "edit", { path: "lib/same.ts" });
		assert.deepEqual(evidence.changed, ["lib/same.ts"]);
	});

	test("bash records the command line, repeats and all", () => {
		const evidence = blank();
		recordEvidence(evidence, "bash", { command: "npm test" });
		recordEvidence(evidence, "bash", { command: "npm test" });
		assert.deepEqual(evidence.commands, ["npm test", "npm test"]);
		assert.deepEqual(evidence.changed, []);
	});

	test("a read never counts as a change", () => {
		const evidence = blank();
		recordEvidence(evidence, "read", { file_path: "lib/untouched.ts" });
		recordEvidence(evidence, "grep", { path: "lib" });
		assert.deepEqual(evidence, { changed: [], commands: [] });
	});

	test("arguments of the wrong shape are dropped rather than recorded", () => {
		const evidence = blank();
		recordEvidence(evidence, "write", undefined);
		recordEvidence(evidence, "write", "lib/new.ts");
		recordEvidence(evidence, "write", { file_path: 42 });
		recordEvidence(evidence, "write", {});
		recordEvidence(evidence, "bash", { command: ["npm", "test"] });
		assert.deepEqual(evidence, { changed: [], commands: [] });
	});
});
