// Tests for the two generators, threads.mjs and kanban.mjs, run against a
// copy of this checkout in a temp folder. Each case breaks the copy one way
// and checks that the generator refuses before it reads or writes anything
// outside its own folder, and that it writes nothing at all when it refuses.
//
// The copy gains a second thread, so a case can break one thread file and
// prove the other was not written. Thread ids come from the manifest, never
// from a literal, so the suite holds whatever threads a repo defines.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { copyCheckout } from "./lib/copy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KEEP = "authored text outside the checkout; keep me\n";
const SECOND = "fixture-second-thread";

/** Every temp folder made here, removed when the file's tests end. */
const temps = [];
after(() => { for (const base of temps) rmSync(base, { recursive: true, force: true }); });

/** A copy of the checkout (no .git, no node_modules) beside an "outside" folder, with a second thread and its views generated. */
function copyRepo() {
  const base = mkdtempSync(join(tmpdir(), "generators-"));
  temps.push(base);
  const repo = join(base, "repo");
  copyCheckout(root, repo);
  const outside = join(base, "outside");
  mkdirSync(outside);
  editManifest(repo, (m) => {
    m.metadata.threads.push({ id: SECOND, title: "Second fixture thread", file: `specs/threads/${SECOND}.md`, created: m.last_updated });
  });
  for (const script of ["threads.mjs", "kanban.mjs"]) {
    const generated = runScript(repo, script);
    assert.equal(generated.code, 0, generated.out);
  }
  const first = JSON.parse(readFileSync(join(repo, "specs", "manifest.json"), "utf8")).metadata.threads[0].id;
  return { base, repo, outside, first };
}

/** @param {string} repo @param {(m: any) => void} mutate */
function editManifest(repo, mutate) {
  const path = join(repo, "specs", "manifest.json");
  const m = JSON.parse(readFileSync(path, "utf8"));
  mutate(m);
  writeFileSync(path, JSON.stringify(m, null, 2));
}

/** Make the second thread file stale, so a generator that writes anything would change it. */
function makeStale(repo) {
  const path = join(repo, "specs", "threads", `${SECOND}.md`);
  const text = readFileSync(path, "utf8").replace(/<!-- generated:start -->[\s\S]*<!-- generated:end -->\n/, "");
  writeFileSync(path, text);
  return () => readFileSync(path, "utf8") === text;
}

/** @param {string} repo @param {string} script @param {string[]} [args] */
function runScript(repo, script, args = []) {
  const r = spawnSync(process.execPath, [join(repo, "scripts", script), ...args], { cwd: repo, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test("threads: an unchanged copy of the checkout is fresh", () => {
  const { repo } = copyRepo();
  const r = runScript(repo, "threads.mjs", ["--check"]);
  assert.equal(r.code, 0, r.out);
});

test("threads: a thread file of ../other-project/README.md is refused and nothing is written", () => {
  const { base, repo, first } = copyRepo();
  const target = join(base, "other-project", "README.md");
  mkdirSync(dirname(target));
  writeFileSync(target, KEEP);
  const unchanged = makeStale(repo);
  editManifest(repo, (m) => { m.metadata.threads[0].file = "../other-project/README.md"; });
  const r = runScript(repo, "threads.mjs");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`thread ${first}: file must be specs/threads/${first}\\.md; found \\.\\./other-project/README\\.md`));
  assert.equal(readFileSync(target, "utf8"), KEEP);
  assert.ok(unchanged(), "a refused run wrote a thread file");
});

test("threads: a thread file of ../x.md that does not exist is refused and not created", () => {
  const { base, repo } = copyRepo();
  editManifest(repo, (m) => { m.metadata.threads[0].file = "specs/threads/../../../x.md"; });
  const r = runScript(repo, "threads.mjs");
  assert.equal(r.code, 1, r.out);
  assert.ok(!existsSync(join(base, "x.md")));
});

test("threads: a thread id outside the id pattern is refused", () => {
  const { base, repo } = copyRepo();
  editManifest(repo, (m) => {
    m.metadata.threads[0].id = "../../x";
    m.metadata.threads[0].file = "specs/threads/../../x.md";
  });
  const r = runScript(repo, "threads.mjs");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /thread \.\.\/\.\.\/x: id must match/);
  assert.ok(!existsSync(join(base, "x.md")));
});

test("threads: a thread file that is a link out of specs/threads is refused", () => {
  const { repo, outside, first } = copyRepo();
  const target = join(outside, `${first}.md`);
  writeFileSync(target, KEEP);
  const link = join(repo, "specs", "threads", `${first}.md`);
  rmSync(link);
  symlinkSync(target, link);
  const unchanged = makeStale(repo);
  const r = runScript(repo, "threads.mjs");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`specs/threads/${first}\\.md resolves outside specs/threads`));
  assert.equal(readFileSync(target, "utf8"), KEEP);
  assert.ok(unchanged(), "a refused run wrote a thread file");
});

test("threads: a broken link in specs/threads is refused and its target not created", () => {
  const { repo, outside, first } = copyRepo();
  const target = join(outside, "missing.md");
  const link = join(repo, "specs", "threads", `${first}.md`);
  rmSync(link);
  symlinkSync(target, link);
  const r = runScript(repo, "threads.mjs");
  assert.equal(r.code, 1, r.out);
  assert.ok(!existsSync(target));
});

test("threads: a specs/threads folder that links out of the checkout is refused", () => {
  const { repo, outside, first } = copyRepo();
  const folder = join(repo, "specs", "threads");
  cpSync(folder, join(outside, "threads"), { recursive: true });
  rmSync(folder, { recursive: true });
  symlinkSync(join(outside, "threads"), folder);
  const before = readFileSync(join(outside, "threads", `${first}.md`), "utf8");
  editManifest(repo, (m) => { m.metadata.threads[0].title = "Changed title"; });
  const r = runScript(repo, "threads.mjs");
  assert.equal(r.code, 1, r.out);
  assert.equal(readFileSync(join(outside, "threads", `${first}.md`), "utf8"), before);
});

test("threads: a docs/adr/README.md that links outside is refused", () => {
  const { repo, outside } = copyRepo();
  const target = join(outside, "README.md");
  writeFileSync(target, KEEP);
  const link = join(repo, "docs", "adr", "README.md");
  rmSync(link);
  symlinkSync(target, link);
  const r = runScript(repo, "threads.mjs");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /docs\/adr\/README\.md resolves outside docs\/adr/);
  assert.equal(readFileSync(target, "utf8"), KEEP);
});

test("threads: a start marker with no end marker is refused naming the file, and nothing is written", () => {
  const { repo, first } = copyRepo();
  const path = join(repo, "specs", "threads", `${first}.md`);
  const broken = readFileSync(path, "utf8").replace("<!-- generated:end -->\n", "") + "\n## Footer written by hand\n\nkeep me\n";
  writeFileSync(path, broken);
  const unchanged = makeStale(repo);
  const r = runScript(repo, "threads.mjs");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`specs/threads/${first}\\.md: .*generated:start.*no generated:end`));
  assert.equal(readFileSync(path, "utf8"), broken);
  assert.ok(unchanged(), "a refused run wrote another thread file");
});

test("kanban: a specs/KANBAN.md that links outside is refused", () => {
  const { repo, outside } = copyRepo();
  const target = join(outside, "KANBAN.md");
  writeFileSync(target, KEEP);
  const link = join(repo, "specs", "KANBAN.md");
  rmSync(link);
  symlinkSync(target, link);
  const r = runScript(repo, "kanban.mjs");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /specs\/KANBAN\.md resolves outside specs/);
  assert.equal(readFileSync(target, "utf8"), KEEP);
});

test("kanban: an unchanged copy of the checkout is fresh", () => {
  const { repo } = copyRepo();
  const r = runScript(repo, "kanban.mjs", ["--check"]);
  assert.equal(r.code, 0, r.out);
});

test("threads: an archived entry links to its archive URL", () => {
  const { repo, first } = copyRepo();
  const url = "https://github.com/example-org/example-archive/blob/main/specs/plans/2026-01-01-old-plan.md";
  editManifest(repo, (m) => {
    m.metadata.plans.push({ id: "plan-old", title: "An old plan", archived: url, created: m.last_updated, status: "completed", tags: [first] });
  });
  const r = runScript(repo, "threads.mjs");
  assert.equal(r.code, 0, r.out);
  const text = readFileSync(join(repo, "specs", "threads", `${first}.md`), "utf8");
  assert.ok(text.includes(`- [An old plan](${url}) (\`plan-old\`, completed, archived)`), text);
});
