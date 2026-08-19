/**
 * The agent roster.
 *
 * Definitions are markdown files bundled beside this one, because `agents` is
 * not a pi package resource type: only extensions, skills, prompts and themes
 * are discovered from a package, so an agent that lived in ~/.pi/agent/agents
 * would be a manual install step for every user of this pack. They are read
 * from the package instead, the way lib/constitution reads its AGENTS.md.
 *
 * `tools` is required and is an allowlist. That is what stops a child
 * delegating further: a child inherits this pack's extensions, so the `task`
 * tool exists inside it, and only an explicit allowlist that omits the name
 * keeps it out of reach.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	type AgentTier,
	isThinkingLevel,
	isTier,
	THINKING_LEVELS,
	type ThinkingLevel,
	TIERS,
} from "./model.ts";

const DIR = join(import.meta.dirname, "definitions");

/** Never grant a child the delegation tool; nested fan-out is unbounded by construction. */
const FORBIDDEN_TOOLS = new Set(["task"]);

export interface AgentDefinition {
	name: string;
	description: string;
	/** Allowlist passed to the child as --tools. */
	tools: string[];
	/** Absent means the child inherits the dispatching session's model and thinking level. */
	model?: string;
	/** Intention rather than an ID: resolved against the live registry at dispatch. */
	tier?: AgentTier;
	/** How hard this agent thinks, independent of which model it lands on. */
	thinking?: ThinkingLevel;
	systemPrompt: string;
}

type Frontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	tier?: unknown;
	thinking?: unknown;
};

/** Both spellings are valid YAML and both appear in agent files elsewhere. */
function toolList(value: unknown): string[] {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	return raw
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0 && !FORBIDDEN_TOOLS.has(entry));
}

function parse(file: string, source: string): AgentDefinition {
	const { frontmatter, body } = parseFrontmatter<Frontmatter>(source);
	const name = typeof frontmatter?.name === "string" ? frontmatter.name.trim() : "";
	const description = typeof frontmatter?.description === "string" ? frontmatter.description.trim() : "";
	const tools = toolList(frontmatter?.tools);

	// These files ship with the package, so anything wrong here is a packaging
	// error that should surface at load rather than as a broken child later.
	if (!name) throw new Error(`agent definition ${file} has no name`);
	if (!description) throw new Error(`agent definition ${file} has no description`);
	if (tools.length === 0) throw new Error(`agent definition ${file} has no usable tools`);
	// A misspelled tier would silently cost the user money on the parent's model,
	// which is the failure this whole feature exists to remove.
	if (frontmatter?.tier !== undefined && !isTier(frontmatter.tier)) {
		throw new Error(
			`agent definition ${file} has tier ${String(frontmatter.tier)}, expected one of ${TIERS.join(", ")}`,
		);
	}
	// A level pi does not know is refused by the child at startup, so it would kill
	// every dispatch of this agent rather than degrade one.
	if (frontmatter?.thinking !== undefined && !isThinkingLevel(frontmatter.thinking)) {
		throw new Error(
			`agent definition ${file} has thinking ${String(frontmatter.thinking)}, expected one of ${THINKING_LEVELS.join(", ")}`,
		);
	}

	return {
		name,
		description,
		tools,
		model: typeof frontmatter?.model === "string" ? frontmatter.model.trim() : undefined,
		tier: isTier(frontmatter?.tier) ? frontmatter.tier : undefined,
		thinking: isThinkingLevel(frontmatter?.thinking) ? frontmatter.thinking : undefined,
		systemPrompt: body.trim(),
	};
}

let cached: AgentDefinition[] | undefined;

export function agentDefinitions(): AgentDefinition[] {
	if (cached) return cached;
	const files = readdirSync(DIR)
		.filter((file) => file.endsWith(".md"))
		.sort();
	cached = files.map((file) => parse(file, readFileSync(join(DIR, file), "utf-8")));
	return cached;
}

export function findAgent(name: string): AgentDefinition | undefined {
	return agentDefinitions().find((agent) => agent.name === name);
}
