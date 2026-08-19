/**
 * Which model a child runs on.
 *
 * A child used to inherit the dispatching session's model unconditionally, so
 * a scout running `ls` cost what the parent costs. Naming a model in the agent
 * definition would fix that and introduce a worse failure: a model ID that is
 * wrong, or right for a provider the user is not on, kills the child at spawn
 * with nothing useful to say. So nothing here is trusted. A requested model is
 * matched against the models the registry reports as actually available, and
 * anything that does not match is dropped in favour of inheriting, which is
 * always safe because the parent is by definition running on it.
 *
 * `tier` exists so the definitions can ship an intention rather than an ID.
 * `cheap` means "the least expensive model on whatever provider this session is
 * already using", which is portable in a way that `claude-haiku-4-5` is not.
 *
 * Everything chosen here leaves as `provider/id`, never a bare ID. 221 of the
 * 1267 models pi ships are offered by more than one provider, `claude-haiku-4-5`
 * among them, and pi's CLI resolves a bare ambiguous ID by looking for exactly
 * one authenticated provider that offers it. A user authenticated with two of
 * them gets `Model "..." is ambiguous across providers` and a dead child, which
 * is precisely the spawn failure this module exists to prevent.
 */

/** Absent means inherit. Only one tier exists because only one is useful so far. */
export type AgentTier = "cheap";

export const TIERS: readonly AgentTier[] = ["cheap"];

export function isTier(value: unknown): value is AgentTier {
	return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

/** The part of pi-ai's `Model` needed to choose one; real models satisfy it structurally. */
export interface ModelChoice {
	id: string;
	provider: string;
	cost?: { input?: number; output?: number };
}

export interface AgentModelRequest {
	/** Explicit model from the agent definition's frontmatter. */
	model?: string;
	tier?: AgentTier;
	/**
	 * How hard this agent should think, from its own frontmatter.
	 *
	 * Independent of which model it runs on: recon wants a short leash whether it
	 * is on the cheapest model or the parent's. Left unset, the child gets the
	 * user's global `defaultThinkingLevel`, which is pi's own behaviour.
	 */
	thinking?: ThinkingLevel;
}

/** Provider and ID together, because an ID alone does not identify a model. */
export interface ModelRef {
	id: string;
	provider: string;
}

/** What pi's `--model` accepts unambiguously. */
export function qualify(model: ModelRef): string {
	return `${model.provider}/${model.id}`;
}

/** pi's own set; anything outside it would be rejected by the child at startup. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** Per-agent overrides from pi-hyprsh.json. Both are checked before use, never trusted. */
export interface AgentOverride {
	model?: string;
	thinking?: ThinkingLevel;
}

export interface Resolution {
	/** `undefined` means inherit the dispatching session's model. */
	model?: ModelRef;
	/** An explicit level to pass, from config or the agent's own definition. */
	thinking?: ThinkingLevel;
	/** True when the child follows the session for both model and thinking level. */
	inheritThinking: boolean;
	/** A model was asked for by name and could not be used. Worth showing, never worth failing over. */
	ignored?: string;
}

const INHERIT: Resolution = { inheritThinking: true };

/** Total price per million tokens, used only to rank candidates against each other. */
function price(model: ModelChoice): number {
	return (model.cost?.input ?? Number.POSITIVE_INFINITY) + (model.cost?.output ?? Number.POSITIVE_INFINITY);
}

/**
 * The cheapest model on the session's own provider.
 *
 * Restricted to that provider because a child inherits the parent's environment
 * and credentials: the cheapest model overall may be one this user cannot reach.
 * Ties break on ID so the choice does not wander between runs.
 */
function cheapest(available: readonly ModelChoice[], provider: string): ModelChoice | undefined {
	const candidates = available
		.filter((model) => model.provider === provider && Number.isFinite(price(model)))
		.sort((a, b) => price(a) - price(b) || a.id.localeCompare(b.id));
	return candidates[0];
}

export function resolveAgentModel(
	request: AgentModelRequest,
	override: AgentOverride | undefined,
	available: readonly ModelChoice[],
	session: { id?: string; provider?: string } | undefined,
): Resolution {
	// Applies whatever the model turns out to be, including a child that inherits
	// it: how hard to think and which model to think with are separate questions.
	const thinking = override?.thinking ?? request.thinking;
	const withThinking = (resolution: Resolution): Resolution =>
		thinking ? { ...resolution, thinking, inheritThinking: false } : resolution;

	const requested = override?.model?.trim() || request.model?.trim();
	if (requested) {
		// `provider/id` is accepted as well as a bare ID, so a user who has already
		// hit the ambiguity can spell their way out of it in config.
		const match = available.find((model) => model.id === requested || qualify(model) === requested);
		if (!match) return withThinking({ ...INHERIT, ignored: requested });
		return withThinking({
			model: { id: match.id, provider: match.provider },
			inheritThinking: match.id === session?.id && match.provider === session?.provider,
		});
	}

	if (request.tier === "cheap" && session?.provider) {
		const pick = cheapest(available, session.provider);
		// Already on the cheapest model: inherit, so the session's thinking level survives.
		if (pick && pick.id !== session.id) {
			return withThinking({
				model: { id: pick.id, provider: pick.provider },
				inheritThinking: false,
			});
		}
	}

	return withThinking(INHERIT);
}
