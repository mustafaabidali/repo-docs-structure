// The suite never touches a file outside its own temporary copies. A made-up
// checkout holds a folder link that stays inside it (docs/adr -> decisions)
// and one that points outside it (specs/design -> a folder beside it), each
// holding a made-up sentinel document, plus a test file that always fails, so
// the suite's runs fail part way. After the whole suite runs there, both
// sentinels, and everything else in the two linked folders, are unchanged.
//
// This tests the template's own suite from outside, so it lives in
// template-tests/, which the Install steps never copy.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SENTINEL = "SENTINEL-4711: a made-up document this suite must never touch.\n";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: tmpdir(),
};

/** A local run's environment, without the outer runner's NODE_TEST_CONTEXT and the CI's GITHUB_* values. @param {Record<string, string>} [extra] */
function localEnv(extra = {}) {
  const kept = Object.entries(process.env).filter(([key]) => !key.startsWith("GITHUB_") && key !== "NODE_TEST_CONTEXT");
  return { ...Object.fromEntries(kept), ...GIT_ENV, ...extra };
}

const temps = [];
after(() => { for (const base of temps) rmSync(base, { recursive: true, force: true }); });

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: localEnv() });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** Every file under `dir`, by path, with its contents. @param {string} dir */
function snapshot(dir) {
  const out = {};
  const visit = (current, prefix) => {
    for (const name of readdirSync(current, { withFileTypes: true })) {
      if (name.isDirectory()) visit(join(current, name.name), `${prefix}${name.name}/`);
      else out[`${prefix}${name.name}`] = readFileSync(join(current, name.name), "utf8");
    }
  };
  visit(dir, "");
  return out;
}

test("copies: the whole suite, failing part way, leaves a linked folder inside the checkout and one outside it unchanged", () => {
  const base = mkdtempSync(join(tmpdir(), "copies-"));
  temps.push(base);
  const repo = join(base, "repo");
  const outside = join(base, "outside-design");

  // The made-up checkout: this checkout's tracked files, then the two links.
  for (const file of git(root, ["ls-files", "-z"]).split("\0").filter(Boolean)) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    copyFileSync(join(root, file), join(repo, file));
  }
  renameSync(join(repo, "docs", "adr"), join(repo, "decisions"));
  writeFileSync(join(repo, "decisions", "0007-sentinel.md"), SENTINEL);
  symlinkSync("../decisions", join(repo, "docs", "adr"), "dir");
  mkdirSync(outside);
  writeFileSync(join(outside, "2026-01-01-sentinel.md"), SENTINEL);
  rmSync(join(repo, "specs", "design"), { recursive: true });
  symlinkSync(outside, join(repo, "specs", "design"), "dir");
  writeFileSync(join(repo, "scripts", "zz-always-fails.test.mjs"), 'import { test } from "node:test";\ntest("always fails", () => { throw new Error("fails on purpose"); });\n');
  symlinkSync(join(root, "node_modules"), join(repo, "node_modules"), "dir");
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "a made-up checkout with two folder links"]);

  const inside = snapshot(join(repo, "decisions"));
  const beyond = snapshot(outside);
  const r = spawnSync(process.execPath, ["--test", "scripts/**/*.test.mjs"], { cwd: repo, encoding: "utf8", env: localEnv({ TMPDIR: base }), maxBuffer: 64 * 1024 * 1024 });
  assert.notEqual(r.status, 0, "the suite fails part way, as set up");
  assert.match(`${r.stdout}`, /always fails/);

  assert.equal(readFileSync(join(repo, "decisions", "0007-sentinel.md"), "utf8"), SENTINEL);
  assert.equal(readFileSync(join(outside, "2026-01-01-sentinel.md"), "utf8"), SENTINEL);
  assert.deepEqual(snapshot(join(repo, "decisions")), inside, "the folder linked inside the checkout is unchanged");
  assert.deepEqual(snapshot(outside), beyond, "the folder linked outside the checkout is unchanged");
});
