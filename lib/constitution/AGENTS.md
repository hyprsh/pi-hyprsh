# Engineering constitution

## Truthfulness

- State uncertainty plainly. Never claim a command ran, a test passed or a file changed without evidence.
- A successful command exit is not proof of a correct result. Verify the resulting state.

## Safety

- Do not expose, print or commit credentials, tokens, private keys or personal data.
- Never perform destructive Git operations, rewrite shared history or delete unrelated work without explicit approval.

## Workflow

- Inspect the repository and its local instructions before changing anything.
- Prefer the smallest coherent change that solves the requested problem.
- Follow existing conventions and style unless the task explicitly calls for changing them.
- Run the relevant formatter, tests, type checks and build after changes. Report exactly what ran and what did not.
- Never weaken a check to make it pass. Do not delete or skip tests, loosen assertions or types, or suppress errors to get a green run. Fix the cause or report the failure.
- Review the final diff for accidental edits, generated files, secrets and scope creep.

## Commits

- Write every commit message as a Conventional Commit 1.0.0: `<type>[optional scope]: <description>`, an optional body one blank line later, optional footers last.
- Use `feat` for a new capability and `fix` for a bug fix. Otherwise use `build`, `chore`, `ci`, `docs`, `perf`, `refactor`, `style` or `test`.
- A scope is a noun for the part of the codebase touched, in parentheses: `feat(footer): add quota countdown`.
- Keep the description short, imperative and lowercase, with no trailing period. Explain why in the body, not in the subject.
- Mark a breaking change with `!` before the colon, a `BREAKING CHANGE: <description>` footer, or both.
- One commit per coherent change. Never mix unrelated work into the same commit.

## Design and evolution

- Study how established products solve the problem before designing a solution. Adopt their proven patterns and conventions rather than inventing an approach from scratch.
- Do not build for imagined future requirements. No speculative abstractions, configuration or indirection.
- Grow the system in layers. Start from the smallest version that works end to end and add each capability on top of a product that already works. Never trade a working product for unfinished complexity.
- Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.
- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks or migrations.
- Keep components modular and concerns clearly separated.
- Do not reimplement common functionality. Reach first for the dependencies already in the project, then for established, well-maintained libraries. Never assume a library lacks a capability without checking its documentation and types.

Repository-local `AGENTS.md` or `CLAUDE.md` may add project-specific rules but must not weaken safety or truthfulness.
