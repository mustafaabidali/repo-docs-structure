// Unit tests for scripts/lib/paths.mjs and the path lists of the two
// changed-file checks (check-docs-location.mjs, check-rule-files-alone.mjs).
//
// The checks read `git diff`; these cases feed the same classification a
// change set directly, so no git fixture is needed. The live diff is proven
// by CI on every pull request.

import assert from "node:assert/strict";
import { test } from "node:test";

import { ALLOWED_MARKDOWN } from "../check-docs-location.mjs";
import { ALLOWED_EXTRAS, RULE_FILES } from "../check-rule-files-alone.mjs";
import { disallowedMarkdown, glob, matchesAny, ruleFileViolations } from "./paths.mjs";

/** @param {string} path @param {string} [status] */
const added = (path, status = "A") => ({ status, path });
const refusedPaths = (files) => disallowedMarkdown(files, ALLOWED_MARKDOWN).map(({ path }) => path);
const ruleViolations = (files) => ruleFileViolations(files, RULE_FILES, ALLOWED_EXTRAS).map(({ path }) => path);

test("docs location: a new Markdown file under bin/ is refused", () => {
  assert.deepEqual(refusedPaths([added("bin/notes.md")]), ["bin/notes.md"]);
});

test("docs location: a new Markdown file at the root, other than README.md, AGENTS.md and CLAUDE.md, is refused", () => {
  assert.deepEqual(refusedPaths([added("NOTES.md"), added("README.md"), added("AGENTS.md"), added("CLAUDE.md")]), ["NOTES.md"]);
});

test("docs location: the fixed homes, the board and any README.md are allowed", () => {
  assert.deepEqual(
    refusedPaths([
      added("specs/KANBAN.md"),
      added("docs/ops/x.md"),
      added("docs/adr/0002-x.md"),
      added("specs/threads/login.md"),
      added("specs/plans/2026-11-01-x.md"),
      added("specs/design/2026-11-01-x.md"),
      added("specs/reviews/2026-11-01-x.md"),
      added("app/web/README.md"),
    ]),
    [],
  );
});

test("docs location: .agents/ and .github/ are allowed, nested", () => {
  assert.deepEqual(refusedPaths([added(".agents/skills/x/SKILL.md"), added(".github/PULL_REQUEST_TEMPLATE/x.md")]), []);
});

test("docs location: scripts/, specs/ outside the fixed homes, and app folders are refused until listed", () => {
  assert.deepEqual(
    refusedPaths([added("scripts/notes.md"), added("specs/handoffs/x.md"), added("specs/notes.md"), added("app/web/NOTES.md")]),
    ["scripts/notes.md", "specs/handoffs/x.md", "specs/notes.md", "app/web/NOTES.md"],
  );
});

test("docs location: a folder added to the allowed list is allowed", () => {
  const files = [added("app/web/NOTES.md")];
  assert.deepEqual(disallowedMarkdown(files, [...ALLOWED_MARKDOWN, "app/**"]), []);
});

test("docs location: a modified file anywhere is ignored", () => {
  assert.deepEqual(refusedPaths([added("bin/notes.md", "M"), added("NOTES.md", "D")]), []);
});

test("docs location: a new file that is not Markdown is ignored", () => {
  assert.deepEqual(refusedPaths([added("bin/tool"), added("scripts/lib/paths.mjs")]), []);
});

test("rule files: AGENTS.md changed with scripts/kanban.mjs is refused naming the script", () => {
  assert.deepEqual(ruleViolations([added("AGENTS.md", "M"), added("scripts/kanban.mjs", "M")]), ["scripts/kanban.mjs"]);
});

test("rule files: AGENTS.md changed with docs/ops/decision-log.md, specs/manifest.json and specs/threads/x.md is allowed", () => {
  assert.deepEqual(
    ruleViolations([
      added("AGENTS.md", "M"),
      added("docs/ops/decision-log.md", "M"),
      added("specs/manifest.json", "M"),
      added("specs/threads/x.md", "M"),
      added("specs/KANBAN.md", "M"),
      added("docs/adr/0002-x.md"),
    ]),
    [],
  );
});

test("rule files: CLAUDE.md changed with a script is refused too", () => {
  assert.deepEqual(ruleViolations([added("CLAUDE.md", "M"), added("scripts/kanban.mjs", "M")]), ["scripts/kanban.mjs"]);
});

test("rule files: AGENTS.md and CLAUDE.md may change together", () => {
  assert.deepEqual(ruleViolations([added("AGENTS.md", "M"), added("CLAUDE.md", "M")]), []);
});

test("rule files: a change set without a root rule file is never checked", () => {
  assert.deepEqual(ruleViolations([added("scripts/kanban.mjs", "M"), added("packages/x/AGENTS.md")]), []);
});

test("rule files: the default rule files are the root AGENTS.md and CLAUDE.md", () => {
  assert.deepEqual(RULE_FILES, ["AGENTS.md", "CLAUDE.md"]);
});

test("glob: **/README.md matches a nested README and not readme.txt", () => {
  const pattern = glob("**/README.md");
  assert.ok(pattern.test("README.md"));
  assert.ok(pattern.test("docs/adr/README.md"));
  assert.ok(!pattern.test("docs/readme.txt"));
  assert.ok(!pattern.test("docs/README.md.bak"));
});

test("glob: * stays inside one folder and ** crosses folders", () => {
  assert.ok(glob("docs/*").test("docs/x.md"));
  assert.ok(!glob("docs/*").test("docs/ops/x.md"));
  assert.ok(glob("docs/**").test("docs/ops/x.md"));
  assert.ok(glob("specs.json").test("specs.json"));
  assert.ok(!glob("specs.json").test("specsXjson"));
});

test("matchesAny: true when one compiled pattern matches", () => {
  const patterns = ["docs/**", "AGENTS.md"].map(glob);
  assert.ok(matchesAny("AGENTS.md", patterns));
  assert.ok(!matchesAny("bin/AGENTS.md", patterns));
});
