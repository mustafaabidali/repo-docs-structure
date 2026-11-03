// The values a repo may change live in scripts/lib/settings.mjs. This test
// changes every one of them in a copy of the repo and runs the whole suite
// there, so no test may repeat a default: a case that does fails in the copy.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

/**
 * Give the committed copy a local origin holding `branch`, so a local run of a
 * changed-file check is judged from origin/<branch>.
 * @param {string} repo @param {string} branch
 */
function pushToOrigin(repo, branch) {
  const origin = `${repo}-origin.git`;
  git(dirname(repo), ["init", "-q", "--bare", "-b", branch, origin]);
  git(repo, ["remote", "add", "origin", origin]);
  git(repo, ["push", "-q", "origin", branch]);
  git(repo, ["fetch", "-q", "origin"]);
}

/**
 * One command-line probe: on a fresh branch from `base`, commit `files` and
 * run `script` as a local run. Returns its exit code and output, and goes back
 * to `base`.
 * @param {string} repo @param {string} base @param {string} name @param {Record<string, string>} files @param {string} script
 */
function probe(repo, base, name, files, script) {
  git(repo, ["switch", "-q", "-c", name, base]);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", name]);
  const r = spawnSync(process.execPath, [join("scripts", script)], { cwd: repo, encoding: "utf8", env: localEnv() });
  git(repo, ["switch", "-q", base]);
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test("every changed list, and the changed default branch, is what the checks' command lines judge by", () => {
  const repo = copyRepo();
  writeFileSync(join(repo, "scripts", "lib", "settings.mjs"), CHANGED_SETTINGS);
  commitCopy(repo, "trunk");
  pushToOrigin(repo, "trunk");
  const manifest = readFileSync(join(repo, "specs", "manifest.json"), "utf8");
  const cases = [
    // ALLOWED_MARKDOWN: specs/** is allowed only by the changed list; .github/** only by the default.
    { name: "markdown-pass", script: "check-docs-location.mjs", files: { "specs/notes.md": "x\n" }, code: 0 },
    { name: "markdown-fail", script: "check-docs-location.mjs", files: { ".github/notes.md": "x\n" }, code: 1, names: ".github/notes.md" },
    // RULE_FILES: RULES.md is a rule file only in the changed list; AGENTS.md only by default.
    { name: "rules-fail", script: "check-rule-files-alone.mjs", files: { "RULES.md": "x\n", "scripts/probe.mjs": "x\n" }, code: 1, names: "scripts/probe.mjs" },
    { name: "rules-pass", script: "check-rule-files-alone.mjs", files: { "AGENTS.md": "x\n", "scripts/probe.mjs": "x\n" }, code: 0 },
    // ALLOWED_EXTRAS: only specs/manifest.json may travel with a rule file; the decision log no longer may.
    { name: "extras-pass", script: "check-rule-files-alone.mjs", files: { "RULES.md": "x\n", "specs/manifest.json": `${manifest}\n` }, code: 0 },
    { name: "extras-fail", script: "check-rule-files-alone.mjs", files: { "RULES.md": "x\n", "docs/ops/decision-log.md": "x\n" }, code: 1, names: "docs/ops/decision-log.md" },
  ];
  for (const c of cases) {
    const r = probe(repo, "trunk", c.name, c.files, c.script);
    assert.equal(r.code, c.code, `${c.name}: ${r.out}`);
    if (c.names) assert.match(r.out, new RegExp(`^- ${c.names.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"), c.name);
    // A local run is judged from origin/trunk; origin/main does not exist here.
    assert.doesNotMatch(r.out, /origin\/main/, c.name);
  }
});

test("every value in scripts/lib/settings.mjs can change and the whole suite still passes", () => {
  const repo = copyRepo();
  writeFileSync(join(repo, "scripts", "lib", "settings.mjs"), CHANGED_SETTINGS);
  commitCopy(repo, "trunk");
  const r = runSuite(repo);
  assert.equal(r.code, 0, `${failures(r.out)}\n\n${r.out.slice(-4000)}`);
});

/**
 * Replace the copy's manifest, its registered documents, its thread files and
 * its ADRs with a seeded set of its own, so nothing of the repo's own state
 * (its threads, its archived entries, its archive pattern) reaches the probe.
 * @param {string} repo
 */
function seedCopy(repo) {
  for (const dir of ["specs/plans", "specs/design", "specs/reviews", "specs/threads"]) {
    const full = join(repo, dir);
    if (!existsSync(full)) continue;
    for (const name of readdirSync(full)) if (name.endsWith(".md")) rmSync(join(full, name));
  }
  const adr = join(repo, "docs", "adr");
  for (const name of readdirSync(adr)) if (/^\d{4}-.+\.md$/.test(name)) rmSync(join(adr, name));
  const today = new Date().toISOString().slice(0, 10);
  const thread = (id, title) => ({ id, title, file: `specs/threads/${id}.md`, created: today });
  const manifest = {
    $schema: "./manifest.schema.json",
    name: "Seeded probe",
    last_updated: today,
    work: { active_plan: "plan-probe", next: [] },
    metadata: {
      threads: [thread("authentication", "Authentication"), thread("sign-in", "Sign-in")],
      plans: [
        { id: "plan-probe", title: "The probe's plan", file: "specs/plans/2026-01-01-probe.md", created: today, status: "approved", tags: ["authentication"] },
        {
          id: "plan-old-sign-in",
          title: "The old sign-in plan",
          archived: "https://github.com/acme-co/acme-archive/blob/main/specs/plans/2026-01-01-old-sign-in.md",
          created: today,
          status: "completed",
          tags: ["authentication", "sign-in"],
        },
      ],
      specs: [],
      reviews: [],
    },
  };
  writeFileSync(join(repo, "specs", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(repo, "specs", "plans", "2026-01-01-probe.md"), "# The probe's plan\n");
  const schemaPath = join(repo, "specs", "manifest.schema.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  schema.$defs.archiveUrl.pattern = "^https://github\\.com/acme-co/acme-archive/blob/main/specs/(plans|design|reviews)/[^/]+\\.md$";
  writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`);
}

test("a copy seeded with its own manifest (an authentication thread first, sign-in, an archived entry) and its own narrowed archive pattern passes the checks and the whole suite", () => {
  const repo = copyRepo();
  seedCopy(repo);
  for (const script of ["threads.mjs", "kanban.mjs", "check-manifest.mjs"]) {
    const r = spawnSync(process.execPath, [join("scripts", script)], { cwd: repo, encoding: "utf8", env: localEnv() });
    assert.equal(r.status, 0, `${script}: ${r.stdout}${r.stderr}`);
  }
  commitCopy(repo, "main");
  const r = runSuite(repo);
  assert.equal(r.code, 0, `${failures(r.out)}\n\n${r.out.slice(-4000)}`);
});
