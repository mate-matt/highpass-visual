# Domain Docs

This repository uses a single domain context.

## Before exploring

- Read `CONTEXT.md` at the repository root when it exists.
- Read relevant decisions under `docs/adr/`.
- Use the glossary's canonical vocabulary in specs, tickets, tests, and implementation.
- Surface any ADR conflict explicitly before changing the affected design.

## Layout

```text
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

`CONTEXT.md` is a glossary only. Implementation details and technical trade-offs belong in PRDs, tickets, or ADRs.
