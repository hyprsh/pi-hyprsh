/**
 * Rendering for delegated work: the text the caller reads, and the panel above
 * the editor while children are running.
 *
 * The text keeps observed facts and self-reported ones visibly apart. A child
 * saying it passed sits next to the files it actually touched, so the caller
 * can see the two disagree.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentRun, ReportedVerdict } from "../agents/index.ts";

export const MAX_PANEL_LINES = 8;
/** A report longer than this is a child that ignored its brief; keep the head. */
const MAX_REPORT_LINES = 40;

const MARKS: Record<ReportedVerdict, string> = {
	pass: "✔",
	issues: "!",
	blocked: "✗",
	unknown: "?",
};

function seconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function clampReport(report: string): string {
	const lines = report.split("\n");
	if (lines.length <= MAX_REPORT_LINES) return report;
	const dropped = lines.length - MAX_REPORT_LINES;
	return `${lines.slice(0, MAX_REPORT_LINES).join("\n")}\n… ${dropped} more lines`;
}

function evidenceLines(run: AgentRun): string[] {
	const lines: string[] = [];
	if (run.evidence.changed.length > 0) lines.push(`changed: ${run.evidence.changed.join(", ")}`);
	if (run.evidence.commands.length > 0) lines.push(`ran: ${run.evidence.commands.join(" ; ")}`);
	if (lines.length === 0) lines.push("changed nothing on disk");
	return lines;
}

/**
 * Named only when it is not the session's own model. A child on a cheaper model
 * is worth seeing, and so is a configured model that was dropped as unavailable:
 * both look identical in the report otherwise.
 */
function modelSuffix(run: AgentRun, sessionModel: string | undefined): string {
	if (run.ignoredModel) return ` on ${run.model} (configured ${run.ignoredModel} is unavailable)`;
	if (!run.model || run.model === sessionModel) return "";
	return ` on ${run.model}`;
}

function formatRun(run: AgentRun, sessionModel: string | undefined): string {
	const head = `### ${run.name} (${run.agent}) — ${run.failure ? "failed" : run.verdict} in ${seconds(run.ms)}${modelSuffix(run, sessionModel)}`;
	if (run.failure) return `${head}\n${run.failure}`;

	return [
		head,
		`Observed: ${evidenceLines(run).join("; ")}`,
		"",
		clampReport(run.report) || "(no report)",
	].join("\n");
}

/** What the caller reads. Verdicts are the child's own claim and say so. */
export function formatRuns(
	runs: readonly AgentRun[],
	running: ReadonlySet<string>,
	sessionModel?: string,
): string {
	const parts = runs.map((run) => formatRun(run, sessionModel));
	if (running.size > 0) parts.push(`### still running: ${[...running].join(", ")}`);
	if (parts.length === 0) return "No units dispatched.";

	const done = runs.filter((run) => !run.failure);
	const accepted = done.filter((run) => run.verdict === "pass").length;
	const trailer =
		running.size === 0
			? `\n\n${accepted}/${runs.length} units report pass. A verdict is the child's own claim: inspect the diff and rerun the verification before accepting it.`
			: "";
	return parts.join("\n\n") + trailer;
}

export function panelLines(
	runs: readonly AgentRun[],
	running: ReadonlySet<string>,
	theme: Theme,
	width: number,
): string[] {
	if (running.size === 0) return [];

	const lines = [theme.bold(theme.fg("toolTitle", `Agents (${runs.length}/${runs.length + running.size})`))];
	for (const run of runs.slice(-(MAX_PANEL_LINES - 1))) {
		const mark = run.failure ? MARKS.blocked : MARKS[run.verdict];
		lines.push(theme.fg("success", ` ${mark} `) + theme.fg("dim", `${run.name} ${seconds(run.ms)}`));
	}
	for (const name of running) {
		if (lines.length >= MAX_PANEL_LINES) break;
		lines.push(theme.fg("accent", " ▶ ") + theme.fg("text", name));
	}
	return lines.map((line) => truncateToWidth(line, width));
}
