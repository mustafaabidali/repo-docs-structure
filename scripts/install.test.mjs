// The README's Install section, run. Its shell blocks are executed in a
// made-up repo that already has a package.json and no .nvmrc, with `template`
// pointing at this checkout, so the steps are proved as written. The blocks
// whose commands need the network, need the validators installed, or remove
// the copy (git clone, npm install, npm run, rm) are left out; everything else
// runs in order. A repo whose own README has no such
// section skips these cases.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readme = existsSync(join(root, "README.md")) ? readFileSync(join(root, "README.md"), "utf8") : "";
/** A block is left out when one of its lines starts one of these commands; a mention inside a value does not count. */
const NOT_RUN = /^[ \t]*(git clone|npm (install|ci|run)|rm -rf)\b/m;

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

const temps = [];
after(() => { for (const base of temps) rmSync(base, { recursive: true, force: true }); });

/** A made-up repo with its own package.json and README, then the Install blocks run in it. */
function install() {
  const repo = mkdtempSync(join(tmpdir(), "install-"));
  temps.push(repo);
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({ name: "made-up-app", private: true, scripts: { start: "node app.js" } }, null, 2)}\n`);
  writeFileSync(join(repo, "README.md"), "# Made-up app\n");
  const env = { ...process.env, template: root };
  for (const block of blocks.filter((text) => !NOT_RUN.test(text))) {
    const r = spawnSync("bash", ["-euo", "pipefail", "-c", block], { cwd: repo, encoding: "utf8", env });
    assert.equal(r.status, 0, `block failed:\n${block}\n${r.stdout}${r.stderr}`);
  }
  return repo;
}

test("install: the README's Install section has shell blocks, the clone first and its removal last", { skip }, () => {
  assert.match(blocks[0], /\bgit clone\b/);
  assert.match(blocks.at(-1), /^rm -rf "\$template"\s*$/);
});

test("install: a repo with a package.json and no .nvmrc gets the Node version the workflow reads", { skip }, () => {
  const repo = install();
  const workflow = readFileSync(join(repo, ".github", "workflows", "ci.yml"), "utf8");
  const file = /node-version-file:[ \t]*(\S+)/.exec(workflow);
  const version = /node-version:[ \t]*(\S+)/.exec(workflow);
  assert.ok(file || version, "the workflow's Node setup names a version or a version file");
  if (file) {
    assert.ok(existsSync(join(repo, file[1])), `${file[1]}, which the workflow reads, is in the repo`);
    assert.equal(readFileSync(join(repo, file[1]), "utf8"), readFileSync(join(root, file[1]), "utf8"));
  }
});

test("install: the AGENTS.md block is in the repo, for the rules-only pull request after the clone is gone", { skip }, () => {
  const repo = install();
  assert.equal(readFileSync(join(repo, "docs", "agents-md-block.md"), "utf8"), readFileSync(join(root, "docs", "agents-md-block.md"), "utf8"));
});

test("install: the repo's own package.json keeps its name and scripts and gains the four the checks need", { skip }, () => {
  const repo = install();
  const ours = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  const template = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(ours.name, "made-up-app");
  assert.equal(ours.scripts.start, "node app.js");
  for (const name of ["kanban", "threads", "test:manifest", "check"]) assert.equal(ours.scripts[name], template.scripts[name], `scripts.${name}`);
});

test("install: the installed structure, its board and threads drawn as step 7 does, passes the manifest check", { skip }, () => {
  const repo = install();
  symlinkSync(join(root, "node_modules"), join(repo, "node_modules"), "dir");
  for (const script of ["kanban.mjs", "threads.mjs", "check-manifest.mjs"]) {
    const r = spawnSync(process.execPath, [join("scripts", script)], { cwd: repo, encoding: "utf8" });
    assert.equal(r.status, 0, `${script}: ${r.stdout}${r.stderr}`);
  }
});

test("install: an upgrade, step 2 again, replaces the checks but keeps the repo's own settings", { skip }, () => {
  const repo = install();
  const settings = join(repo, "scripts", "lib", "settings.mjs");
  const ours = readFileSync(settings, "utf8").replace("total: 30", "total: 12");
  writeFileSync(settings, ours);
  writeFileSync(join(repo, "scripts", "kanban.mjs"), "// an old copy\n");
  const step2 = blocks.find((text) => text.includes("scripts/lib/*.mjs"));
  assert.ok(step2, "the Install section has the block that copies scripts/lib");
  const r = spawnSync("bash", ["-euo", "pipefail", "-c", step2], { cwd: repo, encoding: "utf8", env: { ...process.env, template: root } });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.equal(readFileSync(settings, "utf8"), ours);
  assert.equal(readFileSync(join(repo, "scripts", "kanban.mjs"), "utf8"), readFileSync(join(root, "scripts", "kanban.mjs"), "utf8"));
});
