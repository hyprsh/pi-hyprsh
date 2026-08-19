/**
 * `conflicts` is the only thing standing between two children and the same
 * file, and it runs before anything is spawned, so a wrong answer here is
 * unrecoverable rather than merely annoying. The path cases are the ones that
 * look right and are not: a prefix that is not a parent directory, and the same
 * claim written two ways.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type Brief, conflicts, renderBrief } from "../lib/task/brief.ts";

const READ_ONLY = new Set(["scout", "reviewer"]);

function brief(overrides: Partial<Brief> & { name: string }): Brief {
	return {
		agent: "worker",
		goal: "do the thing",
		context: "there is context",
		writable: [],
		acceptance: ["the thing is done"],
		verify: ["npm run check"],
		...overrides,
	};
}

describe("conflicts", () => {
	test("accepts disjoint claims", () => {
		const problems = conflicts(
			[
				brief({ name: "One", writable: ["lib/task"] }),
				brief({ name: "Two", writable: ["lib/agents", "test"] }),
			],
			READ_ONLY,
		);
		assert.deepEqual(problems, []);
	});

	test("a shared prefix is not a shared directory", () => {
		const problems = conflicts(
			[brief({ name: "One", writable: ["lib/ab"] }), brief({ name: "Two", writable: ["lib/abc"] })],
			READ_ONLY,
		);
		assert.deepEqual(problems, []);
	});

	test("a file inside a claimed directory conflicts", () => {
		const problems = conflicts(
			[brief({ name: "One", writable: ["lib/"] }), brief({ name: "Two", writable: ["lib/a.ts"] })],
			READ_ONLY,
		);
		assert.equal(problems.length, 1);
		assert.match(problems[0] as string, /Two and One/);
		assert.match(problems[0] as string, /lib\/a\.ts and lib/);
	});

	test("the same path written two ways is one claim", () => {
		const problems = conflicts(
			[brief({ name: "One", writable: ["./lib/task/"] }), brief({ name: "Two", writable: ["lib/task"] })],
			READ_ONLY,
		);
		assert.equal(problems.length, 1);
		assert.match(problems[0] as string, /both claim lib\/task$/);
	});

	test("an empty path claims nothing", () => {
		const problems = conflicts(
			[brief({ name: "One", writable: ["  "] }), brief({ name: "Two", writable: [""] })],
			READ_ONLY,
		);
		assert.deepEqual(problems, []);
	});

	test("a unit conflicting with itself is still reported", () => {
		const problems = conflicts([brief({ name: "One", writable: ["lib", "lib/task"] })], READ_ONLY);
		assert.equal(problems.length, 1);
	});

	test("duplicate names are rejected", () => {
		const problems = conflicts([brief({ name: "One" }), brief({ name: "One" })], READ_ONLY);
		assert.deepEqual(problems, ["two units are both named One"]);
	});

	test("a read-only agent may not be given writable paths", () => {
		const problems = conflicts([brief({ name: "Look", agent: "scout", writable: ["lib"] })], READ_ONLY);
		assert.equal(problems.length, 1);
		assert.match(problems[0] as string, /scout, which has no write or edit tool/);
	});

	test("a read-only agent with no writable paths is fine", () => {
		assert.deepEqual(conflicts([brief({ name: "Look", agent: "scout" })], READ_ONLY), []);
	});
});

describe("renderBrief", () => {
	test("states the standing prohibitions the caller never typed", () => {
		const rendered = renderBrief(brief({ name: "One", forbidden: ["Do not touch the lockfile."] }));
		assert.match(rendered, /Do not call the task tool/);
		assert.match(rendered, /Do not touch the lockfile\./);
	});

	test("an empty writable list renders as read-only, not as an empty section", () => {
		const rendered = renderBrief(brief({ name: "One", writable: [] }));
		assert.match(rendered, /This assignment is read-only\./);
	});
});
