/**
 * Turning pi event data into the semantic model.
 *
 * The prompt, tools, skills and memory files are available on demand, so the
 * views can always be built. Additions other extensions make in their
 * before_agent_start handlers, and the messages they inject, exist only in a
 * real turn's context event: those are captured passively from the first turn
 * of the session and frozen.
 */

import {
	type BuildSystemPromptOptions,
	type ContextEvent,
	estimateTokens,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";

import { analyzeSystemPrompt, type PromptOptionsSlice, type ToolSlice } from "./measure.ts";
import {
	AGGREGATE_SOURCE_ID,
	buildSnapshot,
	contextOnlyMessages,
	type InjectionItem,
	type InjectionSnapshot,
	type InjectionSource,
} from "./model.ts";

const AGGREGATE_SOURCE: InjectionSource = {
	id: AGGREGATE_SOURCE_ID,
	label: "extensions (aggregate)",
	native: false,
};

/** Everything available when the first context event finalizes a snapshot. */
export interface CaptureFinalization {
	systemPrompt: string;
	messages: ContextEvent["messages"];
	baselineMessages: ContextEvent["messages"];
	allTools: readonly ToolInfo[];
	activeToolNames: readonly string[];
}

/** Inputs for an on-demand pi-native prompt/tool snapshot. */
export interface NativeSnapshotInput {
	systemPrompt: string;
	options: BuildSystemPromptOptions;
	allTools: readonly ToolInfo[];
	activeToolNames: readonly string[];
}

/**
 * Capture-once state. `prepare()` refreshes the structured options on every run
 * until `finalize()` succeeds; later finalizations return the frozen snapshot.
 */
export class CaptureState {
	private pending: { options: PromptOptionsSlice; toolSnippets?: Record<string, string> } | undefined;
	private captured: InjectionSnapshot | undefined;

	/** The frozen snapshot, or undefined until a real turn has been observed. */
	get snapshot(): InjectionSnapshot | undefined {
		return this.captured;
	}

	/** Own the structured prompt inputs from `before_agent_start`; no-op once frozen. */
	prepare(options: BuildSystemPromptOptions): void {
		if (this.captured !== undefined) return;
		this.pending = {
			options: copyPromptOptions(options),
			toolSnippets: options.toolSnippets === undefined ? undefined : { ...options.toolSnippets },
		};
	}

	/** Freeze the snapshot from the first context event of the session. */
	finalize(input: CaptureFinalization): void {
		if (this.captured !== undefined || this.pending === undefined) return;
		const tools = captureActiveTools(input.allTools, input.activeToolNames, this.pending);
		this.captured = buildSnapshot([
			...analyzeSystemPrompt(input.systemPrompt, this.pending.options, tools),
			...measureInjectedMessages(input.messages, input.baselineMessages),
		]);
		this.pending = undefined;
	}
}

/** Build a pi-native snapshot from what pi exposes outside a run. */
export function buildNativeSnapshot(input: NativeSnapshotInput): InjectionSnapshot {
	const tools = captureActiveTools(input.allTools, input.activeToolNames, input.options);
	return buildSnapshot(analyzeSystemPrompt(input.systemPrompt, copyPromptOptions(input.options), tools));
}

/** Add frozen context-only messages to a current prompt/tool snapshot for usage. */
export function mergeContextOnlyMessages(
	snapshot: InjectionSnapshot,
	captured: InjectionSnapshot | undefined,
): InjectionSnapshot {
	const contextOnly = contextOnlyMessages(captured);
	if (contextOnly.length === 0) return snapshot;
	return buildSnapshot([...snapshot.groups.flatMap((group) => group.items), ...contextOnly]);
}

/** Copy the prompt-options slice measurement uses, without shared nested references. */
function copyPromptOptions(options: BuildSystemPromptOptions): PromptOptionsSlice {
	return {
		cwd: options.cwd,
		homeDir: process.env.HOME,
		customPrompt: options.customPrompt,
		appendSystemPrompt: options.appendSystemPrompt,
		contextFilePaths: options.contextFiles?.map((file) => file.path),
		skills: options.skills
			?.filter((skill) => !skill.disableModelInvocation)
			.map((skill) => ({ name: skill.name, description: skill.description, filePath: skill.filePath })),
	};
}

/** Snapshot the active tool set with provenance and payload definitions. */
function captureActiveTools(
	allTools: readonly ToolInfo[],
	activeToolNames: readonly string[],
	options: { readonly toolSnippets?: Readonly<Record<string, string>> },
): ToolSlice[] {
	const active = new Set(activeToolNames);
	return allTools
		.filter((tool) => active.has(tool.name))
		.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parametersJson: JSON.stringify(tool.parameters ?? {}),
			snippet: options.toolSnippets?.[tool.name],
			guidelines: normalizeGuidelines(tool.promptGuidelines),
			source: tool.sourceInfo.source,
		}));
}

/**
 * Measure extension messages while excluding ordinary session history. Custom
 * messages stay attributable by customType; other roles are captured only when
 * they differ from the session-branch baseline.
 */
function measureInjectedMessages(
	messages: ContextEvent["messages"],
	baselineMessages: ContextEvent["messages"],
): InjectionItem[] {
	const baseline = messageSignatureCounts(baselineMessages);
	const occurrences = new Map<string, number>();
	const items: InjectionItem[] = [];
	for (const message of messages) {
		const contextOnly = !consumeMessageSignature(baseline, message);
		if (message.role !== "custom" && !contextOnly) continue;

		const identity = message.role === "custom" ? message.customType : message.role;
		const occurrence = occurrences.get(identity) ?? 0;
		occurrences.set(identity, occurrence + 1);
		items.push({
			id:
				message.role === "custom"
					? `message:${message.customType}:${occurrence}`
					: `message:context:${message.role}:${occurrence}`,
			kind: "message",
			source:
				message.role === "custom"
					? { id: `message-type:${message.customType}`, label: message.customType, native: false }
					: AGGREGATE_SOURCE,
			label: message.role === "custom" ? "message" : `${message.role} message`,
			tokens: estimateTokens(message),
			text: messageText(message),
			contextOnly: contextOnly || undefined,
		});
	}
	return items;
}

/** Count structurally identical baseline messages for order-independent diffing. */
function messageSignatureCounts(messages: ContextEvent["messages"]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const message of messages) {
		const signature = JSON.stringify(message);
		counts.set(signature, (counts.get(signature) ?? 0) + 1);
	}
	return counts;
}

/** Consume one matching baseline occurrence; false means the message is context-only. */
function consumeMessageSignature(
	counts: Map<string, number>,
	message: ContextEvent["messages"][number],
): boolean {
	const signature = JSON.stringify(message);
	const count = counts.get(signature) ?? 0;
	if (count === 0) return false;
	if (count === 1) counts.delete(signature);
	else counts.set(signature, count - 1);
	return true;
}

/** Provider-bound message content for raw preview. */
function messageText(message: ContextEvent["messages"][number]): string {
	if (!("content" in message)) return JSON.stringify(message);
	return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}

/** Normalize the string-or-array promptGuidelines field to an owned array. */
function normalizeGuidelines(guidelines: string | string[] | undefined): string[] {
	if (guidelines === undefined) return [];
	return Array.isArray(guidelines) ? [...guidelines] : [guidelines];
}
