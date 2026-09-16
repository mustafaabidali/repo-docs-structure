# repo-docs-structure

One manifest, fixed folders, tags that group work into threads, and checks that fail the build when any of it drifts. Install it once and every AI agent that touches the repo documents it the same way.

## The problem

When AI agents work on a repo for months, the documents rot.

- Plans, notes, and decisions get dropped in random folders. Nobody can find them later.
- Each agent session starts blind. It re-reads half the repo to work out what is done and what is next.
- The same question gets decided three times because the first two decisions were never written down, or were written down somewhere nobody looks.
- The to-do list grows. Twenty items marked top priority means priority has stopped meaning anything.
- Work about one feature is spread across a plan, two design files, a decision record, and a review. Nothing says they belong together.

The result: you cannot answer "what is the state of this project?" without an hour of digging. You cannot answer "what has happened to login?" either. Neither can the agent.

## The fix

Give the agent one place to look, a way to see one feature at a time, and rules it cannot break.

- **One file is the truth.** `specs/manifest.json` holds the work queue and a pointer to every document. The agent reads it first, every session.
- **Every card and document carries tags.** A tag names a feature or a milestone: `login`, `search`, `pre-announcement`. One generated file per tag collects everything about it under a hand-written paragraph that says where things stand.
- **Documents have fixed homes.** Plans in `specs/plans/`, designs in `specs/design/`, decisions in `docs/adr/`. A check fails the build if a markdown file lands anywhere else, or if a file in those folders is not registered.
- **Decisions are written once and never lost.** Architecture decisions are numbered files with fixed headings. Once accepted, never edited. Smaller rulings go in one append-only decision log with stable ids.
- **The queue has a ceiling.** At most 30 active cards, 10 at top priority, at most 1 in progress. Above that the build fails. Cards that are real but not now are deferred with a dated reason, not deleted.
- **Scripts enforce the rules, not prose.** Rules that live only in an instructions file get ignored. Rules that break CI (the checks that run on every pull request) do not.

## Status

This describes the design a production repo is moving to as of 2026-09-16. The earlier version (no tags, no ceilings, one 108 KB manifest) ran for five months. The redesign is planned and reviewed but not yet landed. When it lands, the scripts and templates will be copied here.

## What you get

| Piece | What it is |
|---|---|
| `specs/manifest.json` | The work queue and the document registries. Validated against a JSON Schema (a file that says which keys and values are allowed). |
| `specs/manifest.schema.json` | The schema. Editors validate the manifest live. |
| `specs/threads/<tag>.md` | One file per tag. Hand-written state at the top, generated list of cards and documents below. |
| `specs/KANBAN.md` | Generated board. Columns: Owner gate, In progress, Next up (P1), Backlog (P2), Later, Paused, Deferred, Done. Active cards show their acceptance line. |
| `specs/{design,plans,reviews}/` | Fixed homes for documents, dated filenames. |
| `docs/adr/` | Architecture decision records (ADRs), numbered `0001`, `0002`, and so on. Each carries its own tags. |
| `docs/ops/decision-log.md` | Owner rulings, one entry per decision, append-only. |
| `docs/ops/` | How-to guides and runbooks. |
| Five scripts | Validate the manifest, draw the board, draw the threads, block markdown in the wrong place, keep rule-file changes in their own pull request. |
| A short block in `AGENTS.md` | Tells the agent the rules. |

## Requirements

- Node.js 22 or newer.
- Two dev dependencies, pinned to exact versions: `ajv` (version 8 line) and `ajv-formats`. They validate the manifest against the schema.
- Three scripts in `package.json`: `kanban`, `threads`, `test:manifest`.
- One CI step that runs `check-manifest.mjs`, `check-docs-location.mjs`, `check-rule-files-alone.mjs`, and `test:manifest` on every pull request.

## Folder layout

```
specs/
  manifest.json          work queue and registries
  manifest.schema.json   shape of the manifest
  KANBAN.md              generated, never edit by hand
  threads/               generated, one file per tag
    login.md
    search.md
    ...
  design/                design documents, one per topic, dated
  plans/                 work plans, dated
  reviews/               review findings, dated

docs/
  README.md              index of the docs folder
  adr/                   decisions, numbered, each with a Tags section
  ops/
    decision-log.md      owner rulings, append-only
    ...                  runbooks and guides

scripts/
  check-manifest.mjs        validates the manifest and every cross-reference
  kanban.mjs                draws specs/KANBAN.md
  threads.mjs               draws specs/threads/*.md and the ADR index
  check-docs-location.mjs   blocks new .md files outside the allowed folders
  check-rule-files-alone.mjs  rule files (AGENTS.md and friends) change in their own pull request
```

File names in `design/`, `plans/`, and `reviews/` look like `2026-09-15-short-name.md`.

## The manifest

```json
{
  "$schema": "./manifest.schema.json",
  "name": "Project Name",
  "last_updated": "2026-09-16",
  "work": {
    "active_plan": "plan-id",
    "next": [ ... ]
  },
  "metadata": {
    "threads": [ ... ],
    "plans": [ ... ],
    "specs": [ ... ],
    "reviews": [ ... ]
  }
}
```

Two blocks. `work` changes weekly. `metadata` changes when a document lands.

### A card

One item of work in `work.next[]`.

```json
{
  "id": "smtp-otp-config",
  "title": "Configure custom SMTP and reconcile OTP settings",
  "created": "2026-08-03",
  "priority": 1,
  "status": "pending",
  "actor": "owner",
  "tags": ["login", "otp", "email-otp", "pre-announcement"],
  "acceptance": "Custom SMTP sends an email OTP in production and the config runbook records the provider.",
  "scope": "Configure custom SMTP before the public announcement. Reconcile OTP expiry and OTP length with the app UI and copy."
}
```

Required fields:

| Field | Rule |
|---|---|
| `id` | lowercase letters, numbers, dashes. Never changes once set. |
| `title` | 3 to 8 words. Warns outside that. |
| `created` | `YYYY-MM-DD`. Never changes once set. Never later than the file's `last_updated`. |
| `priority` | whole number from 1 (highest) to 7. |
| `status` | `pending`, `open`, `in_progress`, `paused`, `blocked`, or `deferred`. |
| `tags` | at least one. Every value must be a thread id. |
| `scope` | what the work is. |

Conditional fields:

| Field | Rule |
|---|---|
| `acceptance` | one testable line saying when the card is done. Required unless deferred. |
| `deferred` | `{ "date", "reason" }`. Required when status is `deferred`. |

Optional fields:

| Field | Rule |
|---|---|
| `actor` | `owner` or `agent`. Absent means `agent`. Owner cards show in their own board column. |
| `blocked_by` | array of card ids. Each must exist. |
| `plan`, `spec` | one registry id each. Must exist. |
| `branch` | a git branch name. |

No other keys. The schema rejects them.

When work is finished, delete the card. There is no done status. When work is real but not now, set `status: deferred` with a dated reason. Deferred cards stay in the file and do not count toward the ceilings.

### Ceilings

Counted on active cards only. The build fails above them.

| Ceiling | Value |
|---|---|
| Total active | 30 |
| Priority 1 | 10 |
| In progress | at most 1. If one exists, its `plan` must equal `active_plan`. |
| Owner cards | 10 |

### A thread

One entry in `metadata.threads[]` defines one tag.

```json
{ "id": "login", "title": "Login and sign-in", "file": "specs/threads/login.md", "created": "2026-09-16" }
```

Four fields. No description. Tags are flat: no parent, no aliases. A card lists every tag that applies, most general first.

A tag not in this list fails the build, and the error lists every valid id. To add a tag, add it here in a pull request (a proposed change others review before it merges) that touches nothing else.

### A registry entry

Plans, specs, and reviews each have one.

```json
{ "id": "phone-auth", "title": "Phone Auth", "file": "specs/design/2026-06-04-phone-auth.md", "created": "2026-06-04", "status": "approved", "tags": ["login", "otp", "phone-otp"] }
```

Required: `id`, `title`, `file`, `created`, `status`, `tags`.

Optional, with rules:

| Field | Rule |
|---|---|
| `depends_on` | array of plan or spec ids. Each must exist. |
| `supersedes`, `superseded_by` | one id each. If X supersedes Y, Y must say superseded by X. |
| `actor` | `owner` or `agent`, same as on cards. |
| `branch` | a git branch name. |
| `figma` | object with `file` and `page_id`. For designs that have a Figma page. |

No other keys.

Every file under `specs/plans/`, `specs/design/`, and `specs/reviews/` must have an entry, and every entry must point at a file that exists. Both directions are checked.

## Thread files

`specs/threads/login.md`:

```markdown
# Login

## Current state
Phone OTP is live and primary. Google OAuth is live. Apple and Facebook wait on
the App Store account and Meta verification.

## Log (optional)
- 2026-08-11 Apple and Facebook deferred.
- 2026-06-04 Phone OTP shipped as primary.

<!-- generated:start -->
## Active cards
- P1 smtp-otp-config  Configure custom SMTP and reconcile OTP settings
...
## Deferred cards
...
## Plans
...
## Designs
...
## Reviews
...
## Decisions
- ADR-0004 Phone Sign-In Ships Before Email (Accepted)
<!-- generated:end -->
```

Everything above the marker is written by hand and rewritten when the feature moves. The current-state paragraph is required. The log is optional. Everything below the marker is generated from tags.

The hand-written part is the point. It is the complete answer to "where are we on login," not a list of links.

## Decisions (ADRs)

Architecture decision records (ADRs) live in `docs/adr/` as `0001-short-name.md`, `0002-short-name.md`, and so on. They are not registered in the manifest. The file is the record.

Every decision file has these eight headings, in this order:

```
## Status
## Tags
## Date
## Context
## Decision
## Consequences
## Alternatives Considered
## References
```

Status is `Proposed`, `Accepted`, or `Superseded by NNNN`. Tags is a comma-separated list of thread ids.

Once a decision is `Accepted`, do not edit it, except to change its status or its tags. If the decision changes, write a new one and mark the old one as superseded.

The index table in `docs/adr/README.md` is generated from the files.

## Decision log

`docs/ops/decision-log.md` holds smaller owner rulings that do not deserve an ADR: which option was picked, on what date, and why in one line. Each entry has a stable id like `D-042`. A card's scope can cite the id, and the check fails if the id does not exist. The log is append-only by rule.

## The checks

Run locally or in CI. Each exits non-zero on failure.

| Command | What it checks |
|---|---|
| `node scripts/check-manifest.mjs` | Schema. Every tag resolves. Every pointer resolves. `active_plan` exists. Every file registered and present. ADR headings and tags. Ceilings. Decision ids. Board and threads fresh. |
| `node scripts/kanban.mjs` | Rewrites `specs/KANBAN.md`. `--check` only tests if it is stale. |
| `node scripts/threads.mjs` | Rewrites every thread file and the ADR index. `--check` only tests. |
| `node scripts/check-docs-location.mjs` | Fails if a new `.md` file was added outside the allowed folders. |

Warnings, not failures: a thread with no cards or documents; a card deferred more than 90 days ago; an active card older than 60 days; a title outside 3 to 8 words.

## What the agent is told

The block in `AGENTS.md`:

```
## Specs
- specs/manifest.json is the source of mutable project state.
- node scripts/check-manifest.mjs validates it.
- Run the kanban and threads scripts after any manifest change.
- Keep ids stable and never change created.
- Every card lists every tag that applies and one acceptance line.
- Reuse an existing tag before adding one. Thread list changes travel alone.
- Defer with a dated reason instead of deleting.
- Owner rulings go in docs/ops/decision-log.md.

## Read first
1. Read specs/manifest.json.
2. Open the thread file for the feature you are working on.
3. Read only the plan or design file for the task.
```

## Where new markdown may go

The default list. Add your own app folders to `ALLOWED_MARKDOWN` in `check-docs-location.mjs`.

- `docs/**`
- `specs/design/**`, `specs/plans/**`, `specs/reviews/**`, `specs/threads/**`
- any `README.md`
- `AGENTS.md`, `CLAUDE.md`
- `.agents/**`, `.github/**`

Anywhere else, the location check fails.

## Rules behind the design

- **Every fact has one home.** The manifest points at documents; it does not copy them. Deployment state lives in runbooks. Stack facts live in `AGENTS.md` and ADRs. Nothing is stored twice.
- **A value with a rule is a field. Membership in a group is a tag.** `priority: 1` is a field. `login` is a tag. Who acts next is `actor`, a field, because it is a workflow state and not a feature.
- **If it cannot be checked, it is one line in AGENTS.md or it is gone.** Most rules became scripts. The few that cannot (never change `created`, append-only log) stay as prose.
- **Nothing is deleted, only deferred.** A card with a dated reason is a log entry. An undated pile is a backlog.

## Next step

When the source repo lands the redesign, copy the five scripts, the schema, and the templates here unchanged.
