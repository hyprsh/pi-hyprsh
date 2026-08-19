/**
 * The agent roster.
 *
 * Definitions are markdown files bundled beside this one, because `agents` is
 * not a pi package resource type: only extensions, skills, prompts and themes
 * are discovered from a package, so an agent that lived in ~/.pi/agent/agents
 * would be a manual install step for every user of this pack. They are read
 * from the package instead, the way lib/constitution reads its AGENTS.md.
 *
 * A definition carries everything about the agent, `model` and `thinking`
 * included. What an agent is and what it costs are one decision: a scout is
 * cheap reconnaissance, and a scout on the session's flagship model is a
 * different agent. Splitting the two across a definition and a config file
 * meant reading both files to know what a dispatch would do.
 *
 * The packaged files are packaged, so an edit to them is lost on the next
 * update. `~/.pi/agent/hypr/agents/<name>.md` is the seam: a file there
 * replaces the packaged agent of the same name outright, and a file naming an
 * agent that does not ship joins the roster. Replacement is whole-file rather
 * than field-by-field, so what runs is exactly the file you can read.
 *
 * `tools` is required and is an allowlist. That is what stops a child
 * delegating further: a child inherits this pack's extensions, so the `task`
 * tool exists inside it, and only an explicit allowlist that omits the name
 * keeps it out of reach. That holds for a user's own agent too, because the
 * filter runs on every definition whatever its source.
 *
 * Everything else that used to be safe because these files were packaged is now
 * checked here, since a name and a tool list can arrive hand-written: `name`
 * has to be a plain identifier because lib/agents/run.ts builds a file path
 * from it, and `writes` rather than the `write` tool alone decides whether
 * lib/task serialises a child.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { agentDir } from "../config.ts";
import { isThinkingLevel, type ThinkingLevel } from "./model.ts";

const PACKAGED_DIR = join(import.meta.dirname, "definitions");

/** Never grant a child the delegation tool; nested fan-out is unbounded by construction. */
const FORBIDDEN_TOOLS = new Set(["task"]);

export interface AgentDefinition {
	name: string;
	description: string;
	/** Allowlist passed to the child as --tools. */
	tools: string[];
	/**
	 * A model ID, `provider/id`, or `cheapest`. Absent means the child inherits
	 * the dispatching session's model. Resolved against the live registry at
	 * dispatch, never at load, because availability depends on auth.
	 */
	model?: string;
	/**
	 * How hard the child thinks. Absent means it follows the session's level,
	 * which is what every shipped agent does: measured on a scout task, `low` and
	 * `high` produced 311 and 328 reasoning tokens, so a shipped default would
	 * have bought nothing.
	 */
	thinking?: ThinkingLevel;
	systemPrompt: string;
}

/** A name becomes a filename in lib/agents/run.ts, so it may not contain a path. */
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

type Frontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
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
	const model = typeof frontmatter?.model === "string" ? frontmatter.model.trim() : "";

	// An agent with no name, description or tools cannot be dispatched at all, so
	// it is an error. A thinking level outside pi's own set is not: the field is
	// dropped and the child follows the session, rather than one typo killing an
	// otherwise working agent at spawn.
	if (!name) throw new Error(`agent definition ${file} has no name`);
	if (!NAME.test(name)) throw new Error(`agent definition ${file} has an unusable name: ${name}`);
	if (!description) throw new Error(`agent definition ${file} has no description`);
	if (tools.length === 0) throw new Error(`agent definition ${file} has no usable tools`);

	return {
		name,
		description,
		tools,
		model: model || undefined,
		thinking: isThinkingLevel(frontmatter?.thinking) ? frontmatter.thinking : undefined,
		systemPrompt: body.trim(),
	};
}

/** Where a user's own agents live. One directory, no project-local layer. */
export function userAgentsDir(): string {
	return join(agentDir(), "hypr", "agents");
}

/**
 * Whether a child can change the tree, which is what lib/task serialises on.
 *
 * `edit` counts as much as `write`. The packaged agents never carry one without
 * the other, but a user's own file can, and a writer mistaken for a reader runs
 * concurrently with other writers in the same working tree.
 */
export function writes(agent: AgentDefinition): boolean {
	return agent.tools.includes("write") || agent.tools.includes("edit");
}

function markdownIn(dir: string): string[] {
	return readdirSync(dir)
		.filter((file) => file.endsWith(".md"))
		.sort();
}

/** An absent user directory is the normal case on a fresh install, not an error. */
function optionalMarkdownIn(dir: string): string[] {
	try {
		return markdownIn(dir);
	} catch {
		return [];
	}
}

/**
 * Packaged agents first, then the user's on top of them.
 *
 * A broken packaged file, or a package with no definitions directory at all,
 * throws: it is an installation error, and a roster that silently came back
 * empty would register a `task` tool no argument could satisfy. A broken user
 * file is skipped instead, because it is hand-written and re-read on every
 * start, and losing one agent is recoverable where a pack that refuses to load
 * is not.
 */
export function loadAgentDefinitions(userDir = userAgentsDir()): AgentDefinition[] {
	const byName = new Map<string, AgentDefinition>();
	for (const file of markdownIn(PACKAGED_DIR)) {
		const agent = parse(file, readFileSync(join(PACKAGED_DIR, file), "utf-8"));
		byName.set(agent.name, agent);
	}
	for (const file of optionalMarkdownIn(userDir)) {
		try {
			const agent = parse(file, readFileSync(join(userDir, file), "utf-8"));
			byName.set(agent.name, agent);
		} catch {
			// Nothing to report to at extension load, so the roster simply keeps the
			// packaged agent of that name, or has none if the file named a new one.
		}
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

let cached: AgentDefinition[] | undefined;

export function agentDefinitions(): AgentDefinition[] {
	cached ??= loadAgentDefinitions();
	return cached;
}

export function findAgent(name: string): AgentDefinition | undefined {
	return agentDefinitions().find((agent) => agent.name === name);
}
