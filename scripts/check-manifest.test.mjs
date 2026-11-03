// Fixture tests for scripts/check-manifest.mjs.
//
// Each case starts from a small synthetic manifest of its own (one thread, one
// plan, an empty queue), mutates it, writes it to a temp file, runs the checker
// against that path, and asserts the exit code and the message. The repo's
// own manifest is never read, so its threads, plans and archived entries
// cannot change a result; `npm run check` checks it in CI. Fixture mode skips
// filesystem and generated-view rules, so these cases cover the schema and the
// cross-reference rules only.
//
// The checker runs from a copy of the scripts whose schema is the repo's own
// with one change: the archive pattern is a fixture pattern, so a repo that
// narrows its own pattern changes no result either.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { CEILINGS } from "./lib/settings.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "manifest-fixture-"));
after(() => rmSync(dir, { recursive: true, force: true }));
/** Today as the checker sees it (UTC), YYYY-MM-DD. */
const TODAY = new Date().toISOString().slice(0, 10);
const LONG_AGO = "2020-01-01";

const THREAD = "fixture-thread";
const PLAN = "plan-fixture-base";
/** The archive repo of the fixture schema, and a URL into it. */
const ARCHIVE_PATTERN = "^https://github\\.com/fixture-org/fixture-archive/blob/main/specs/(plans|design|reviews)/[^/]+\\.md$";
const ARCHIVE_URL = "https://github.com/fixture-org/fixture-archive/blob/main/specs/plans/2026-01-01-old-plan.md";

/**
 * A copy of the scripts beside the repo's schema with the fixture archive
 * pattern, and the installed dependencies; returns the copy's checker.
 * @param {(schema: any) => void} [mutateSchema]
 */
function checkerCopy(mutateSchema = () => {}) {
  const copy = mkdtempSync(join(dir, "checker-"));
  cpSync(join(root, "scripts"), join(copy, "scripts"), { recursive: true });
  mkdirSync(join(copy, "specs"));
  symlinkSync(join(root, "node_modules"), join(copy, "node_modules"), "dir");
  const schema = JSON.parse(readFileSync(join(root, "specs", "manifest.schema.json"), "utf8"));
  assert.equal(typeof schema.$defs?.archiveUrl?.pattern, "string", "the schema keeps its archive pattern in $defs.archiveUrl.pattern");
  schema.$defs.archiveUrl.pattern = ARCHIVE_PATTERN;
  mutateSchema(schema);
  writeFileSync(join(copy, "specs", "manifest.schema.json"), JSON.stringify(schema));
  return join(copy, "scripts", "check-manifest.mjs");
}

const checker = checkerCopy();

/** The synthetic starting manifest: one thread, one plan, an empty queue, dated today. */
function baseManifest() {
  return {
    $schema: "./manifest.schema.json",
    name: "Fixture project",
    // The checker ages cards against today's clock, so the fixture is dated
    // today: synthetic cards are never old. Only the ageing tests below set an
    // old date, on purpose.
    last_updated: TODAY,
    work: { active_plan: PLAN, next: [] },
    metadata: {
      threads: [{ id: THREAD, title: "Fixture thread", file: `specs/threads/${THREAD}.md`, created: TODAY }],
      plans: [{ id: PLAN, title: "Fixture base plan", file: `specs/plans/${TODAY}-${PLAN}.md`, created: TODAY, status: "approved", tags: [THREAD] }],
      specs: [],
      reviews: [],
    },
  };
}

/**
 * Every case starts from baseManifest(), then adds exactly the cards it needs
 * through addCard(), so every result is independent of the repo's own queue,
 * threads and registries.
 * @param {string} name @param {(m: any) => void} mutate @param {string} [checkerPath]
 */
function run(name, mutate, checkerPath = checker) {
  const m = baseManifest();
  mutate(m);
  const file = join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify(m));
  const result = spawnSync(process.execPath, [checkerPath, file], { cwd: root, encoding: "utf8" });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

// Every card-shape test mutates a synthetic card, never a real one, so the suite holds on an empty queue.
const activeCards = (m) => m.work.next.filter((c) => c.status !== "deferred");

/**
 * A valid active card that depends on nothing else in the queue.
 * @param {any} m @param {string} id
 */
function syntheticCard(m, id) {
  return {
    id,
    title: "Synthetic fixture card here",
    created: m.last_updated,
    priority: 2,
    status: "pending",
    tags: [m.metadata.threads[0].id],
    acceptance: "Fixture passes.",
    scope: "Synthetic card for a fixture.",
  };
}

/** Append one synthetic active card and return it. */
function addCard(m, id = `fixture-${m.work.next.length}`) {
  const c = syntheticCard(m, id);
  m.work.next.push(c);
  return c;
}

/**
 * Append one synthetic plan entry and return it. Fixture mode never checks
 * that the file exists.
 * @param {any} m @param {string} id
 */
function addPlan(m, id = "plan-fixture") {
  const p = {
    id,
    title: "Fixture plan",
    file: `specs/plans/${m.last_updated}-${id}.md`,
    created: m.last_updated,
    status: "approved",
    tags: [m.metadata.threads[0].id],
  };
  m.metadata.plans.push(p);
  return p;
}

test("good: the synthetic starting manifest passes in fixture mode", () => {
  const r = run("good", () => {});
  assert.equal(r.code, 0, r.out);
});

test("rule 1: unknown root key fails the schema", () => {
  const r = run("root-key", (m) => { m.stack = { framework: "next" }; });
  assert.equal(r.code, 1);
  assert.match(r.out, /schema.*additional.*stack/i);
});

test("rule 1: unknown card key fails the schema", () => {
  const r = run("card-key", (m) => { addCard(m).handoff = "x"; });
  assert.equal(r.code, 1);
  assert.match(r.out, /additional.*handoff/i);
});

test("rule 1: active card without acceptance fails", () => {
  const r = run("no-acceptance", (m) => { delete addCard(m).acceptance; });
  assert.equal(r.code, 1);
  assert.match(r.out, /acceptance/);
});

test("rule 1: deferred card without reason fails", () => {
  const r = run("deferred-no-reason", (m) => {
    const c = addCard(m);
    c.status = "deferred";
    delete c.acceptance;
    c.deferred = { date: m.last_updated };
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /reason/);
});

test("rule 1: deferred card that still carries acceptance fails", () => {
  const r = run("deferred-with-acceptance", (m) => {
    const c = addCard(m);
    c.status = "deferred";
    c.deferred = { date: m.last_updated, reason: "fixture" };
    // acceptance left in place on purpose
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /schema/);
});

test("rule 1: active card that carries a deferred object fails", () => {
  const r = run("active-with-deferred", (m) => {
    const c = addCard(m);
    c.deferred = { date: m.last_updated, reason: "fixture" };
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /schema/);
});

test("rule 1: bad actor value fails", () => {
  const r = run("actor", (m) => { addCard(m).actor = "founder"; });
  assert.equal(r.code, 1);
  assert.match(r.out, /actor|enum/i);
});

test("rule 1: bad date fails", () => {
  const r = run("date", (m) => { addCard(m).created = "16/09/2026"; });
  assert.equal(r.code, 1);
});

test("rule 2: tag not in threads fails and lists valid ids", () => {
  const r = run("tag", (m) => { addCard(m).tags.push("sign-in"); });
  assert.equal(r.code, 1);
  assert.match(r.out, new RegExp(`tag "sign-in" is not in threads\\[\\]\\. Valid: .*${THREAD}`));
});

test("archive: a registry entry with archived instead of file passes", () => {
  const r = run("archive-ok", (m) => {
    const p = addPlan(m, "plan-archived");
    delete p.file;
    p.archived = ARCHIVE_URL;
  });
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /ERROR/);
});

test("archive: a registry entry with both file and archived fails the schema", () => {
  const r = run("archive-both", (m) => { addPlan(m, "plan-both").archived = ARCHIVE_URL; });
  assert.equal(r.code, 1);
  assert.match(r.out, /schema \/metadata\/plans\/\d+/);
});

test("archive: a registry entry with neither file nor archived fails the schema", () => {
  const r = run("archive-neither", (m) => { delete addPlan(m, "plan-neither").file; });
  assert.equal(r.code, 1);
  assert.match(r.out, /schema \/metadata\/plans\/\d+/);
});

test("archive: an archived URL outside the archive pattern fails the schema", () => {
  for (const url of ["http://github.com/fixture-org/fixture-archive/blob/main/specs/plans/x.md", "https://example.com/x.md", `${ARCHIVE_URL}/nested.md`]) {
    const r = run("archive-pattern", (m) => {
      const p = addPlan(m, "plan-bad-url");
      delete p.file;
      p.archived = url;
    });
    assert.equal(r.code, 1, `${url}: ${r.out}`);
    assert.match(r.out, /schema \/metadata\/plans\/\d+\/archived: must match pattern/, url);
  }
});

test("archive: a URL into another archive repo fails, so the pattern names the repo's own archive", () => {
  const r = run("archive-other-repo", (m) => {
    const p = addPlan(m, "plan-archived");
    delete p.file;
    p.archived = ARCHIVE_URL.replace("fixture-org", "someone-else");
  });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /archived: must match pattern/);
});

test("archive: the checker reads the pattern from the schema", () => {
  const widened = checkerCopy((schema) => { schema.$defs.archiveUrl.pattern = "^https://github\\.com/someone-else/[^/]+/blob/main/specs/plans/[^/]+\\.md$"; });
  const r = run("archive-widened", (m) => {
    const p = addPlan(m, "plan-archived");
    delete p.file;
    p.archived = ARCHIVE_URL.replace("fixture-org", "someone-else");
  }, widened);
  assert.equal(r.code, 0, r.out);
});

test("figma: a registry entry with figma file and page_id passes", () => {
  const r = run("figma-ok", (m) => { m.metadata.plans[0].figma = { file: "abc123", page_id: "1:2" }; });
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /ERROR/);
});

test("figma: figma without page_id, or with another key, fails the schema", () => {
  const missing = run("figma-no-page", (m) => { m.metadata.plans[0].figma = { file: "abc123" }; });
  assert.equal(missing.code, 1);
  assert.match(missing.out, /figma.*page_id/);
  const extra = run("figma-extra", (m) => { m.metadata.plans[0].figma = { file: "abc123", page_id: "1:2", chooser_id: "3:4" }; });
  assert.equal(extra.code, 1);
  assert.match(extra.out, /schema.*additional.*\(chooser_id\)/i);
});

test("rule 3: duplicate thread id fails", () => {
  const r = run("dup-thread", (m) => { m.metadata.threads.push({ ...m.metadata.threads[0] }); });
  assert.equal(r.code, 1);
  assert.match(r.out, /duplicate id/);
});

test("rule 5: blocked_by must resolve to a card", () => {
  const r = run("blocked-by", (m) => { addCard(m).blocked_by = ["no-such-card"]; });
  assert.equal(r.code, 1);
  assert.match(r.out, /blocked_by no-such-card/);
});

// Finished work: a finished card is deleted together with its id in every
// other card's blocked_by (deferred cards included), in the same manifest change.
/** @param {any} m */
function addFinishedAndNext(m) {
  const finished = addCard(m, "finished-card");
  finished.status = "in_progress";
  finished.plan = m.work.active_plan;
  const next = addCard(m, "next-card");
  next.blocked_by = ["finished-card"];
  const later = addCard(m, "later-deferred");
  later.status = "deferred";
  delete later.acceptance;
  later.deferred = { date: m.last_updated, reason: "fixture" };
  later.blocked_by = ["finished-card", "next-card"];
  return { next, later };
}

/** @param {any} m @param {string} id */
const deleteCard = (m, id) => { m.work.next = m.work.next.filter((c) => c.id !== id); };

test("finished work: deleting a card and removing it from every blocked_by passes", () => {
  const r = run("done-delete-clean", (m) => {
    const { next, later } = addFinishedAndNext(m);
    deleteCard(m, "finished-card");
    delete next.blocked_by;
    next.status = "in_progress";
    next.plan = m.work.active_plan;
    later.blocked_by = later.blocked_by.filter((id) => id !== "finished-card");
  });
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /ERROR/);
});

test("finished work: deleting a card but leaving it in another card's blocked_by fails naming it", () => {
  const r = run("done-delete-dangling", (m) => {
    const { later } = addFinishedAndNext(m);
    deleteCard(m, "finished-card");
    later.blocked_by = ["next-card"];
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /card next-card: blocked_by finished-card does not resolve to a card/);
});

test("finished work: a deferred card still naming the deleted card fails too", () => {
  const r = run("done-delete-dangling-deferred", (m) => {
    const { next } = addFinishedAndNext(m);
    deleteCard(m, "finished-card");
    delete next.blocked_by;
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /card later-deferred: blocked_by finished-card does not resolve to a card/);
});

test("finished work: an emptied blocked_by array fails the schema, so the field is dropped", () => {
  const r = run("done-empty-blocked-by", (m) => {
    const { next, later } = addFinishedAndNext(m);
    deleteCard(m, "finished-card");
    next.blocked_by = [];
    later.blocked_by = ["next-card"];
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /schema \/work\/next\/\d+\/blocked_by/);
});

test("rule 5: depends_on must resolve to a plan or spec", () => {
  const r = run("depends-on", (m) => { m.metadata.plans[0].depends_on = ["nothing"]; });
  assert.equal(r.code, 1);
  assert.match(r.out, /depends_on nothing/);
});

test("rule 5: supersedes without matching superseded_by fails", () => {
  const r = run("supersedes", (m) => {
    const a = m.metadata.plans[0];
    const b = addPlan(m);
    delete a.supersedes; delete a.superseded_by;
    a.supersedes = b.id;
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /does not say superseded_by/);
});

test("rule 7: active_plan must resolve", () => {
  const r = run("active-plan", (m) => { m.work.active_plan = "plan-none"; });
  assert.equal(r.code, 1);
  assert.match(r.out, /active_plan plan-none does not resolve/);
});

// Rule 8 tests build their own boundary state from an empty queue; each test
// adds exactly the counts it wants to probe, read from the settings, so a repo
// that changes a ceiling moves the boundary these cases probe with it.
/** @param {any} m @param {number} count */
function addActive(m, count) {
  for (let i = 0; i < count; i += 1) addCard(m, `fixture-active-${i}`);
}

test("rule 8: exactly the total ceiling of active cards passes", () => {
  const r = run("ceiling-total-ok", (m) => {
    addActive(m, CEILINGS.total);
  });
  assert.equal(r.code, 0, r.out);
});

test("rule 8: one active card over the total ceiling fails with the deferral hint", () => {
  const r = run("ceiling-total", (m) => {
    addActive(m, CEILINGS.total + 1);
  });
  assert.equal(r.code, 1);
  assert.match(r.out, new RegExp(`${CEILINGS.total + 1} active cards; ceiling is ${CEILINGS.total}\\. Defer a card`));
});

test("rule 8: exactly the priority-1 ceiling passes", () => {
  const r = run("ceiling-p1-ok", (m) => {
    addActive(m, CEILINGS.p1);
    activeCards(m).forEach((c) => { c.priority = 1; });
  });
  assert.equal(r.code, 0, r.out);
});

test("rule 8: one priority-1 card over the ceiling fails", () => {
  const r = run("ceiling-p1", (m) => {
    addActive(m, CEILINGS.p1 + 1);
    activeCards(m).forEach((c) => { c.priority = 1; });
  });
  assert.equal(r.code, 1);
  assert.match(r.out, new RegExp(`${CEILINGS.p1 + 1} active priority-1 cards; ceiling is ${CEILINGS.p1}\\b`));
});

test("rule 8: exactly the in_progress ceiling passes", () => {
  const r = run("inprogress-ok", (m) => {
    addActive(m, CEILINGS.inProgress);
    for (const c of activeCards(m)) { c.status = "in_progress"; c.plan = m.work.active_plan; }
  });
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /WARN/);
});

test("rule 8: one in_progress card over the ceiling fails", () => {
  const r = run("ceiling-inprogress", (m) => {
    addActive(m, CEILINGS.inProgress + 1);
    for (const c of activeCards(m)) { c.status = "in_progress"; c.plan = m.work.active_plan; }
  });
  assert.equal(r.code, 1);
  assert.match(r.out, new RegExp(`${CEILINGS.inProgress + 1} cards in_progress; ceiling is ${CEILINGS.inProgress}\\b`));
});

test("warn: in_progress card on a plan other than active_plan warns but passes", () => {
  const r = run("inprogress-plan-warn", (m) => {
    const c = addCard(m);
    c.status = "in_progress";
    c.plan = addPlan(m).id;
    // keep active_plan busy so only the mismatch warning fires
    const d = addCard(m); d.plan = m.work.active_plan;
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /WARN card fixture-0: in_progress on plan .* while work\.active_plan is /);
});

test("warn: in_progress card without a plan passes with no warning", () => {
  const r = run("inprogress-no-plan", (m) => {
    const c = addCard(m);
    c.status = "in_progress";
    const d = addCard(m); d.plan = m.work.active_plan;
  });
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /WARN/);
});

test("warn: active_plan with zero active cards warns but passes", () => {
  const r = run("active-plan-idle", (m) => {
    const c = addCard(m);
    c.plan = addPlan(m).id;
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /WARN work\.active_plan .* has no active card/);
});

test("rule 8: exactly the owner ceiling passes", () => {
  const r = run("ceiling-owner-ok", (m) => {
    addActive(m, CEILINGS.owner);
    activeCards(m).forEach((c) => { c.actor = "owner"; });
  });
  assert.equal(r.code, 0, r.out);
});

test("rule 8: one owner card over the ceiling fails", () => {
  const r = run("ceiling-owner", (m) => {
    addActive(m, CEILINGS.owner + 1);
    activeCards(m).forEach((c) => { c.actor = "owner"; });
  });
  assert.equal(r.code, 1);
  assert.match(r.out, new RegExp(`${CEILINGS.owner + 1} active owner cards; ceiling is ${CEILINGS.owner}\\b`));
});

test("rule 8: deferred cards do not count toward ceilings", () => {
  const r = run("deferred-exempt", (m) => {
    addActive(m, CEILINGS.total);
    for (let i = 0; i < 5; i += 1) {
      const c = addCard(m, `deferred-extra-${i}`);
      c.status = "deferred"; delete c.acceptance;
      c.deferred = { date: m.last_updated, reason: "fixture" };
    }
  });
  assert.equal(r.code, 0, r.out);
});

test("rule 3: thread file must derive from its id", () => {
  const r = run("thread-file", (m) => { m.metadata.threads[0].file = "specs/threads/authentication.md"; });
  assert.equal(r.code, 1);
  assert.match(r.out, new RegExp(`threads \\(${THREAD}\\): file must be specs/threads/${THREAD}\\.md`));
});

test("carried over: thread created later than last_updated fails", () => {
  const r = run("thread-created", (m) => { m.metadata.threads[0].created = "2099-01-01"; });
  assert.equal(r.code, 1);
  assert.match(r.out, new RegExp(`threads \\(${THREAD}\\): created 2099-01-01 is later than last_updated`));
});

test("carried over: created later than last_updated fails", () => {
  const r = run("last-updated", (m) => { addCard(m).created = "2099-01-01"; });
  assert.equal(r.code, 1);
  assert.match(r.out, /later than last_updated/);
});

test("warn: title outside 3 to 8 words warns but passes", () => {
  const r = run("title", (m) => { addCard(m).title = "Two words"; });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /WARN.*title has 2 words/);
});

test("warn: an active card created over 60 days ago warns but passes", () => {
  const r = run("age-active", (m) => { addCard(m, "old-card").created = LONG_AGO; });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`WARN card old-card: active and created ${LONG_AGO}, older than 60 days`));
});

test("warn: a card deferred over 90 days ago warns but passes", () => {
  const r = run("age-deferred", (m) => {
    const c = addCard(m, "old-deferred");
    c.status = "deferred";
    delete c.acceptance;
    c.deferred = { date: LONG_AGO, reason: "fixture" };
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`WARN card old-deferred: deferred since ${LONG_AGO}, over 90 days`));
});

test("fixture: a synthetic card is dated today, so it never warns about its age", () => {
  const r = run("age-today", (m) => { addCard(m, "new-card").plan = m.work.active_plan; });
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /older than 60 days|over 90 days/);
});
