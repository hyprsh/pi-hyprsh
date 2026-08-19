/**
 * The brief.
 *
 * A child starts with none of the parent's conversation, so an assignment that
 * leaves out its scope or its acceptance criteria produces confident, unusable
 * work. Published delegation protocols state the required sections as prose and
 * trust the caller to follow them. This states them as a schema instead, so an
 * incomplete brief cannot be sent at all — the same move lib/reason makes with
 * the reasoning argument.
 *
 * Two fields exist in the shape they do because it makes a rule checkable
 * rather than merely stated. `writable` is a list of paths, not a sentence, so
 * two children assigned the same file are caught before either starts.
 * `forbidden` is filled in here rather than asked for, because a prohibition
 * the caller has to retype is one the caller eventually forgets.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const MAX_NAME = 32;

/** Added to every brief. The caller's own `forbidden` entries are appended to these. */
const STANDING_PROHIBITIONS = [
	"Do not call the task tool or start further subagents. Do this assignment yourself.",
	"Do not change files outside your writable scope, even to fix something obviously broken. Report it instead.",
	"Do not run project-wide formatters, linters or full test suites unless this brief names them.",
	"Do not claim the work is done without running the verification below and reporting its real output.",
];

export function briefSchema(agents: readonly string[]) {
	return Type.Object({
		name: Type.String({
			maxLength: MAX_NAME,
			description: `Short CamelCase name for this unit of work, at most ${MAX_NAME} characters. Results are matched to it by name, so make it unique within the call.`,
		}),
		agent: StringEnum(agents as string[], {
			description: "Which agent carries out the assignment.",
		}),
		goal: Type.String({
			description:
				"The outcome in one sentence, executable by a stranger. What is true when this unit is done.",
		}),
		context: Type.String({
			description:
				"Everything the child needs and cannot see: repository paths, the decision already taken, the shape of the surrounding code, known gotchas. It starts with none of this conversation, so a brief that assumes shared context produces confident wrong work.",
		}),
		writable: Type.Array(Type.String(), {
			description:
				"Paths this child may change, relative to the repository root. Empty for a read-only assignment. Two units in the same call must never list the same path, or overlapping directories.",
		}),
		acceptance: Type.Array(Type.String(), {
			minItems: 1,
			description: "Checkable outcomes, one per line. Each states an observable fact, not an activity.",
		}),
		verify: Type.Array(Type.String(), {
			minItems: 1,
			description:
				"Exact commands the child must run to prove the work, such as `npm run check`. It reports their real output. Give at least one; for a read-only assignment this is how the answer is corroborated.",
		}),
		forbidden: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Extra prohibitions for this assignment only. The standing ones (no nested delegation, no out-of-scope edits, no unverified completion) are added automatically; do not repeat them.",
			}),
		),
	});
}

export interface Brief {
	name: string;
	agent: string;
	goal: string;
	context: string;
	writable: string[];
	acceptance: string[];
	verify: string[];
	forbidden?: string[];
}

function section(title: string, body: string): string {
	return `## ${title}\n${body}`;
}

function bullets(entries: readonly string[]): string {
	return entries.map((entry) => `- ${entry}`).join("\n");
}

function scopeText(writable: readonly string[]): string {
	if (writable.length === 0) {
		return "This assignment is read-only. You may change nothing on disk.";
	}
	return `You may change only these paths. Everything else is read-only to you.\n${bullets(writable)}`;
}

/** The brief as the child reads it. */
export function renderBrief(brief: Brief): string {
	return [
		section("Goal", brief.goal),
		section("Context", brief.context),
		section("Scope", scopeText(brief.writable)),
		section("Acceptance", bullets(brief.acceptance)),
		section("Verify", `Run these and report what they actually printed:\n${bullets(brief.verify)}`),
		section("Forbidden", bullets([...STANDING_PROHIBITIONS, ...(brief.forbidden ?? [])])),
		section(
			"Report",
			"Your caller cannot see this session. State what you changed, what the verification printed, and anything you could not do. End with a single VERDICT line as your system prompt describes.",
		),
	].join("\n\n");
}

/** `./lib/foo/` and `lib/foo` are the same claim on the same directory. */
function normalizePath(path: string): string {
	return path.trim().replace(/^\.\//, "").replace(/\/+$/, "");
}

/** True when two claims cover any of the same files, including a file inside a claimed directory. */
function overlaps(a: string, b: string): boolean {
	if (a === b) return true;
	return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Problems that must stop a dispatch.
 *
 * Two children writing the same path is the one failure the caller cannot see
 * coming and cannot cleanly undo, since both edits land in the same tree with
 * no record of which came first. It is rejected before anything spawns.
 */
export function conflicts(briefs: readonly Brief[], readOnlyAgents: ReadonlySet<string>): string[] {
	const problems: string[] = [];
	const names = new Set<string>();
	const claims: { unit: string; path: string }[] = [];

	for (const brief of briefs) {
		if (names.has(brief.name)) problems.push(`two units are both named ${brief.name}`);
		names.add(brief.name);

		if (readOnlyAgents.has(brief.agent) && brief.writable.length > 0) {
			problems.push(`${brief.name} gives writable paths to ${brief.agent}, which has no write or edit tool`);
		}

		for (const raw of brief.writable) {
			const path = normalizePath(raw);
			if (!path) continue;
			for (const claim of claims) {
				if (overlaps(path, claim.path)) {
					problems.push(
						`${brief.name} and ${claim.unit} both claim ${path === claim.path ? path : `${path} and ${claim.path}`}`,
					);
				}
			}
			claims.push({ unit: brief.name, path });
		}
	}
	return problems;
}
