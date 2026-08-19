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
	// Everything this pack keeps on disk lives in one directory, so an agent
	// override sits beside the config that used to hold the same settings.
	test("lives in the hypr directory inside pi's config folder", () => {
		assert.match(configPath(), /[/\\]hypr[/\\]config\.json$/);
	});
});

describe("loadConfig", () => {
	test("a missing file gives defaults rather than throwing", () => {
		const config = loadConfig(join(tmpdir(), "hyprsh-does-not-exist", "config.json"));
		assert.equal(config.features.task, true);
		assert.equal(config.thinking.mode, "summary");
	});

	test("malformed JSON gives defaults rather than throwing", () => {
		const config = loadConfig(configFile("{ not json"));
		assert.equal(config.features.task, true);
	});

	test("reads the thinking mode", () => {
		const config = loadConfig(configFile(JSON.stringify({ thinking: { mode: "full" } })));
		assert.equal(config.thinking.mode, "full");
	});

	test("a thinking mode outside the set falls back to the default", () => {
		const config = loadConfig(configFile(JSON.stringify({ thinking: { mode: "loud" } })));
		assert.equal(config.thinking.mode, "summary");
	});

	test("a feature switch of the wrong type keeps the default", () => {
		const config = loadConfig(configFile(JSON.stringify({ features: { task: "no" } })));
		assert.equal(config.features.task, true);
	});

	test("an unrelated key does not disturb the rest of the config", () => {
		const config = loadConfig(configFile(JSON.stringify({ agents: { scout: "haiku" } })));
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
