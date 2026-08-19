/**
 * The web config is the one file in the pack that refuses rather than defaults:
 * a bad key throws, because silently searching with the wrong provider or
 * fetching with no timeout is worse than a startup error. That makes the
 * message itself the feature — it has to name the offending key and the file
 * it is in, or the user is left guessing which of a dozen settings is wrong.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseWebConfig } from "../lib/web/config.ts";

const PATH = "/home/u/.pi/agent/hypr/config.json";

const parse = (web: unknown) => parseWebConfig({ web } as Record<string, unknown>, PATH);

describe("parseWebConfig", () => {
	test("an empty config is valid and every default is present", () => {
		const config = parseWebConfig({}, PATH);
		assert.ok(config.search.priority.length > 0);
		assert.ok(config.search.timeoutMs > 0);
		assert.ok(config.fetch.userAgent.length > 0);
	});

	test("a null section is treated as absent rather than as a bad value", () => {
		const config = parse({ search: null, fetch: null });
		assert.deepEqual(config.search.priority, parseWebConfig({}, PATH).search.priority);
	});

	test("a section of the wrong type names the key and the file", () => {
		assert.throws(() => parse("brave"), { message: `web in ${PATH} must be an object` });
		assert.throws(() => parse({ search: [] }), { message: `web.search in ${PATH} must be an object` });
	});

	// The whole point of refusing here: a typo'd provider would otherwise be a
	// search that quietly never runs.
	test("an unknown provider is rejected and the message lists the known ones", () => {
		assert.throws(
			() => parse({ search: { priority: ["bing"] } }),
			(error: Error) => {
				assert.match(error.message, /web\.search\.priority in .*unknown provider: "bing"/);
				assert.match(error.message, /Known: .*brave/);
				return true;
			},
		);
	});

	test("an empty or non-array priority is rejected", () => {
		const expected = { message: `web.search.priority in ${PATH} must be a non-empty array of provider ids` };
		assert.throws(() => parse({ search: { priority: [] } }), expected);
		assert.throws(() => parse({ search: { priority: "brave" } }), expected);
	});

	test("a repeated provider is deduplicated rather than rejected", () => {
		const config = parse({ search: { priority: ["brave", "exa", "brave"] } });
		assert.deepEqual(config.search.priority, ["brave", "exa"]);
	});

	test("a timeout that is zero, negative or not a number is rejected", () => {
		const expected = { message: `web.search.timeoutMs in ${PATH} must be a positive number` };
		assert.throws(() => parse({ search: { timeoutMs: 0 } }), expected);
		assert.throws(() => parse({ search: { timeoutMs: -1 } }), expected);
		assert.throws(() => parse({ search: { timeoutMs: "5000" } }), expected);
		assert.throws(() => parse({ search: { timeoutMs: Number.NaN } }), expected);
	});

	// Retries are bounded because an unbounded one turns a flaky provider into a
	// hang the user cannot see.
	test("a retry count outside 0-10 or fractional is rejected", () => {
		const expected = { message: `web.fetch.retries in ${PATH} must be an integer between 0 and 10` };
		assert.throws(() => parse({ fetch: { retries: 11 } }), expected);
		assert.throws(() => parse({ fetch: { retries: -1 } }), expected);
		assert.throws(() => parse({ fetch: { retries: 1.5 } }), expected);
		assert.equal(parse({ fetch: { retries: 0 } }).fetch.retries, 0);
	});

	test("a non-http url is rejected, and so is one carrying credentials", () => {
		assert.throws(() => parse({ search: { searxngBaseUrl: "ftp://example.com" } }), {
			message: `web.search.searxngBaseUrl in ${PATH} must use http or https`,
		});
		assert.throws(() => parse({ search: { searxngBaseUrl: "not a url" } }), {
			message: `web.search.searxngBaseUrl in ${PATH} must be an http(s) URL`,
		});
		assert.throws(() => parse({ search: { searxngBaseUrl: "https://user:pw@example.com" } }), {
			message: `web.search.searxngBaseUrl in ${PATH} must not embed credentials`,
		});
	});

	test("a valid url loses its trailing slashes so joins do not double up", () => {
		assert.equal(
			parse({ search: { searxngBaseUrl: "https://searx.example.com//" } }).search.searxngBaseUrl,
			"https://searx.example.com",
		);
	});

	test("a blank string where a value is required is rejected", () => {
		assert.throws(() => parse({ search: { openaiModel: "   " } }), {
			message: `web.search.openaiModel in ${PATH} must be a non-empty string`,
		});
	});

	// Keys are read from the environment so a config file can be committed.
	test("a $VAR secret resolves from the environment", () => {
		process.env.HYPRSH_TEST_KEY = "resolved-key";
		try {
			assert.equal(parse({ search: { braveApiKey: "$HYPRSH_TEST_KEY" } }).search.braveApiKey, "resolved-key");
			// biome-ignore lint/suspicious/noTemplateCurlyInString: ${VAR} is the config file's own syntax, not a stray template literal
			const braced = "${HYPRSH_TEST_KEY}";
			assert.equal(parse({ search: { braveApiKey: braced } }).search.braveApiKey, "resolved-key");
		} finally {
			delete process.env.HYPRSH_TEST_KEY;
		}
	});

	test("a $VAR that is not set resolves to undefined rather than to the literal", () => {
		delete process.env.HYPRSH_TEST_MISSING;
		assert.equal(parse({ search: { braveApiKey: "$HYPRSH_TEST_MISSING" } }).search.braveApiKey, undefined);
	});

	test("a literal secret is kept as written", () => {
		assert.equal(parse({ search: { braveApiKey: " literal-key " } }).search.braveApiKey, "literal-key");
	});
});
