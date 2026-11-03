# The AGENTS.md block

Paste the section below into the repo's `AGENTS.md` (create the file if there is none). It tells every agent the rules the checks cannot enforce, and where to read first. Add it in a pull request of its own: `check-rule-files-alone.mjs` fails a pull request that changes `AGENTS.md` together with other files, apart from the decision log, ADRs, the manifest and its generated views.

```markdown
## Docs structure

- Read `specs/manifest.json` first, then the thread file in `specs/threads/` for the feature, then only the plan or design the task names.
- `node scripts/check-manifest.mjs` validates the manifest. Run `npm run kanban` and `npm run threads` after any change to the manifest, an ADR or a thread file. Never edit a generated block.
- Ids are stable and `created` never changes. Every card lists every tag that applies; every active card carries one acceptance line. Reuse a tag before adding one; a change to `metadata.threads[]` travels alone.
- Finished work: delete the card, and remove its id from every other card's `blocked_by` in the same change. Real but not now: `status: deferred` with a dated reason. The ceilings are `CEILINGS` in `scripts/lib/settings.mjs`, and the checker names the one a change breaks.
- Owner rulings go in `docs/ops/decision-log.md` under a stable `D-NNN` id, cited in the card's scope. Plans, designs and reviews live in `specs/plans/`, `specs/design/` and `specs/reviews/` with dated names; `ALLOWED_MARKDOWN` in `scripts/lib/settings.mjs` lists where else Markdown may go, and `scripts/check-docs-location.mjs` fails CI otherwise.
- A change to this file travels in its own pull request.
```
