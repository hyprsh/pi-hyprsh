/**
 * Condensed thinking blocks — the middle ground between pi's own
 * `hideThinkingBlock: true` and the full transcript.
 *
 * Built on `pi.registerMarkdownTransformer`, which is display-only: the
 * thinking stays whole in the session and in model context, so nothing is lost
 * and `ctrl+o` style inspection keeps working on the original. Streaming
 * updates are passed through untouched — the live reasoning is worth watching —
 * and only finalised and restored blocks are condensed, which is also what
 * keeps the scrollback short.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThinkingConfig } from "../config.ts";
import { condense } from "./condense.ts";

export function registerThinking(pi: ExtensionAPI, config: ThinkingConfig): void {
	if (config.mode === "full") return;

	pi.registerMarkdownTransformer((markdown, { messageType, isStreaming }) => {
		if (messageType !== "assistant-thinking" || isStreaming) return markdown;
		return condense(markdown);
	});
}
