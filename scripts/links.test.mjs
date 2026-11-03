// Inputs stay inside the repo. The checker and the generators read ADRs, the
// decision log, thread and registry files, and walk the registered folders;
// each must refuse, by its repo path, a file or folder that resolves outside
// the checkout through a link, before it reads or walks it. A refused input
// never shows the outside file's contents or names, and no generated file
// changes.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SENTINEL = "SENTINEL-4711";

const temps = [];
after(() => { for (const base of temps) rmSync(base, { recursive: true, force: true }); });

/** A copy of the checkout (no .git; the installed dependencies linked in) beside an "outside" folder. */
function copyRepo() {
  const base = mkdtempSync(join(tmpdir(), "links-"));
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
  const outside = join(base, "outside");
  mkdirSync(outside);
  const manifest = JSON.parse(readFileSync(join(repo, "specs", "manifest.json"), "utf8"));
  return { repo, outside, manifest, thread: manifest.metadata.threads[0].id };
}

/** An ADR that would pass every check, its title, status and tags carrying the sentinel. @param {string} tag */
function sentinelAdr(tag) {
  return `# ADR-0009: ${SENTINEL} title\n\n## Status\n\nAccepted\n\n## Tags\n\n${tag}\n\n## Date\n\n2026-01-01\n\n## Context\n\n${SENTINEL}\n\n## Decision\n\nx\n\n## Consequences\n\nx\n\n## Alternatives Considered\n\nx\n\n## References\n\nx\n`;
}

/** The generated files, by repo path. @param {string} repo */
function generated(repo) {
  const files = ["specs/KANBAN.md", "docs/adr/README.md", ...readdirSync(join(repo, "specs", "threads")).map((name) => `specs/threads/${name}`)];
  return Object.fromEntries(files.map((file) => {
    try {
      return [file, readFileSync(join(repo, file), "utf8")];
    } catch {
      return [file, null];
    }
  }));
}

/** @param {string} repo @param {string} script @param {string[]} [args] */
function runScript(repo, script, args = []) {
  const r = spawnSync(process.execPath, [join(repo, "scripts", script), ...args], { cwd: repo, encoding: "utf8", timeout: 30_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** @param {string} path */
const escape = (path) => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Both refusals name the repo path and show nothing from outside. @param {{ code: number | null, out: string }} r @param {string} path */
function assertRefused(r, path) {
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`${escape(path)} resolves outside the repository`));
  assert.doesNotMatch(r.out, new RegExp(SENTINEL, "i"));
}

test("links: an ADR that is a link to a file outside the repo is refused by name, and nothing of it is read or written", () => {
  const { repo, outside, thread } = copyRepo();
  writeFileSync(join(outside, "adr.md"), sentinelAdr(thread));
  symlinkSync(join(outside, "adr.md"), join(repo, "docs", "adr", "0009-linked.md"));
  const before = generated(repo);
  assertRefused(runScript(repo, "check-manifest.mjs"), "docs/adr/0009-linked.md");
  assertRefused(runScript(repo, "threads.mjs"), "docs/adr/0009-linked.md");
  assert.deepEqual(generated(repo), before);
});

test("links: a docs/adr folder that links outside the repo is refused by name, and nothing of it is read or written", () => {
  const { repo, outside, thread } = copyRepo();
  const folder = join(repo, "docs", "adr");
  cpSync(folder, join(outside, "adr"), { recursive: true });
  writeFileSync(join(outside, "adr", "0009-sentinel.md"), sentinelAdr(thread));
  rmSync(folder, { recursive: true });
  symlinkSync(join(outside, "adr"), folder, "dir");
  const outsideIndex = readFileSync(join(outside, "adr", "README.md"), "utf8");
  assertRefused(runScript(repo, "check-manifest.mjs"), "docs/adr");
  assertRefused(runScript(repo, "threads.mjs"), "docs/adr");
  assert.equal(readFileSync(join(outside, "adr", "README.md"), "utf8"), outsideIndex);
});

test("links: a folder under specs/plans that links outside the repo is refused by name, and the names inside never appear", () => {
  const { repo, outside } = copyRepo();
  mkdirSync(join(outside, "plans"));
  writeFileSync(join(outside, "plans", `${SENTINEL}-name.md`), "x\n");
  symlinkSync(join(outside, "plans"), join(repo, "specs", "plans", "linked"), "dir");
  const before = generated(repo);
  assertRefused(runScript(repo, "check-manifest.mjs"), "specs/plans/linked");
  assert.equal(runScript(repo, "threads.mjs").code, 0);
  assert.equal(runScript(repo, "kanban.mjs").code, 0);
  assert.deepEqual(generated(repo), before);
});

test("links: a registered design file that links outside the repo is refused by name", () => {
  const { repo, outside, thread } = copyRepo();
  writeFileSync(join(outside, "design.md"), `${SENTINEL}\n`);
  const file = "specs/design/2026-01-01-linked.md";
  symlinkSync(join(outside, "design.md"), join(repo, file));
  const path = join(repo, "specs", "manifest.json");
  const m = JSON.parse(readFileSync(path, "utf8"));
  m.metadata.specs.push({ id: "linked-design", title: "Linked design", file, created: m.last_updated, status: "draft", tags: [thread] });
  writeFileSync(path, JSON.stringify(m, null, 2));
  assert.equal(runScript(repo, "threads.mjs").code, 0);
  assert.equal(runScript(repo, "kanban.mjs").code, 0);
  assertRefused(runScript(repo, "check-manifest.mjs"), file);
});

test("links: a thread file that links outside the repo is refused by the checker too", () => {
  const { repo, outside, thread } = copyRepo();
  const file = `specs/threads/${thread}.md`;
  writeFileSync(join(outside, "thread.md"), readFileSync(join(repo, file), "utf8"));
  rmSync(join(repo, file));
  symlinkSync(join(outside, "thread.md"), join(repo, file));
  const r = runScript(repo, "check-manifest.mjs");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`${escape(file)} resolves outside the repository`));
});

test("links: a decision log that links outside the repo is refused by name, and its ids are never read", () => {
  const { repo, outside } = copyRepo();
  const file = "docs/ops/decision-log.md";
  writeFileSync(join(outside, "log.md"), `# Log\n\n## D-777 ${SENTINEL}\n`);
  rmSync(join(repo, file));
  symlinkSync(join(outside, "log.md"), join(repo, file));
  assertRefused(runScript(repo, "check-manifest.mjs"), file);
});

test("links: a folder link that loops back inside the repo ends, and finds nothing new", () => {
  const { repo } = copyRepo();
  symlinkSync(".", join(repo, "specs", "reviews", "loop"), "dir");
  const r = runScript(repo, "check-manifest.mjs");
  assert.equal(r.code, 0, r.out);
});

test("links: a manifest that links outside the repo is refused by the checker and both generators, and nothing is written", () => {
  const { repo, outside } = copyRepo();
  const file = "specs/manifest.json";
  const m = JSON.parse(readFileSync(join(repo, file), "utf8"));
  m.name = SENTINEL;
  writeFileSync(join(outside, "manifest.json"), JSON.stringify(m, null, 2));
  rmSync(join(repo, file));
  symlinkSync(join(outside, "manifest.json"), join(repo, file));
  const before = generated(repo);
  for (const script of ["check-manifest.mjs", "kanban.mjs", "threads.mjs"]) assertRefused(runScript(repo, script), file);
  assert.deepEqual(generated(repo), before);
});
