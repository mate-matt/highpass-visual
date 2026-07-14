# Issue tracker: Local Markdown

Issues and specs (PRDs) for this repo live as Markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`
- Triage state is recorded as a `Status:` line near the top of each issue file
- Comments and conversation history append under a `## Comments` heading

## Skill operations

- When a skill says “publish to the issue tracker,” create a file under `.scratch/<feature-slug>/`.
- When a skill says “fetch the relevant ticket,” read the referenced local Markdown file in full.
- Blocking edges are written in each ticket's `Blocked by:` field.
- Work the frontier: a ticket is implementable when every listed blocker is complete.

## Why local Markdown

The project is greenfield and currently has no configured Git remote. Local tickets keep product decisions, implementation edges, and agent context versioned with the code without introducing an external tracker dependency.
