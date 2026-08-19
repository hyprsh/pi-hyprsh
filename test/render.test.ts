/**
 * The run header is the only place a caller learns which model a child used.
 * The case worth protecting is the quiet one: a configured model that was not
 * available is dropped in favour of inheriting, and without a word in the
 * header that decision is invisible and looks like the config never applied.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AgentRun } from "../lib/agents/types.ts";
import { emptyUsage } from "../lib/agents/types.ts";
import { formatRuns, MAX_PANEL_LINES, panelLines } from "../lib/task/render.ts";

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

/**
 * The panel is the only live view of a dispatch, and it is the one surface no
 * one has watched: print mode has no widgets. A unit test cannot say it looks
 * right, but it can say the two rules that make it useful hold — it disappears
 * when nothing is running, and it never grows past its line budget however many
 * children are in flight.
 */
describe("panelLines", () => {
	// A theme that returns the text unchanged: what is asserted is the content
	// and the line budget, not the colour codes wrapped around them.
	const theme = {
		bold: (text: string) => text,
		fg: (_role: string, text: string) => text,
	} as unknown as Theme;
	const lines = (runs: readonly AgentRun[], running: readonly string[]) =>
		panelLines(runs, new Set(running), theme, 200);

	test("nothing running means no panel at all", () => {
		assert.deepEqual(lines([run(), run({ name: "Check" })], []), []);
	});

	test("the header counts finished children against the total in flight", () => {
		assert.equal(lines([run()], ["Check", "Build"])[0], "Agents (1/3)");
	});

	test("a finished child shows its verdict mark and its duration", () => {
		assert.deepEqual(lines([run()], ["Check"]).slice(1), [" ✔ Look 1.2s", " ▶ Check"]);
	});

	// A crashed child never stated a verdict, so its own `unknown` would read as
	// merely quiet. The panel shows the failure instead.
	test("a failed child is marked blocked whatever verdict it carries", () => {
		assert.match(lines([run({ verdict: "unknown", failure: "spawn failed" })], ["Check"])[1] ?? "", /✗/);
	});

	// Without this the mark could be hard-wired to ✔ and nothing would notice: a
	// child that reported ISSUES would sit in the panel looking like a clean pass.
	test("each verdict gets its own mark", () => {
		const mark = (verdict: AgentRun["verdict"]) => lines([run({ verdict })], ["Check"])[1];
		assert.equal(mark("pass"), " ✔ Look 1.2s");
		assert.equal(mark("issues"), " ! Look 1.2s");
		assert.equal(mark("blocked"), " ✗ Look 1.2s");
		assert.equal(mark("unknown"), " ? Look 1.2s");
	});

	test("the panel never exceeds its line budget", () => {
		const many = Array.from({ length: 12 }, (_, index) => run({ name: `Unit${index}` }));
		const busy = Array.from({ length: 12 }, (_, index) => `Wait${index}`);
		assert.equal(lines(many, busy).length, MAX_PANEL_LINES);
	});

	// Finished units are dropped from the head, newest kept. Recording the cost
	// of that choice: past six finished units the budget is spent before the
	// running ones are reached, so the panel stops showing what is in flight even
	// though something being in flight is the only reason it is on screen.
	test("the oldest finished units are dropped, and running ones lose to them", () => {
		const many = Array.from({ length: 12 }, (_, index) => run({ name: `Unit${index}` }));
		const shown = lines(many, ["Check"]).join("\n");
		assert.match(shown, /Unit11/);
		assert.doesNotMatch(shown, /Unit0\b/);
		assert.doesNotMatch(shown, /Check/);
	});

	// Measured with the escape codes stripped: truncateToWidth appends a reset
	// sequence, which costs characters but no columns.
	test("lines are truncated to the available width", () => {
		for (const line of panelLines([run()], new Set(["Check"]), theme, 6)) {
			// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
			const visible = line.replace(/\u001b\[[0-9;]*m/g, "");
			assert.ok(visible.length <= 6, `${JSON.stringify(visible)} is wider than 6`);
		}
	});
});
