# Adopt the docs structure

The first plan of a repo that has just installed the docs structure. It is registered in `specs/manifest.json` as `plan-docs-structure` and is the manifest's `active_plan`, so the checks pass on day one. Replace it with the repo's real first plan when one exists, or keep it as the record of how the structure came in.

## Steps

1. Set `name` and `last_updated` in `specs/manifest.json`.
2. Replace the `docs-structure` thread with the repo's own features or milestones, one entry in `metadata.threads[]` each, in a pull request that touches nothing else. Write each thread file's current-state paragraph by hand, above its generated block.
3. Add a card to `work.next[]` for each piece of work, with every tag that applies and one acceptance line.
4. Move existing plans, designs and reviews into `specs/plans/`, `specs/design/` and `specs/reviews/` with dated names, and register each one. Existing architecture decisions become numbered files in `docs/adr/`, written from `docs/adr/TEMPLATE.md`.
5. If the repo keeps Markdown elsewhere by design, add those folders to `ALLOWED_MARKDOWN` in `scripts/check-docs-location.mjs`. If the agents read rules from other files, add them to `RULE_FILES` in `scripts/check-rule-files-alone.mjs`.
6. Paste the block in `docs/agents-md-block.md` into the repo's `AGENTS.md`, in a pull request of its own.
7. Run `npm run kanban && npm run threads`, then `npm run check`.

## Done when

`npm run check` passes in CI on the repo's default branch, and the manifest holds the repo's own threads, cards and plans.
