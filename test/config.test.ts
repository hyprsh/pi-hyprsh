/**
 * The config loader's contract is that nothing in this file can break pi's
 * startup: a missing file, a corrupt file and a file with the wrong types in it
 * all have to end in usable defaults. That is easy to write and easy to regress
 * the first time someone reaches for a `throw`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { configPath, loadConfig } from "../lib/config.ts";

function configFile(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "hyprsh-config-"));
	const path = join(dir, "config.json");
	writeFileSync(path, contents, "utf-8");
	return path;
}

describe("configPath", () => {
	test("lives in the hypr directory inside pi's config folder", () => {
		assert.match(configPath(), /[/\\]hypr[/\\]config\.json$/);
	});
});

describe("loadConfig", () => {
	test("a missing file gives defaults rather than throwing", () => {
		const config = loadConfig(join(tmpdir(), "hyprsh-does-not-exist", "config.json"));
		assert.equal(config.features.task, true);
		assert.deepEqual(config.agents.models, {});
	});

	test("malformed JSON gives defaults rather than throwing", () => {
		const config = loadConfig(configFile("{ not json"));
		assert.equal(config.features.task, true);
	});

	test("reads per-agent model overrides", () => {
		const config = loadConfig(configFile(JSON.stringify({ agents: { models: { scout: "haiku" } } })));
		assert.deepEqual(config.agents.models, { scout: "haiku" });
	});

	test("trims an override and drops one that is only whitespace", () => {
		const config = loadConfig(
			configFile(JSON.stringify({ agents: { models: { scout: "  haiku  ", worker: "   " } } })),
		);
		assert.deepEqual(config.agents.models, { scout: "haiku" });
	});

	test("a non-string override is dropped, keeping the valid ones", () => {
		const config = loadConfig(
			configFile(JSON.stringify({ agents: { models: { scout: 42, reviewer: "sonnet" } } })),
		);
		assert.deepEqual(config.agents.models, { reviewer: "sonnet" });
	});

	test("agents given as the wrong type falls back to no overrides", () => {
		const config = loadConfig(configFile(JSON.stringify({ agents: "cheap please" })));
		assert.deepEqual(config.agents.models, {});
		assert.deepEqual(config.agents.thinking, {});
	});

	test("reads a per-agent thinking level", () => {
		const config = loadConfig(configFile(JSON.stringify({ agents: { thinking: { scout: "low" } } })));
		assert.deepEqual(config.agents.thinking, { scout: "low" });
	});

	// A level pi does not know would be rejected by the child at startup, so a
	// typo here would kill every scout rather than degrade one.
	test("a thinking level outside pi's own set is dropped, not passed on", () => {
		const config = loadConfig(
			configFile(JSON.stringify({ agents: { thinking: { scout: "very-hard", reviewer: "max" } } })),
		);
		assert.deepEqual(config.agents.thinking, { reviewer: "max" });
	});

	test("an unrelated key does not disturb the rest of the config", () => {
		const config = loadConfig(configFile(JSON.stringify({ agents: { models: { scout: "haiku" } } })));
		assert.equal(config.features.footer, true);
		assert.equal(config.footer.thresholds.warning, 70);
	});

	test("thresholds arriving in the wrong order are swapped, not accepted", () => {
		const config = loadConfig(
			configFile(JSON.stringify({ footer: { thresholds: { warning: 90, critical: 70 } } })),
		);
		assert.equal(config.footer.thresholds.warning, 70);
		assert.equal(config.footer.thresholds.critical, 90);
	});
});
