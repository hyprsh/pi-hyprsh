/**
 * Engineering constitution.
 *
 * The rules in AGENTS.md next to this file are appended to the system prompt
 * of every turn, so they travel with the extension instead of depending on a
 * copy in ~/.pi/agent/AGENTS.md. Repository-local AGENTS.md files are loaded
 * by pi itself and still apply on top.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Bundled with the package; a missing file is a packaging error, not a runtime state. */
function constitution(): string {
	return readFileSync(join(import.meta.dirname, "AGENTS.md"), "utf-8").trim();
}

export function registerConstitution(pi: ExtensionAPI): void {
	const rules = constitution();

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${rules}`,
	}));
}
