// Unit tests for scripts/lib/paths.mjs, and the shape of the path lists in
// scripts/lib/settings.mjs.
//
// The classifiers are generic: each case hands them a fixture policy, so no
// case repeats the repo's own lists and a repo may change them freely. The
// checks read `git diff`; these cases feed the same classification a change
// set directly, so no git fixture is needed. The live diff is proven by CI on
// every pull request, and changed-files.test.mjs runs the real checks end to end.

import assert from "node:assert/strict";
import { test } from "node:test";

import { disallowedMarkdown, glob, matchesAny, ruleFileViolations } from "./paths.mjs";
import { ALLOWED_EXTRAS, ALLOWED_MARKDOWN, CEILINGS, DEFAULT_BRANCH, RULE_FILES } from "./settings.mjs";

/** A fixture policy, independent of the repo's settings. */
const POLICY = {
  allowed: ["docs/**", "specs/plans/**", "specs/threads/**", "specs/KANBAN.md", "**/README.md", "AGENTS.md", ".github/**"],
  rules: ["AGENTS.md", "CLAUDE.md"],
  extras: ["docs/adr/**", "docs/ops/decision-log.md", "specs/manifest.json", "specs/KANBAN.md", "specs/threads/**"],
};

/** @param {string} path @param {string} [status] */
const added = (path, status = "A") => ({ status, path });
const refusedPaths = (files, allowed = POLICY.allowed) => disallowedMarkdown(files, allowed).map(({ path }) => path);
const ruleViolations = (files) => ruleFileViolations(files, POLICY.rules, POLICY.extras).map(({ path }) => path);

test("docs location: a new Markdown file outside the allowed globs is refused", () => {
  assert.deepEqual(refusedPaths([added("bin/notes.md"), added("NOTES.md"), added("specs/notes.md"), added("app/web/NOTES.md")]), [
    "bin/notes.md",
    "NOTES.md",
    "specs/notes.md",
    "app/web/NOTES.md",
  ]);
});

test("docs location: a new Markdown file matching an allowed glob is allowed, nested or exact", () => {
  assert.deepEqual(
    refusedPaths([
      added("docs/ops/x.md"),
      added("specs/plans/2026-11-01-x.md"),
      added("specs/KANBAN.md"),
      added("app/web/README.md"),
      added("AGENTS.md"),
      added(".github/PULL_REQUEST_TEMPLATE/x.md"),
    ]),
    [],
  );
});

test("docs location: a folder added to the allowed list is allowed", () => {
  assert.deepEqual(refusedPaths([added("app/web/NOTES.md")], [...POLICY.allowed, "app/**"]), []);
});

test("docs location: a modified or deleted file anywhere is ignored", () => {
  assert.deepEqual(refusedPaths([added("bin/notes.md", "M"), added("NOTES.md", "D")]), []);
});

test("docs location: a new file that is not Markdown is ignored", () => {
  assert.deepEqual(refusedPaths([added("bin/tool"), added("scripts/lib/paths.mjs")]), []);
});

test("rule files: a rule file changed with a script is refused naming the script", () => {
  assert.deepEqual(ruleViolations([added("AGENTS.md", "M"), added("scripts/kanban.mjs", "M")]), ["scripts/kanban.mjs"]);
  assert.deepEqual(ruleViolations([added("CLAUDE.md", "M"), added("scripts/kanban.mjs", "M")]), ["scripts/kanban.mjs"]);
});

test("rule files: a rule file changed with the allowed extras, or with another rule file, is allowed", () => {
  assert.deepEqual(
    ruleViolations([
      added("AGENTS.md", "M"),
      added("CLAUDE.md", "M"),
      added("docs/ops/decision-log.md", "M"),
      added("specs/manifest.json", "M"),
      added("specs/threads/x.md", "M"),
      added("specs/KANBAN.md", "M"),
      added("docs/adr/0002-x.md"),
    ]),
    [],
  );
});

test("rule files: a change set without a rule file is never checked", () => {
  assert.deepEqual(ruleViolations([added("scripts/kanban.mjs", "M"), added("packages/x/AGENTS.md")]), []);
});

test("settings: the path lists are non-empty lists of globs", () => {
  for (const [name, list] of Object.entries({ ALLOWED_MARKDOWN, RULE_FILES, ALLOWED_EXTRAS })) {
    assert.ok(Array.isArray(list) && list.length > 0, `${name} is a non-empty list`);
    for (const entry of list) assert.ok(typeof entry === "string" && entry.length > 0 && !entry.startsWith("/"), `${name}: ${JSON.stringify(entry)} is a repo-relative glob`);
    for (const entry of list) assert.doesNotThrow(() => glob(entry), `${name}: ${entry} compiles`);
  }
});

test("settings: a rule file is always an allowed Markdown location when it is Markdown", () => {
  const allowed = ALLOWED_MARKDOWN.map(glob);
  for (const rule of RULE_FILES.filter((path) => path.endsWith(".md") && !path.includes("*"))) {
    assert.ok(matchesAny(rule, allowed), `${rule} is a rule file but a new one would be refused by ALLOWED_MARKDOWN`);
  }
});

test("settings: the ceilings are positive whole numbers, none above the total", () => {
  for (const [name, value] of Object.entries(CEILINGS)) assert.ok(Number.isInteger(value) && value > 0, `CEILINGS.${name} is a positive whole number`);
  assert.deepEqual(Object.keys(CEILINGS).sort(), ["inProgress", "owner", "p1", "total"]);
  for (const name of ["p1", "inProgress", "owner"]) assert.ok(CEILINGS[name] <= CEILINGS.total, `CEILINGS.${name} is not above CEILINGS.total`);
});

test("settings: the default branch is a plain branch name", () => {
  assert.match(DEFAULT_BRANCH, /^[A-Za-z0-9._/-]+$/);
  assert.ok(!DEFAULT_BRANCH.startsWith("refs/"), "DEFAULT_BRANCH is a branch name, not a ref");
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
