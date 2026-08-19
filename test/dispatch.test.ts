/**
 * The scheduler's contract is two facts a reader cannot check by eye: no two
 * writing children are ever in flight together, and phasing does not reorder
 * what comes back. Both are asserted here against a recorded timeline rather
 * than against timing.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { dispatchPhased } from "../lib/task/index.ts";

interface Unit {
	name: string;
	readOnly: boolean;
	/** Event loop turns this unit stays in flight, so slow units finish out of dispatch order. */
	ticks: number;
}

function unit(name: string, readOnly: boolean, ticks = 1): Unit {
	return { name, readOnly, ticks };
}

/** Runs the units and records what was in flight at every moment. */
async function trace(units: readonly Unit[], limit: number) {
	const inFlight = new Set<string>();
	const overlaps: string[][] = [];
	const started: string[] = [];

	const results = await dispatchPhased(
		units,
		(item) => item.readOnly,
		limit,
		async (item) => {
			started.push(item.name);
			inFlight.add(item.name);
			overlaps.push([...inFlight]);
			for (let tick = 0; tick < item.ticks; tick++) await Promise.resolve();
			inFlight.delete(item.name);
			return item.name.toUpperCase();
		},
	);
	return { results, started, overlaps };
}

describe("dispatchPhased", () => {
	test("never runs two writers at once", async () => {
		const units = [unit("w1", false, 3), unit("w2", false, 1), unit("w3", false, 2)];
		const { overlaps } = await trace(units, 3);
		for (const snapshot of overlaps) assert.equal(snapshot.length, 1, `concurrent writers: ${snapshot}`);
	});

	test("runs read-only units together", async () => {
		const units = [unit("r1", true, 3), unit("r2", true, 3), unit("r3", true, 3)];
		const { overlaps } = await trace(units, 3);
		assert.equal(Math.max(...overlaps.map((snapshot) => snapshot.length)), 3);
	});

	test("a writer never overlaps a reader", async () => {
		const units = [unit("r1", true, 4), unit("w1", false, 1), unit("r2", true, 4)];
		const { overlaps } = await trace(units, 3);
		for (const snapshot of overlaps) {
			if (snapshot.includes("w1")) assert.deepEqual(snapshot, ["w1"]);
		}
	});

	test("readers go first even when written last", async () => {
		const units = [unit("w1", false), unit("r1", true), unit("w2", false)];
		const { started } = await trace(units, 3);
		assert.deepEqual(started, ["r1", "w1", "w2"]);
	});

	test("writers run in the order given", async () => {
		const units = [unit("w1", false, 3), unit("w2", false, 1), unit("w3", false, 2)];
		const { started } = await trace(units, 3);
		assert.deepEqual(started, ["w1", "w2", "w3"]);
	});

	test("results keep the caller's order, not the completion order", async () => {
		const units = [unit("w1", false, 5), unit("r1", true, 1), unit("w2", false, 1)];
		const { results } = await trace(units, 3);
		assert.deepEqual(results, ["W1", "R1", "W2"]);
	});

	test("an empty dispatch is not an error", async () => {
		const { results } = await trace([], 3);
		assert.deepEqual(results, []);
	});

	test("a rejected unit fails the dispatch", async () => {
		await assert.rejects(
			dispatchPhased(
				[unit("w1", false)],
				(item) => item.readOnly,
				3,
				async () => {
					throw new Error("child died");
				},
			),
			/child died/,
		);
	});
});
