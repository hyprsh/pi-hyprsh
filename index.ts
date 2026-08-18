/**
 * pi-hyprsh — Pi extension pack for this environment.
 *
 * Features are toggled in ~/.pi/agent/pi-hyprsh.json. Everything is on by
 * default.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAsk } from "./lib/ask/index.ts";
import { loadConfig } from "./lib/config.ts";
import { registerConstitution } from "./lib/constitution/index.ts";
import { registerContext } from "./lib/context/index.ts";
import { registerFooter } from "./lib/footer/index.ts";
import { registerReason } from "./lib/reason/index.ts";
import { registerThinking } from "./lib/thinking/index.ts";
import { registerTodo } from "./lib/todo/index.ts";
import { registerWeb } from "./lib/web/index.ts";

export default function (pi: ExtensionAPI) {
	const config = loadConfig();

	if (config.features.footer) registerFooter(pi, config.footer);
	if (config.features.reason) registerReason(pi);
	if (config.features.context) registerContext(pi);
	if (config.features.web) registerWeb(pi);
	if (config.features.constitution) registerConstitution(pi);
	if (config.features.ask) registerAsk(pi);
	if (config.features.todo) registerTodo(pi);
	registerThinking(pi, config.thinking);
}
