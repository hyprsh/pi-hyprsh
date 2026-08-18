/**
 * Content extraction for web_fetch.
 *
 * HTML goes through Mozilla Readability and is converted to Markdown, which is
 * both what a reader sees and the cheapest representation in tokens. Everything
 * else is returned as the text it already is.
 *
 * The heavy parsers are imported lazily: this package also draws pi's footer,
 * and a session that never fetches a page should never pay for a DOM.
 */

export type ExtractionMethod = "readability" | "html" | "text" | "json" | "pdf" | "remote";

export interface Extracted {
	content: string;
	title?: string;
	method: ExtractionMethod;
}

const HTML_MIMES = ["text/html", "application/xhtml+xml"];
const TEXT_MIMES = ["text/", "application/json", "application/xml", "application/x-ndjson"];

export function mimeOf(contentType: string | null, bytes: Uint8Array): string {
	const declared = contentType?.split(";")[0]?.trim().toLowerCase();
	if (declared) return declared;
	const head = new TextDecoder().decode(bytes.slice(0, 512)).trimStart().toLowerCase();
	if (head.startsWith("%pdf")) return "application/pdf";
	if (head.startsWith("<!doctype html") || head.startsWith("<html")) return "text/html";
	if (head.startsWith("{") || head.startsWith("[")) return "application/json";
	return "application/octet-stream";
}

export function isHtml(mime: string): boolean {
	return HTML_MIMES.includes(mime);
}

export function isTextual(mime: string): boolean {
	return (
		TEXT_MIMES.some((prefix) => mime.startsWith(prefix)) || mime.endsWith("+json") || mime.endsWith("+xml")
	);
}

export function decodeBody(bytes: Uint8Array, contentType: string | null): string {
	const charset = /charset=([^;]+)/i
		.exec(contentType ?? "")?.[1]
		?.trim()
		.replace(/["']/g, "");
	try {
		return new TextDecoder(charset || "utf-8").decode(bytes);
	} catch {
		return new TextDecoder("utf-8").decode(bytes);
	}
}

async function toMarkdown(html: string): Promise<string> {
	const { default: TurndownService } = await import("turndown");
	const turndown = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
		hr: "---",
	});
	turndown.remove(["script", "style", "noscript", "iframe"]);
	return turndown
		.turndown(html)
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Readability first; a page it cannot article-ify still converts as a whole document. */
export async function extractHtml(html: string, url: string): Promise<Extracted> {
	const { parseHTML } = await import("linkedom");
	const { Readability } = await import("@mozilla/readability");

	const { document } = parseHTML(html);
	const documentTitle = document.title?.trim() || undefined;

	// Readability resolves relative links against the document's base URI, which a
	// string of HTML does not have. Without this every link comes back as "/path".
	if (!document.querySelector("base[href]") && document.head) {
		const base = document.createElement("base");
		base.setAttribute("href", url);
		document.head.insertBefore(base, document.head.firstChild);
	}

	let article: { title?: string | null; content?: string | null } | null = null;
	try {
		article = new Readability(document as never, { charThreshold: 200 }).parse();
	} catch {
		article = null;
	}

	if (article?.content) {
		const content = await toMarkdown(article.content);
		if (content.length >= 200) {
			return { content, title: article.title?.trim() || documentTitle, method: "readability" };
		}
	}

	// A fragment without <body> parses to an empty body; fall back to the raw input.
	const body = document.body?.innerHTML || html;
	return { content: await toMarkdown(body), title: documentTitle, method: "html" };
}

export async function extractPdf(bytes: Uint8Array): Promise<Extracted> {
	const { extractText, getDocumentProxy } = await import("unpdf");
	const document = await getDocumentProxy(bytes);
	const { text } = await extractText(document, { mergePages: true });
	const content = (Array.isArray(text) ? text.join("\n\n") : text).replace(/\n{3,}/g, "\n\n").trim();
	if (!content) throw new Error("PDF contains no extractable text (it is probably a scan)");
	return { content, method: "pdf" };
}

export function extractText(bytes: Uint8Array, contentType: string | null, mime: string): Extracted {
	const raw = decodeBody(bytes, contentType);
	if (mime === "application/json" || mime.endsWith("+json")) {
		try {
			return { content: JSON.stringify(JSON.parse(raw), null, 2), method: "json" };
		} catch {
			return { content: raw, method: "text" };
		}
	}
	return { content: raw.replace(/\r\n/g, "\n").trim(), method: "text" };
}
