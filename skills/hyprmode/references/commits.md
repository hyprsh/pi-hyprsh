# Commits

Every commit message is a [Conventional Commit 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):
`<type>[optional scope]: <description>`, an optional body one blank line later,
optional footers last.

## Type

`feat` for a new capability, `fix` for a bug fix. Otherwise `build`, `chore`,
`ci`, `docs`, `perf`, `refactor`, `style` or `test`.

## Scope

A noun for the part of the codebase touched, in parentheses:
`feat(footer): add quota countdown`.

## Description

Short, imperative, lowercase, no trailing period. It says what the commit does,
not what you did.

## Body

Explain **why**, not what — the diff already says what. The most useful body
states the problem that existed before the change. If you cannot name one, ask
whether the commit earns its place.

## Breaking changes

Mark with `!` before the colon, a `BREAKING CHANGE: <description>` footer, or
both. The footer says what a user must now do differently.

## Scope of a commit

One commit per coherent change. Never mix unrelated work. If the body needs the
word "also", it is two commits.
