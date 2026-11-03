// The README's Install section, run as written. Its shell blocks are joined
// into one script and run in a made-up repo, in order, with `bash -euo
// pipefail`. Only the two network commands are replaced, each by a local
// stand-in: the clone by a copy of this checkout, and the package install by a
// link to this checkout's installed dependencies. Everything else runs for
// real, the installed `npm run check` included, which runs the installed suite
// in the made-up repo.
//
// Two made-up repos:
// - a fresh app: its own package.json and a README with its own Install
//   section, nothing else;
// - a repo that already has the structure: its own manifest (a sign-in thread,
//   an archived entry from another owner), its own schema narrowed to that
//   owner's archive, and its own CI workflow with no concurrency block.
//
// A repo whose own README has no such section skips these cases.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readme = existsSync(join(root, "README.md")) ? readFileSync(join(root, "README.md"), "utf8") : "";
const TODAY = new Date().toISOString().slice(0, 10);

/** The shell blocks of the README's Install section, dedented, in order. */
function installBlocks() {
  const start = readme.search(/^## Install$/m);
  if (start < 0) return [];
  const rest = readme.slice(start + 1);
  const end = rest.search(/^## /m);
  const section = end < 0 ? rest : rest.slice(0, end);
  const blocks = [];
  for (const match of section.matchAll(/^([ \t]*)```sh\n([\s\S]*?)^\1```$/gm)) {
    const indent = match[1].length;
    blocks.push(match[2].split("\n").map((line) => line.slice(Math.min(indent, line.length - line.trimStart().length))).join("\n"));
  }
  return blocks;
}

const blocks = installBlocks();
const skip = blocks.length > 0 ? false : "no Install section with shell blocks in this repo's README";

/** The Install script with its two network commands replaced by local stand-ins; each must be there exactly once. */
function installScript() {
  let clones = 0;
  let installs = 0;
  const lines = blocks.join("\n").split("\n").map((line) => {
    if (/^\s*git clone\b/.test(line)) {
      clones += 1;
      return 'cp -R "$TEMPLATE_SOURCE"/. "$template"';
    }
    if (/^\s*npm install\b/.test(line)) {
      installs += 1;
      return 'ln -s "$TEMPLATE_SOURCE/node_modules" node_modules';
    }
    return line;
  });
  assert.equal(clones, 1, "the Install section clones this repo once");
  assert.equal(installs, 1, "the Install section installs the packages once");
  return lines.join("\n");
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: tmpdir(),
};

/**
 * A local run's environment: no GITHUB_* values, and no NODE_TEST_CONTEXT, which
 * this runner sets and which would make the installed `node --test` report to
 * it instead of running as a suite of its own.
 */
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
}

/** @param {string} repo @param {Record<string, string>} files */
function writeFiles(repo, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
}

/** A made-up repo holding `files`, committed on main and pushed to a local origin. @param {Record<string, string>} files */
function madeUpRepo(files) {
  const base = mkdtempSync(join(tmpdir(), "install-"));
  temps.push(base);
  const repo = join(base, "repo");
  const origin = join(base, "origin.git");
  mkdirSync(repo);
  writeFiles(repo, files);
  git(base, ["init", "-q", "--bare", "-b", "main", origin]);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "the made-up repo before the install"]);
  git(repo, ["remote", "add", "origin", origin]);
  git(repo, ["push", "-q", "origin", "main"]);
  git(repo, ["fetch", "-q", "origin"]);
  mkdirSync(join(base, "tmp"));
  return repo;
}

/** The made-up repo's own temp folder, so the script's mktemp lands where the cleanup reaches. @param {string} repo */
const tmpOf = (repo) => join(dirname(repo), "tmp");

/** Run the whole Install script in `repo`, then commit what it did, so the changed-file checks judge it. @param {string} repo */
function install(repo) {
  const r = spawnSync("bash", ["-euo", "pipefail", "-c", installScript()], { cwd: repo, encoding: "utf8", env: localEnv({ TEMPLATE_SOURCE: root, TMPDIR: tmpOf(repo) }), maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, `the Install script failed in the made-up repo:\n${r.stdout.slice(-6000)}\n${r.stderr.slice(-6000)}`);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "install the docs structure"]);
  for (const script of ["check-docs-location.mjs", "check-rule-files-alone.mjs"]) {
    const check = spawnSync(process.execPath, [join("scripts", script)], { cwd: repo, encoding: "utf8", env: localEnv() });
    assert.equal(check.status, 0, `${script} on the committed install: ${check.stdout}${check.stderr}`);
  }
  return r.stdout;
}

const OWN_README = "# Made-up app\n\n## Install\n\n```sh\nnpm install\n```\n";
const OWN_PACKAGE = `${JSON.stringify({ name: "made-up-app", private: true, scripts: { start: "node app.js" } }, null, 2)}\n`;

/** A fresh app: its own package.json and README (with an Install section of its own), nothing else. */
function freshApp() {
  return madeUpRepo({ "package.json": OWN_PACKAGE, "README.md": OWN_README, "app.js": "console.log('app');\n" });
}

const OTHER_ARCHIVE = "https://github.com/other-owner/made-up-archive/blob/main/specs/plans/2025-12-01-old-checkout.md";
const OTHER_PATTERN = "^https://github\\.com/other-owner/made-up-archive/blob/main/specs/(plans|design|reviews)/[^/]+\\.md$";

/** A repo that already has the structure: its own manifest, schema, plan and CI workflow (with no concurrency block). */
function structuredRepo() {
  const schema = JSON.parse(readFileSync(join(root, "specs", "manifest.schema.json"), "utf8"));
  schema.$defs.archiveUrl.pattern = OTHER_PATTERN;
  const thread = (id, title) => ({ id, title, file: `specs/threads/${id}.md`, created: TODAY });
  const manifest = {
    $schema: "./manifest.schema.json",
    name: "Made-up app",
    last_updated: TODAY,
    work: {
      active_plan: "plan-sign-in",
      next: [{
        id: "sign-in-code",
        title: "Send the sign-in code by text",
        created: TODAY,
        priority: 1,
        status: "in_progress",
        plan: "plan-sign-in",
        tags: ["sign-in"],
        acceptance: "A text message carries the sign-in code.",
        scope: "Send the sign-in code by text message.",
      }],
    },
    metadata: {
      threads: [thread("sign-in", "Sign-in"), thread("payments", "Payments")],
      plans: [
        { id: "plan-sign-in", title: "Sign-in by text", file: "specs/plans/2026-01-15-sign-in.md", created: TODAY, status: "approved", tags: ["sign-in"] },
        { id: "plan-old-checkout", title: "The old checkout", archived: OTHER_ARCHIVE, created: TODAY, status: "completed", tags: ["payments"] },
      ],
      specs: [],
      reviews: [],
    },
  };
  return madeUpRepo({
    "package.json": OWN_PACKAGE,
    "README.md": OWN_README,
    ".github/workflows/ci.yml": "name: Build\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo build\n",
    "specs/manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "specs/manifest.schema.json": `${JSON.stringify(schema, null, 2)}\n`,
    "specs/plans/2026-01-15-sign-in.md": "# Sign-in by text\n\nThe plan.\n",
  });
}

test("install: the README's Install section has shell blocks, the clone first and its removal last", { skip }, () => {
  assert.match(blocks[0], /\bgit clone\b/);
  assert.match(blocks.at(-1), /^rm -rf "\$template"\s*$/);
});

test("install: a fresh app gets the structure, the Node version its workflow reads, the AGENTS.md block and the four scripts, and its installed suite passes", { skip }, () => {
  const repo = freshApp();
  install(repo);
  assert.equal(readFileSync(join(repo, ".nvmrc"), "utf8"), readFileSync(join(root, ".nvmrc"), "utf8"));
  const workflow = readFileSync(join(repo, ".github", "workflows", "ci.yml"), "utf8");
  const file = /node-version-file:[ \t]*(\S+)/.exec(workflow);
  assert.ok(file && existsSync(join(repo, file[1])), "the workflow's Node version file is in the repo");
  assert.equal(readFileSync(join(repo, "docs", "agents-md-block.md"), "utf8"), readFileSync(join(root, "docs", "agents-md-block.md"), "utf8"));
  const ours = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  const template = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(ours.name, "made-up-app");
  assert.equal(ours.scripts.start, "node app.js");
  for (const name of ["kanban", "threads", "test:manifest", "check"]) assert.equal(ours.scripts[name], template.scripts[name], `scripts.${name}`);
  assert.ok(existsSync(join(repo, "specs", "plans", "2026-11-03-docs-structure.md")), "a repo with no manifest gets the starting plan");
});

test("install: a repo that already has the structure, a sign-in thread, another owner's archive and its own CI keeps them, and its installed suite passes", { skip }, () => {
  const repo = structuredRepo();
  const ownSchema = readFileSync(join(repo, "specs", "manifest.schema.json"), "utf8");
  const ownWorkflow = readFileSync(join(repo, ".github", "workflows", "ci.yml"), "utf8");
  install(repo);
  assert.equal(readFileSync(join(repo, "specs", "manifest.schema.json"), "utf8"), ownSchema, "the repo's schema, and its archive pattern, are kept");
  assert.equal(readFileSync(join(repo, ".github", "workflows", "ci.yml"), "utf8"), ownWorkflow, "the repo's own workflow is kept");
  assert.ok(!existsSync(join(repo, "specs", "plans", "2026-11-03-docs-structure.md")), "a repo with its own manifest gets no starting plan");
  assert.equal(JSON.parse(readFileSync(join(repo, "specs", "manifest.json"), "utf8")).metadata.threads[0].id, "sign-in");
});

test("install: an upgrade, steps 1 to 3 again, replaces the checks but keeps the repo's settings and its narrowed archive pattern", { skip }, () => {
  const repo = structuredRepo();
  install(repo);
  const settings = join(repo, "scripts", "lib", "settings.mjs");
  const ownSettings = readFileSync(settings, "utf8").replace("total: 30", "total: 12");
  writeFileSync(settings, ownSettings);
  writeFileSync(join(repo, "scripts", "kanban.mjs"), "// an old copy\n");
  const ownSchema = readFileSync(join(repo, "specs", "manifest.schema.json"), "utf8");
  const upgrade = installScript().split("\n");
  const upTo = upgrade.findIndex((line) => /docs\/ops\/decision-log\.md/.test(line));
  assert.ok(upTo > 0, "the Install script copies the starting files in step 3");
  const steps = `${upgrade.slice(0, upgrade.findIndex((line, index) => index > upTo && /^done$/.test(line.trim())) + 1).join("\n")}\nrm -rf "$template"`;
  const r = spawnSync("bash", ["-euo", "pipefail", "-c", steps], { cwd: repo, encoding: "utf8", env: localEnv({ TEMPLATE_SOURCE: root, TMPDIR: tmpOf(repo) }) });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.equal(readFileSync(settings, "utf8"), ownSettings);
  assert.equal(readFileSync(join(repo, "specs", "manifest.schema.json"), "utf8"), ownSchema);
  assert.equal(readFileSync(join(repo, "scripts", "kanban.mjs"), "utf8"), readFileSync(join(root, "scripts", "kanban.mjs"), "utf8"));
});
