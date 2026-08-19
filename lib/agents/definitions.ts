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
	systemPrompt: string;
}

type Frontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
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

	return {
		name,
		description,
		tools,
		model: typeof frontmatter?.model === "string" ? frontmatter.model.trim() : undefined,
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
