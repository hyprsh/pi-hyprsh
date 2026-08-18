/**
 * Extractive condensation of a thinking block.
 *
 * Reasoning models write in paragraphs that open with the point and then argue
 * it, and OpenAI-style reasoning summaries put a bold header on each section.
 * One line per block — the header if there is one, otherwise the opening
 * sentence — therefore keeps the shape of the thought while dropping the
 * argument. List items keep a line each, since a list is already a set of
 * points rather than one. Nothing is rewritten, so what is shown was written
 * by the model.
 */

/** Same cap as the todo panel, so no single block can take over the scrollback. */
const MAX_LINES = 12;

const HEADING = /^#{1,6}\s+\S/;
const BOLD_HEADING = /^\*\*[^*]+\*\*:?$/;
const LIST_MARKER = /^([-*+]|\d+[.)])\s+/;
const FENCE = /^(```|~~~)/;
/** A sentence ends at punctuation followed by space or end, so `index.ts` is safe. */
const SENTENCE = /^(.+?[.!?])(?:\s|$)/;

function isHeading(line: string): boolean {
	return HEADING.test(line) || BOLD_HEADING.test(line);
}

function firstSentence(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return SENTENCE.exec(flat)?.[1] ?? flat;
}

/** Empty for blocks that carry no summary line of their own, such as code. */
function condenseBlock(block: string): string[] {
	const trimmed = block.trim();
	if (!trimmed || FENCE.test(trimmed)) return [];

	const first = trimmed.split("\n")[0]?.trim() ?? "";
	if (isHeading(first)) return [first];
	if (!LIST_MARKER.test(first)) return [firstSentence(trimmed)];

	return trimmed
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => LIST_MARKER.test(line))
		.map((line) => `- ${firstSentence(line.replace(LIST_MARKER, ""))}`);
}

function contentLines(markdown: string): number {
	return markdown.split("\n").filter((line) => line.trim()).length;
}

/**
 * Returns the markdown unchanged when condensing would not shorten it, so a
 * two-line thought is never decorated with an elision it does not need.
 */
export function condense(markdown: string): string {
	const blocks = markdown.split(/\n\s*\n/);
	const summary = blocks.flatMap(condenseBlock);

	const kept = summary.slice(0, MAX_LINES);
	if (kept.length === 0) return markdown;

	const dropped = contentLines(markdown) - kept.length;
	if (dropped <= 0) return markdown;

	const lines = [...kept, `*… ${dropped} more ${dropped === 1 ? "line" : "lines"}*`];
	/** Bullets belong to one list, so they are not separated by blank lines. */
	return lines
		.map((line, index) =>
			index > 0 && line.startsWith("- ") && lines[index - 1]?.startsWith("- ") ? line : `\n${line}`,
		)
		.join("\n")
		.trim();
}
