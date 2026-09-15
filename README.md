# repo-docs-structure

A fixed way to keep a repo's documents in order, so AI agents write and read them the same way every time.

It was built and proven in one production repo. This repo captures it so it can be installed elsewhere.

## What you get

One file, a few folders, three checks, and a short rule for agents.

| Piece | What it is |
|---|---|
| `specs/manifest.json` | One file that lists the project's current state, the work queue, and where every document lives |
| `specs/` and `docs/` folders | Fixed homes for plans, designs, reviews, decisions, and how-to guides |
| Three scripts | Check the manifest, draw the board from it, and block markdown files in the wrong place |
| A block in `AGENTS.md` | Tells the agent: read the manifest first, keep ids stable, run the board script after edits |

## Folder layout

```
specs/
  manifest.json      the one source of truth for project state
  KANBAN.md          generated from the manifest, never edit by hand
  design/            design documents, one per topic, dated
  plans/             work plans, dated
  reviews/           review findings, dated

docs/
  README.md          one line per document
  adr/               decisions, numbered 0001, 0002, ...
  ops/               how-to guides and runbooks

scripts/
  check-manifest.mjs        checks the manifest is filled in correctly
  kanban.mjs                draws specs/KANBAN.md from the manifest
  check-docs-location.mjs   blocks new .md files outside the allowed folders
  changed-files.mjs         helper the location check uses
```

File names in `design/`, `plans/`, and `reviews/` look like `2026-09-15-short-name.md`.

## The manifest

`specs/manifest.json` has two jobs.

**1. The work queue.** An array called `next[]`. Each item is one piece of work.

| Field | Rule |
|---|---|
| `id` | lowercase letters, numbers, dashes. Never changes once set |
| `title` | 3 to 8 words |
| `created` | date as `YYYY-MM-DD`. Never changes once set |
| `priority` | whole number from 1 (highest) to 7 |
| `status` | one of `pending`, `in_progress`, `paused`, `blocked`, `open`, `draft` |
| `scope` | what the work is, in plain text |

When work is finished, delete its item. There is no "done" status.

**2. The registries.** Arrays called `adrs[]`, `plans[]`, `specs[]`, `reviews[]`. Each entry points at a file. The check fails if the file does not exist.

Also at the top: `project`, `created`, `last_updated`, `status`, and a `current_state` object for live facts like what is deployed.

## Decisions (ADRs)

Decisions live in `docs/adr/` as `0001-short-name.md`, `0002-short-name.md`, and so on.

Every decision file has these seven headings, in this order:

```
## Status
## Date
## Context
## Decision
## Consequences
## Alternatives Considered
## References
```

Status is `Proposed`, `Accepted`, or `Superseded by NNNN`.

Once a decision is `Accepted`, do not edit it. If the decision changes, write a new one and mark the old one as superseded.

## The three checks

Run them locally or in CI. Each exits non-zero on failure.

| Command | What it checks |
|---|---|
| `node scripts/check-manifest.mjs` | Required fields present, ids unique, dates valid, files exist, board is up to date |
| `node scripts/kanban.mjs` | Rewrites `specs/KANBAN.md`. Add `--check` to only test if it is stale |
| `node scripts/check-docs-location.mjs` | Fails if a new `.md` file was added outside the allowed folders |

The manifest check also warns, without failing, when:

- an item is older than 60 days
- there are more than 30 items
- there are more than 10 priority-1 items

These warnings are the signal that the queue needs cleaning.

## What the agent is told

This block goes in the repo's `AGENTS.md`:

```
## Specs
- specs/manifest.json is the source of mutable project state.
- node scripts/check-manifest.mjs validates the manifest.
- Run the kanban script to regenerate the only derived view.
- Keep next[] ids stable and never change created.

## Read first
1. Read specs/manifest.json.
2. Read only the plan or design file for the task.
```

## Where new markdown may go

Only these places:

- `docs/**`
- `specs/design/**`, `specs/plans/**`, `specs/reviews/**`
- any `README.md`
- `AGENTS.md`, `CLAUDE.md`
- `.agents/**`, `.github/**`

Anywhere else, the location check fails.

## Status of this repo

Captured on 2026-09-15 from the source repo, as-is. Nothing has been changed or cleaned up yet.

Known rough edges carried over:

- The ADR format is a written rule only. No script checks the seven headings.
- The source manifest grew to about 106 KB because long paragraphs were stored inside JSON fields.
- Some parts of the scripts are tied to the source repo (its folder names, its package manager). They are not yet generic.

## Next step

Copy the four scripts and the folder layout into this repo, unchanged, as the starting point.
