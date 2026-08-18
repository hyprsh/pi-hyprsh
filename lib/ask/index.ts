/**
 * ask_user_question — a structured questionnaire the model can put to the user.
 *
 * Built on pi's own `ctx.ui.select` and `ctx.ui.input`, which work in TUI and
 * RPC hosts alike, so there is no custom component, no key routing and no host
 * fallback to maintain. Questions are asked one at a time, each prefixed with
 * its position (`[2/3]`) when more than one was sent; a multi-select question
 * loops the same selector until the user submits.
 *
 * The answer goes back as JSON so the model reads choices rather than prose.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_QUESTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const HEADER_MAX = 16;

const SUBMIT_ROW = "↵  Submit";
const CUSTOM_ROW = "✎  Type something…";

interface Option {
	label: string;
	description: string;
}

interface Question {
	header: string;
	question: string;
	options: Option[];
	multiSelect?: boolean;
}

interface Answer {
	header: string;
	question: string;
	selected: string[];
	custom?: string;
}

const OPTION = Type.Object({
	label: Type.String({ description: "The choice the user sees. One to five words." }),
	description: Type.String({
		description: "What this choice means or what it costs. One sentence, never a repeat of the label.",
	}),
});

const QUESTION = Type.Object({
	header: Type.String({
		maxLength: HEADER_MAX,
		description: `Short tag identifying the question in the answer, at most ${HEADER_MAX} characters.`,
	}),
	question: Type.String({ description: "The full question, ending in a question mark." }),
	multiSelect: Type.Optional(
		Type.Boolean({ description: "Allow several options to be chosen. Defaults to false." }),
	),
	options: Type.Array(OPTION, {
		minItems: MIN_OPTIONS,
		maxItems: MAX_OPTIONS,
		description: `${MIN_OPTIONS} to ${MAX_OPTIONS} distinct choices. A free-text row is appended automatically; do not author one.`,
	}),
});

/** Row text is what `ctx.ui.select` hands back, so every row must be unique. */
function optionRow(index: number, option: Option, chosen: boolean, multi: boolean): string {
	const mark = multi ? (chosen ? "✓ " : "  ") : "";
	const description = option.description.replace(/\s+/g, " ").trim();
	return `${index + 1}. ${mark}${option.label} — ${description}`;
}

function rowIndex(row: string): number | undefined {
	const match = /^(\d+)\./.exec(row);
	if (!match?.[1]) return undefined;
	return Number.parseInt(match[1], 10) - 1;
}

function validate(questions: Question[]): void {
	if (!Array.isArray(questions) || questions.length < 1 || questions.length > MAX_QUESTIONS) {
		throw new Error(`questions must hold between 1 and ${MAX_QUESTIONS} entries`);
	}
	for (const question of questions) {
		if (!question.question?.trim()) throw new Error("each question needs question text");
		if (!question.header?.trim() || question.header.length > HEADER_MAX) {
			throw new Error(`each header must be non-empty and at most ${HEADER_MAX} characters`);
		}
		if (question.options.length < MIN_OPTIONS || question.options.length > MAX_OPTIONS) {
			throw new Error(`each question needs ${MIN_OPTIONS} to ${MAX_OPTIONS} options`);
		}
		for (const option of question.options) {
			if (!option.label?.trim()) throw new Error("each option needs a label");
			if (!option.description?.trim()) throw new Error("each option needs a description");
		}
	}
}

/** Only shown when the questionnaire holds more than one question. */
function progress(index: number, total: number): string {
	return total > 1 ? `[${index + 1}/${total}] ` : "";
}

/** Undefined means the user abandoned the questionnaire. */
async function askOne(
	question: Question,
	index: number,
	total: number,
	ctx: ExtensionContext,
): Promise<Answer | undefined> {
	const multi = question.multiSelect === true;
	const chosen = new Set<number>();
	const prompt = `${progress(index, total)}${question.question}`;

	for (;;) {
		const rows = question.options.map((option, index) => optionRow(index, option, chosen.has(index), multi));
		if (multi) rows.push(SUBMIT_ROW);
		rows.push(CUSTOM_ROW);

		const title = multi ? `${prompt} (${chosen.size} chosen)` : prompt;
		const picked = await ctx.ui.select(title, rows);
		if (picked === undefined) return undefined;

		if (picked === CUSTOM_ROW) {
			const custom = await ctx.ui.input(prompt, "Your answer");
			if (custom === undefined || !custom.trim()) continue;
			return {
				header: question.header,
				question: question.question,
				selected: [...chosen].map((index) => question.options[index]?.label ?? ""),
				custom: custom.trim(),
			};
		}

		if (picked === SUBMIT_ROW) {
			if (chosen.size === 0) {
				ctx.ui.notify("Choose at least one option, or type your own answer.", "warning");
				continue;
			}
			return {
				header: question.header,
				question: question.question,
				selected: [...chosen].map((index) => question.options[index]?.label ?? ""),
			};
		}

		const index = rowIndex(picked);
		if (index === undefined || !question.options[index]) continue;

		if (!multi) {
			return {
				header: question.header,
				question: question.question,
				selected: [question.options[index].label],
			};
		}
		if (chosen.has(index)) chosen.delete(index);
		else chosen.add(index);
	}
}

export function registerAsk(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User",
		description:
			"Ask the user up to four questions with written-out options instead of guessing. Each question carries 2-4 labelled choices with a description of what each one means; a free-text row is appended automatically, and the user can abandon the questionnaire. Answers come back as JSON.",
		promptSnippet:
			"Ask the user structured questions with typed options when a decision is genuinely ambiguous.",
		promptGuidelines: [
			"Ask when a requirement is underspecified and a wrong guess would waste work, not to confirm what was already stated.",
			"Group everything you need into one call of up to four questions rather than asking repeatedly.",
			"Give every option a description of what it means or what it costs; put a recommended option first.",
		],
		parameters: Type.Object({
			questions: Type.Array(QUESTION, {
				minItems: 1,
				maxItems: MAX_QUESTIONS,
				description: `Between 1 and ${MAX_QUESTIONS} questions, asked one after another.`,
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) throw new Error("ask_user_question needs an interactive session");

			const questions = params.questions as Question[];
			validate(questions);

			const answers: Answer[] = [];
			for (const [index, question] of questions.entries()) {
				const answer = await askOne(question, index, questions.length, ctx);
				if (answer === undefined) {
					return {
						content: [{ type: "text", text: "The user cancelled the questionnaire. Ask in chat instead." }],
						isError: true,
						details: { cancelled: true, answers },
					};
				}
				answers.push(answer);
			}

			return {
				content: [{ type: "text", text: JSON.stringify({ answers }, null, 2) }],
				details: { cancelled: false, answers },
			};
		},
	});
}
