/**
 * `parseTodos` is the only thing standing between the model and a list that
 * lies. The guard that matters most is the skipped-needs-a-reason one: it is
 * the mechanism behind the constitution's rule that a dropped step stays
 * visible, and if it stops throwing nothing else in the pack notices.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MAX_TODOS, parseTodos } from "../lib/todo/model.ts";

const pending = { id: "1", text: "do the thing", status: "pending" };

describe("parseTodos", () => {
	test("keeps a well-formed list", () => {
		const todos = parseTodos([pending, { id: "2", text: "then this", status: "in_progress" }]);
		assert.equal(todos.length, 2);
		assert.deepEqual(todos[0], { id: "1", text: "do the thing", status: "pending" });
	});

	test("a skipped todo without a reason is rejected", () => {
		assert.throws(() => parseTodos([{ id: "1", text: "the dropped step", status: "skipped" }]), {
			message: "skipped todo 1 needs a reason",
		});
	});

	test("a whitespace-only reason does not count as a reason", () => {
		assert.throws(
			() => parseTodos([{ id: "1", text: "the dropped step", status: "skipped", reason: " \n\t " }]),
			{
				message: "skipped todo 1 needs a reason",
			},
		);
	});

	test("a skipped todo with a reason is kept, reason and all", () => {
		const todos = parseTodos([
			{ id: "1", text: "the dropped step", status: "skipped", reason: "covered by item 2" },
		]);
		assert.deepEqual(todos[0], {
			id: "1",
			text: "the dropped step",
			status: "skipped",
			reason: "covered by item 2",
		});
	});

	// A reason on a live step is harmless, so it is carried rather than stripped.
	test("a reason on a non-skipped todo survives", () => {
		const todos = parseTodos([{ ...pending, reason: "worth remembering" }]);
		assert.equal(todos[0]?.reason, "worth remembering");
	});

	test("text and reason are collapsed to single spaces", () => {
		const todos = parseTodos([
			{ id: "1", text: "do\n  the   thing ", status: "skipped", reason: "no\ttime" },
		]);
		assert.equal(todos[0]?.text, "do the thing");
		assert.equal(todos[0]?.reason, "no time");
	});

	test("an empty list is a valid list", () => {
		assert.deepEqual(parseTodos([]), []);
	});

	test("anything that is not an array is rejected", () => {
		assert.throws(() => parseTodos({ todos: [] }), { message: "todos must be an array" });
		assert.throws(() => parseTodos(undefined), { message: "todos must be an array" });
	});

	test("an entry that is not an object is rejected", () => {
		assert.throws(() => parseTodos(["do the thing"]), { message: "each todo must be an object" });
		assert.throws(() => parseTodos([[pending]]), { message: "each todo must be an object" });
	});

	test("a blank id or blank text is rejected", () => {
		assert.throws(() => parseTodos([{ ...pending, id: "  " }]), {
			message: "each todo needs a non-empty id",
		});
		assert.throws(() => parseTodos([{ ...pending, text: "  " }]), { message: "todo 1 needs non-empty text" });
	});

	// Ids address entries across calls, so a duplicate makes the list ambiguous.
	test("duplicate ids are rejected", () => {
		assert.throws(() => parseTodos([pending, { ...pending, text: "again" }]), {
			message: "duplicate todo id: 1",
		});
	});

	test("an unknown status is rejected and the message names the legal set", () => {
		assert.throws(() => parseTodos([{ ...pending, status: "doing" }]), {
			message: "todo 1 needs status pending, in_progress, completed, skipped",
		});
	});

	// One in_progress is the whole point of the panel: it says what is happening now.
	test("two in_progress entries are rejected", () => {
		assert.throws(
			() =>
				parseTodos([
					{ ...pending, status: "in_progress" },
					{ id: "2", text: "and this", status: "in_progress" },
				]),
			{ message: "at most one todo may be in_progress" },
		);
	});

	test("a list longer than the cap is rejected", () => {
		const long = Array.from({ length: MAX_TODOS + 1 }, (_, index) => ({
			id: String(index),
			text: "step",
			status: "pending",
		}));
		assert.throws(() => parseTodos(long), { message: `todos must hold at most ${MAX_TODOS} entries` });
		assert.equal(parseTodos(long.slice(0, MAX_TODOS)).length, MAX_TODOS);
	});
});
