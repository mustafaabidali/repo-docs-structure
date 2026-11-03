// The values a repo may change live in scripts/lib/settings.mjs. This test
// changes every one of them in a copy of the repo and runs the whole suite
// there, so no test may repeat a default: a case that does fails in the copy.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const self = relative(root, fileURLToPath(import.meta.url)).split(sep).join("/");

/** Every value different from the template's defaults. */
const CHANGED_SETTINGS = `export const ALLOWED_MARKDOWN = ["docs/**", "specs/**", "**/README.md", "RULES.md"];
export const RULE_FILES = ["RULES.md"];
export const ALLOWED_EXTRAS = ["specs/manifest.json"];
export const CEILINGS = { total: 12, p1: 4, inProgress: 2, owner: 3 };
export const DEFAULT_BRANCH = "trunk";
`;

const GIT_ENV = {
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: tmpdir(),
};

const temps = [];
after(() => { for (const base of temps) rmSync(base, { recursive: true, force: true }); });

/**
 * The environment for the inner suite: without the CI's GITHUB_* values, so it
 * sees a local run, and without NODE_TEST_CONTEXT, which the outer runner sets
 * and which would make the inner `node --test` report to it instead of running
 * as a suite of its own.
 */
function localEnv() {
  const kept = Object.entries(process.env).filter(([key]) => !key.startsWith("GITHUB_") && key !== "NODE_TEST_CONTEXT");
  return { ...Object.fromEntries(kept), ...GIT_ENV };
}

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: localEnv() });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
}

/** A copy of the checkout (its own git history, the same installed dependencies). */
function copyRepo() {
  const base = mkdtempSync(join(tmpdir(), "settings-"));
  temps.push(base);
  const repo = join(base, "repo");
  cpSync(root, repo, {
    recursive: true,
    filter: (src) => {
      const top = relative(root, src).split(sep)[0];
      return top !== ".git" && top !== "node_modules";
    },
  });
  symlinkSync(join(root, "node_modules"), join(repo, "node_modules"), "dir");
  return repo;
}

/** Commit the copy, so the cases that read this checkout's git history have one. @param {string} repo @param {string} branch */
function commitCopy(repo, branch) {
  git(repo, ["init", "-q", "-b", branch]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "copy"]);
}

/** Every test file in the copy but this one. @param {string} repo */
function suiteFiles(repo) {
  const found = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) visit(full);
      else if (name.endsWith(".test.mjs")) found.push(relative(repo, full).split(sep).join("/"));
    }
  };
  visit(join(repo, "scripts"));
  return found.filter((file) => file !== self).sort();
}

/** @param {string} repo */
function runSuite(repo) {
  const files = suiteFiles(repo);
  assert.ok(files.length >= 5, `found the suite: ${files.join(", ")}`);
  const r = spawnSync(process.execPath, ["--test", ...files], { cwd: repo, encoding: "utf8", env: localEnv() });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** The failing cases' names, so a red run says which test repeated a default. @param {string} out */
function failures(out) {
  return out.split("\n").filter((line) => /^not ok /.test(line)).join("\n");
}

test("every value in scripts/lib/settings.mjs can change and the whole suite still passes", () => {
  const repo = copyRepo();
  writeFileSync(join(repo, "scripts", "lib", "settings.mjs"), CHANGED_SETTINGS);
  commitCopy(repo, "trunk");
  const r = runSuite(repo);
  assert.equal(r.code, 0, `${failures(r.out)}\n\n${r.out.slice(-4000)}`);
});
