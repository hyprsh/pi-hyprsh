/**
 * pi-hyprsh — Pi extension pack for this environment.
 *
 * Features are toggled in ~/.pi/agent/hypr/config.json. Everything is on by
 * default.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAsk } from "./lib/ask/index.ts";
import { configureCompact } from "./lib/compact/index.ts";
import { loadConfig } from "./lib/config.ts";
import { registerConstitution } from "./lib/constitution/index.ts";
import { registerContext } from "./lib/context/index.ts";
import { registerFooter } from "./lib/footer/index.ts";
import { registerReason } from "./lib/reason/index.ts";
import { registerTask } from "./lib/task/index.ts";
import { registerThinking } from "./lib/thinking/index.ts";
import { registerTodo } from "./lib/todo/index.ts";
import { registerWeb } from "./lib/web/index.ts";

export default function (pi: ExtensionAPI) {
	const config = loadConfig();

	// Tools are wrapped as they are defined below, so the switch has to be set first.
	configureCompact(config.features.compact);

	if (config.features.footer) registerFooter(pi, config.footer);
	if (config.features.reason) registerReason(pi);
	if (config.features.context) registerContext(pi);
	if (config.features.web) registerWeb(pi);
	if (config.features.constitution) registerConstitution(pi);
	if (config.features.ask) registerAsk(pi);
	if (config.features.todo) registerTodo(pi);
	// The quota thresholds mean the same thing here as in the footer: the point
	// at which an allowance is tight enough to change behaviour.
	if (config.features.task) registerTask(pi, config.footer.thresholds);
	registerThinking(pi, config.thinking);
}
