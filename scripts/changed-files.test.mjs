// Tests for scripts/changed-files.mjs: which commit range the two
// changed-file checks read in each GitHub Actions event, and that a base the
// clone cannot find fails the checks instead of passing them unseen.
//
// diffRange takes the environment and a small git interface, so the unit cases
// use a fake git. The end-to-end cases run the real checks in a temp repo
// whose origin is a local bare repo, so no case touches the network.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import * as changed from "./changed-files.mjs";
import { copyCheckout } from "./lib/copy.mjs";
import { DEFAULT_BRANCH } from "./lib/settings.mjs";

const { diffRange } = changed;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const EMPTY_TREE = "e".repeat(40);

/**
 * A fake git: `present` refs exist; `fetch` adds `fetchable` refs and records its argument.
 * @param {string[]} present @param {string[]} [fetchable]
 */
function fakeGit(present, fetchable = []) {
  const refs = new Set(present);
  /** @type {string[]} */
  const fetched = [];
  return {
    fetched,
    hasCommit: (/** @type {string} */ ref) => refs.has(ref),
    emptyTree: () => EMPTY_TREE,
    fetch: (/** @type {string} */ refspec) => {
      fetched.push(refspec);
      for (const ref of fetchable) refs.add(ref);
    },
  };
}

test("diffRange: a pull request diffs origin/<base>...HEAD", () => {
  const git = fakeGit(["origin/main"]);
  const range = diffRange({ GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main" }, git);
  assert.equal(range, "origin/main...HEAD");
  assert.deepEqual(git.fetched, []);
});

test("diffRange: a pull request whose origin/<base> is missing fetches it once", () => {
  const git = fakeGit([], ["origin/main"]);
  assert.equal(diffRange({ GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main" }, git), "origin/main...HEAD");
  assert.deepEqual(git.fetched, ["+refs/heads/main:refs/remotes/origin/main"]);
});

test("diffRange: a pull request whose origin/<base> is still missing after the fetch throws", () => {
  const git = fakeGit([]);
  assert.throws(() => diffRange({ GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main" }, git), /origin\/main is missing even after git fetch/);
  assert.equal(git.fetched.length, 1);
});

test("diffRange: a pull request without a base ref throws", () => {
  assert.throws(() => diffRange({ GITHUB_EVENT_NAME: "pull_request" }, fakeGit(["origin/main"])), /GITHUB_BASE_REF/);
});

test("diffRange: a push that creates another branch diffs against its merge base with the default branch", () => {
  const git = fakeGit([`origin/${DEFAULT_BRANCH}`]);
  const env = { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_BEFORE: "0".repeat(40), GITHUB_REF_NAME: `${DEFAULT_BRANCH}-not` };
  assert.equal(diffRange(env, git), `origin/${DEFAULT_BRANCH}...HEAD`);
});

test("diffRange: a push that creates the default branch itself diffs from the empty tree", () => {
  const git = fakeGit([`origin/${DEFAULT_BRANCH}`]);
  const env = { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_BEFORE: "0".repeat(40), GITHUB_REF_NAME: DEFAULT_BRANCH };
  assert.equal(diffRange(env, git), `${EMPTY_TREE}..HEAD`);
  assert.deepEqual(git.fetched, []);
});

test("diffRange: a push that creates a branch without naming it throws", () => {
  assert.throws(() => diffRange({ GITHUB_EVENT_NAME: "push", GITHUB_EVENT_BEFORE: "0".repeat(40) }, fakeGit([`origin/${DEFAULT_BRANCH}`])), /GITHUB_REF_NAME/);
});

test("emptyTree: the real git's empty tree diffs to every file in HEAD", () => {
  const tree = changed.gitAt(root).emptyTree();
  assert.match(tree, /^[0-9a-f]{40,64}$/);
  const r = spawnSync("git", ["diff", "--name-status", "--no-renames", `${tree}..HEAD`, "--", "package.json"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "A\tpackage.json\n");
});

test("diffRange: a push with no before SHA throws", () => {
  assert.throws(() => diffRange({ GITHUB_EVENT_NAME: "push" }, fakeGit(["origin/main"])), /GITHUB_EVENT_BEFORE/);
});

test("diffRange: a push whose before SHA is present diffs <before>..HEAD without fetching", () => {
  const git = fakeGit([SHA_A]);
  assert.equal(diffRange({ GITHUB_EVENT_NAME: "push", GITHUB_EVENT_BEFORE: SHA_A }, git), `${SHA_A}..HEAD`);
  assert.deepEqual(git.fetched, []);
});

test("diffRange: a push whose before SHA is missing fetches it once, then diffs", () => {
  const git = fakeGit([], [SHA_B]);
  assert.equal(diffRange({ GITHUB_EVENT_NAME: "push", GITHUB_EVENT_BEFORE: SHA_B }, git), `${SHA_B}..HEAD`);
  assert.deepEqual(git.fetched, [SHA_B]);
});

test("diffRange: a push whose before SHA is still missing after the fetch throws naming it", () => {
  const git = fakeGit([]);
  assert.throws(() => diffRange({ GITHUB_EVENT_NAME: "push", GITHUB_EVENT_BEFORE: SHA_B }, git), new RegExp(`${SHA_B} is not in this clone even after git fetch`));
  assert.deepEqual(git.fetched, [SHA_B]);
});

test("diffRange: outside Actions the range is origin/<DEFAULT_BRANCH>...HEAD", () => {
  assert.equal(diffRange({}, fakeGit([`origin/${DEFAULT_BRANCH}`])), `origin/${DEFAULT_BRANCH}...HEAD`);
});

test("diffRange: a pull request into another base branch diffs against that branch", () => {
  assert.equal(diffRange({ GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "release" }, fakeGit(["origin/release"])), "origin/release...HEAD");
});

test("diffRange: with the real git, a push whose before SHA is this checkout's HEAD diffs <before>..HEAD", () => {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  assert.match(head, /^[0-9a-f]{40}$/);
  assert.equal(diffRange({ GITHUB_EVENT_NAME: "push", GITHUB_EVENT_BEFORE: head }), `${head}..HEAD`);
});

// End to end: the real checks in a temp repo with a local bare origin.

const GIT_ENV = {
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: tmpdir(),
};

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * The end-to-end repo's own settings, so these cases never depend on the
 * lists or the branch the real repo chose.
 */
const FIXTURE_SETTINGS = `export const ALLOWED_MARKDOWN = ["docs/**", "**/README.md", "AGENTS.md"];
export const RULE_FILES = ["AGENTS.md"];
export const ALLOWED_EXTRAS = ["docs/ops/decision-log.md"];
export const CEILINGS = { total: 30, p1: 10, inProgress: 3, owner: 10 };
export const DEFAULT_BRANCH = "main";
`;

/** Every temp folder the end-to-end cases make, removed when the file's tests end. */
const temps = [];
after(() => { for (const base of temps) rmSync(base, { recursive: true, force: true }); });

/** A clone with the scripts committed on main and pushed to a local origin. */
function makeRepo() {
  const base = mkdtempSync(join(tmpdir(), "changed-files-"));
  temps.push(base);
  const origin = join(base, "origin.git");
  const work = join(base, "work");
  git(base, ["init", "-q", "--bare", "-b", "main", origin]);
  git(base, ["init", "-q", "-b", "main", work]);
  copyCheckout(join(root, "scripts"), join(work, "scripts"));
  writeFileSync(join(work, "scripts", "lib", "settings.mjs"), FIXTURE_SETTINGS);
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "base"]);
  git(work, ["remote", "add", "origin", origin]);
  git(work, ["push", "-q", "origin", "main"]);
  git(work, ["fetch", "-q", "origin"]);
  return work;
}

/** @param {string} work @param {string} script @param {Record<string, string>} env */
function runCheck(work, script, env) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GITHUB_")));
  const r = spawnSync(process.execPath, [join(work, "scripts", script)], { cwd: work, encoding: "utf8", env: { ...clean, ...GIT_ENV, ...env } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** @param {string} work @param {string} path */
function commitFile(work, path) {
  mkdirSync(dirname(join(work, path)), { recursive: true });
  writeFileSync(join(work, path), "x\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", `add ${path}`]);
}

test("checks: a push whose before SHA cannot be found fails both checks naming it", () => {
  const work = makeRepo();
  commitFile(work, "bin/notes.md");
  for (const script of ["check-docs-location.mjs", "check-rule-files-alone.mjs"]) {
    const r = runCheck(work, script, { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_BEFORE: SHA_B });
    assert.equal(r.code, 1, `${script}: ${r.out}`);
    assert.match(r.out, new RegExp(`${SHA_B} is not in this clone even after git fetch`));
  }
});

test("checks: a pull request whose base branch cannot be found fails both checks", () => {
  const work = makeRepo();
  for (const script of ["check-docs-location.mjs", "check-rule-files-alone.mjs"]) {
    const r = runCheck(work, script, { GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "no-such-branch" });
    assert.equal(r.code, 1, `${script}: ${r.out}`);
    assert.match(r.out, /origin\/no-such-branch is missing even after git fetch/);
  }
});

test("checks: a push that creates another branch still judges the commits since origin/main", () => {
  const work = makeRepo();
  commitFile(work, "bin/notes.md");
  const r = runCheck(work, "check-docs-location.mjs", { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_BEFORE: "0".repeat(40), GITHUB_REF_NAME: "feature" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /- bin\/notes\.md/);
});

/** Push main and fetch it back, so origin/main is HEAD: the state of the push that creates main. @param {string} work */
function pushMain(work) {
  git(work, ["push", "-q", "origin", "main"]);
  git(work, ["fetch", "-q", "origin"]);
}

const CREATE_MAIN = { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_BEFORE: "0".repeat(40), GITHUB_REF_NAME: "main" };

test("checks: the push that creates main, with a Markdown file outside the allowed folders, fails", () => {
  const work = makeRepo();
  commitFile(work, "bin/notes.md");
  pushMain(work);
  const r = runCheck(work, "check-docs-location.mjs", CREATE_MAIN);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /- bin\/notes\.md/);
});

test("checks: the push that creates main, with a rule file and code together, fails", () => {
  const work = makeRepo();
  commitFile(work, "AGENTS.md");
  commitFile(work, "scripts/tool.mjs");
  pushMain(work);
  const r = runCheck(work, "check-rule-files-alone.mjs", CREATE_MAIN);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /- scripts\/tool\.mjs/);
});

// Review finding 4: git quotes unusual names in its default output
// ("bin/\303\251.md"), which no longer end in .md; -z output is verbatim.

test("parseNameStatusZ: reads NUL-separated status and path fields verbatim", () => {
  const output = "A\0bin/\u00e9.md\0M\0docs/a b.md\0A\0bin/a\tb.md\0D\0old\nline.md\0";
  assert.deepEqual(changed.parseNameStatusZ(output), [
    { status: "A", path: "bin/\u00e9.md" },
    { status: "M", path: "docs/a b.md" },
    { status: "A", path: "bin/a\tb.md" },
    { status: "D", path: "old\nline.md" },
  ]);
});

test("parseNameStatusZ: empty output is no files, and a dangling status is refused", () => {
  assert.deepEqual(changed.parseNameStatusZ(""), []);
  assert.throws(() => changed.parseNameStatusZ("A\0"), /unexpected git diff output/);
});

test("checks: new Markdown with a Unicode name, a space or a tab outside the allowed folders is refused", () => {
  const work = makeRepo();
  for (const path of ["bin/\u00e9.md", "bin/a b.md", "bin/a\tb.md", "docs/\u00e9t\u00e9.md"]) commitFile(work, path);
  const r = runCheck(work, "check-docs-location.mjs", {});
  assert.equal(r.code, 1, r.out);
  const listed = r.out.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2)).sort();
  assert.deepEqual(listed, ["bin/a\tb.md", "bin/a b.md", "bin/\u00e9.md"].sort());
});

test("checks: AGENTS.md with a Unicode-named script is refused naming the script verbatim", () => {
  const work = makeRepo();
  commitFile(work, "AGENTS.md");
  commitFile(work, "scripts/n\u00e9w tool.mjs");
  const r = runCheck(work, "check-rule-files-alone.mjs", {});
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /- scripts\/n\u00e9w tool\.mjs/);
});
