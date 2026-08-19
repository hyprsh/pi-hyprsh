/**
 * Running one child agent.
 *
 * A child is a separate `pi` process in JSON mode, so it gets its own context
 * window and nothing but its final report comes back. The event stream is what
 * makes the result trustworthy: `tool_execution_start` records name the tool
 * and its arguments, so the files a child wrote and the commands it ran are
 * read off what it did rather than out of what it said about itself.
 *
 * The process invocation follows pi's own subagent example
 * (examples/extensions/subagent, MIT): resolving the pi entry point across
 * node, bun and compiled-binary installs is not obvious and there is one
 * correct answer.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { AgentDefinition } from "./definitions.ts";
import { type AgentRun, addUsage, type Evidence, emptyUsage, type ReportedVerdict } from "./types.ts";

/** Tools whose arguments name a file the child changed. */
const WRITE_TOOLS = new Set(["write", "edit"]);

const VERDICT_LINE = /^\s*VERDICT:\s*(PASS|ISSUES|BLOCKED)\s*$/im;

export interface RunOptions {
	cwd: string;
	/** Already resolved by the caller; see lib/agents/model.ts. Absent lets pi pick its own default. */
	model?: string;
	/** Reported back so a configured model that could not be used is visible rather than silent. */
	ignoredModel?: string;
	/** Passed through only when the caller decided this child inherits it. */
	thinkingLevel?: string;
	signal?: AbortSignal;
	/** Called whenever the run's observable state changes, for live rendering. */
	onProgress?: () => void;
}

/**
 * Resolve how to invoke pi again.
 *
 * Taken from pi's subagent example: when the current script is a real file, run
 * it with the current runtime; when pi is a compiled binary, re-exec the binary;
 * otherwise fall back to `pi` on PATH.
 */
function piInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	const isVirtual = script?.startsWith("/$bunfs/root/");
	if (script && !isVirtual && existsSync(script)) {
		return { command: process.execPath, args: [script, ...args] };
	}
	const runtime = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(runtime)) return { command: process.execPath, args };
	return { command: "pi", args };
}

/** A child that stated no verdict reports `unknown`, which is not the same as a failure. */
export function readVerdict(report: string): ReportedVerdict {
	const match = VERDICT_LINE.exec(report);
	if (!match?.[1]) return "unknown";
	return match[1].toLowerCase() as ReportedVerdict;
}

/** The verdict line is a protocol marker, not part of what the caller reads. */
export function stripVerdict(report: string): string {
	return report.replace(VERDICT_LINE, "").trimEnd();
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("")
		.trim();
}

/** Exported for the tests: this is where a caller's trust in the evidence is decided. */
export function recordEvidence(evidence: Evidence, toolName: string, args: unknown): void {
	if (!args || typeof args !== "object") return;
	const record = args as Record<string, unknown>;

	if (WRITE_TOOLS.has(toolName)) {
		const path = record.file_path ?? record.path;
		if (typeof path === "string" && !evidence.changed.includes(path)) evidence.changed.push(path);
		return;
	}
	if (toolName === "bash" && typeof record.command === "string") {
		evidence.commands.push(record.command);
	}
}

export async function runAgent(
	name: string,
	definition: AgentDefinition,
	prompt: string,
	options: RunOptions,
): Promise<AgentRun> {
	const startedAt = Date.now();
	const evidence: Evidence = { changed: [], commands: [] };
	const model = options.model;

	let usage: Usage = emptyUsage();
	let turns = 0;
	let report = "";
	let stderr = "";

	const finish = (exitCode: number, failure?: string): AgentRun => ({
		name,
		agent: definition.name,
		model,
		ignoredModel: options.ignoredModel,
		verdict: failure ? "unknown" : readVerdict(report),
		report: stripVerdict(report),
		evidence,
		usage,
		turns,
		exitCode,
		ms: Date.now() - startedAt,
		failure,
	});

	const args = ["--mode", "json", "-p", "--no-session", "--tools", definition.tools.join(",")];
	if (model) args.push("--model", model);
	if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);

	let promptDir: string | undefined;
	try {
		promptDir = await mkdtemp(join(tmpdir(), "hyprsh-agent-"));
		const promptFile = join(promptDir, `${definition.name}.md`);
		await writeFile(promptFile, definition.systemPrompt, { encoding: "utf-8", mode: 0o600 });
		args.push("--append-system-prompt", promptFile);
		args.push(prompt);

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = piInvocation(args);
			const child = spawn(invocation.command, invocation.args, {
				cwd: options.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			const kill = () => child.kill("SIGTERM");
			options.signal?.addEventListener("abort", kill, { once: true });

			let buffer = "";
			const handleLine = (line: string) => {
				if (!line.trim()) return;
				let event: { type?: string; toolName?: string; args?: unknown; message?: AssistantMessage };
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
					recordEvidence(evidence, event.toolName, event.args);
					options.onProgress?.();
					return;
				}
				if (event.type === "message_end" && event.message?.role === "assistant") {
					turns++;
					usage = addUsage(usage, event.message.usage);
					const text = assistantText(event.message);
					// The last assistant message that says anything is the report.
					if (text) report = text;
					options.onProgress?.();
				}
			};

			child.stdout.setEncoding("utf-8");
			child.stdout.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) handleLine(line);
			});
			child.stderr.setEncoding("utf-8");
			child.stderr.on("data", (chunk: string) => {
				stderr += chunk;
			});

			child.on("error", (error) => {
				stderr += `${error.message}\n`;
				options.signal?.removeEventListener("abort", kill);
				resolve(1);
			});
			child.on("close", (code) => {
				if (buffer.trim()) handleLine(buffer);
				options.signal?.removeEventListener("abort", kill);
				resolve(code ?? 1);
			});
		});

		if (options.signal?.aborted) return finish(exitCode, "aborted before the child reported");
		if (exitCode !== 0) return finish(exitCode, stderr.trim() || `child exited with code ${exitCode}`);
		if (!report) return finish(exitCode, stderr.trim() || "child produced no report");
		return finish(exitCode);
	} catch (error) {
		return finish(1, error instanceof Error ? error.message : String(error));
	} finally {
		if (promptDir) await rm(promptDir, { recursive: true, force: true }).catch(() => {});
	}
}
