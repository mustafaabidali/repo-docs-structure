// Fixture tests for scripts/check-manifest.mjs.
//
// Each case mutates this repo's manifest in memory, writes it to a temp file,
// runs the checker against that path, and asserts the exit code and the
// message. Fixture mode skips filesystem and generated-view rules, so these
// cases cover the schema and the cross-reference rules only. The filesystem
// rules run against the real tree in CI on every push.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checker = join(root, "scripts", "check-manifest.mjs");
const live = JSON.parse(readFileSync(join(root, "specs", "manifest.json"), "utf8"));
const dir = mkdtempSync(join(tmpdir(), "manifest-fixture-"));
after(() => rmSync(dir, { recursive: true, force: true }));
/** Today as the checker sees it (UTC), YYYY-MM-DD. */
const TODAY = new Date().toISOString().slice(0, 10);
const LONG_AGO = "2020-01-01";

/**
 * Every case starts from the repo's manifest with an EMPTY work queue, then
 * adds exactly the cards it needs through addCard(). Registries and threads
 * stay as they are so cross-reference tests have real ids to point at. This
 * keeps every result independent of how many cards the real queue holds today.
 * @param {string} name @param {(m: any) => void} mutate @param {string} [checkerPath]
 */
function run(name, mutate, checkerPath = checker) {
  const copy = structuredClone(live);
  copy.work.next = [];
  // The checker ages cards against today's clock, so the fixture is dated today:
  // synthetic cards are never old, whatever the live manifest's date. Only the
  // ageing tests below set an old date, on purpose.
  copy.last_updated = TODAY;
  mutate(copy);
  const file = join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify(copy));
  const result = spawnSync(process.execPath, [checkerPath, file], { cwd: root, encoding: "utf8" });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

// Every card-shape test mutates a synthetic card, never a real one, so the suite holds on an empty queue.
const activeCards = (m) => m.work.next.filter((c) => c.status !== "deferred");

/**
 * A valid active card that depends on nothing in the live queue. Tests that
 * probe a card shape or a ceiling start from this instead of the first live
 * card, so they hold when the queue is empty or fully deferred.
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
 * Append one synthetic plan entry and return it. Cases that need a second plan
 * use this instead of the live registry, so the suite holds on a one-plan
 * manifest. Fixture mode never checks that the file exists.
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

/** @param {string} text */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const firstThread = escapeRegExp(live.metadata.threads[0].id);
/** A URL the schema's default archive pattern accepts. */
const ARCHIVE_URL = "https://github.com/example-org/example-archive/blob/main/specs/plans/2026-01-01-old-plan.md";

test("good: the repo's manifest passes in fixture mode", () => {
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
  assert.match(r.out, new RegExp(`tag "sign-in" is not in threads\\[\\]\\. Valid: .*${firstThread}`));
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
  for (const url of ["http://github.com/example-org/example-archive/blob/main/specs/plans/x.md", "https://example.com/x.md", `${ARCHIVE_URL}/nested.md`]) {
    const r = run("archive-pattern", (m) => {
      const p = addPlan(m, "plan-bad-url");
      delete p.file;
      p.archived = url;
    });
    assert.equal(r.code, 1, `${url}: ${r.out}`);
    assert.match(r.out, /schema \/metadata\/plans\/\d+\/archived: must match pattern/, url);
  }
});

test("archive: the pattern is configured in the schema, so narrowing it there refuses another archive repo", () => {
  const copy = mkdtempSync(join(dir, "narrowed-"));
  cpSync(join(root, "scripts"), join(copy, "scripts"), { recursive: true });
  mkdirSync(join(copy, "specs"));
  symlinkSync(join(root, "node_modules"), join(copy, "node_modules"), "dir");
  const schema = JSON.parse(readFileSync(join(root, "specs", "manifest.schema.json"), "utf8"));
  schema.$defs.archiveUrl.pattern = "^https://github\\.com/example-org/example-archive/blob/main/specs/(plans|design|reviews)/[^/]+\\.md$";
  writeFileSync(join(copy, "specs", "manifest.schema.json"), JSON.stringify(schema));
  const narrowed = join(copy, "scripts", "check-manifest.mjs");
  const archive = (url) => (m) => {
    const p = addPlan(m, "plan-archived");
    delete p.file;
    p.archived = url;
  };
  const ours = run("archive-narrowed-ours", archive(ARCHIVE_URL), narrowed);
  assert.equal(ours.code, 0, ours.out);
  const theirs = run("archive-narrowed-theirs", archive(ARCHIVE_URL.replace("example-org", "someone-else")), narrowed);
  assert.equal(theirs.code, 1, theirs.out);
  assert.match(theirs.out, /archived: must match pattern/);
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
// adds exactly the counts it wants to probe.
/** @param {any} m @param {number} count */
function addActive(m, count) {
  for (let i = 0; i < count; i += 1) addCard(m, `fixture-active-${i}`);
}

test("rule 8: exactly 30 active cards passes", () => {
  const r = run("ceiling-total-ok", (m) => {
    addActive(m, 30);
  });
  assert.equal(r.code, 0, r.out);
});

test("rule 8: 31 active cards fails with the deferral hint", () => {
  const r = run("ceiling-total", (m) => {
    addActive(m, 31);
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /31 active cards; ceiling is 30\. Defer a card/);
});

test("rule 8: exactly 10 P1 cards passes", () => {
  const r = run("ceiling-p1-ok", (m) => {
    addActive(m, 10);
    activeCards(m).slice(0, 10).forEach((c) => { c.priority = 1; });
  });
  assert.equal(r.code, 0, r.out);
});

test("rule 8: 11 P1 cards fails", () => {
  const r = run("ceiling-p1", (m) => {
    addActive(m, 11);
    activeCards(m).slice(0, 11).forEach((c) => { c.priority = 1; });
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /11 active priority-1 cards; ceiling is 10/);
});

test("rule 8: three in_progress cards passes", () => {
  const r = run("inprogress-three-ok", (m) => {
    addActive(m, 3);
    for (const c of activeCards(m)) { c.status = "in_progress"; c.plan = m.work.active_plan; }
  });
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /WARN/);
});

test("rule 8: four in_progress cards fails", () => {
  const r = run("ceiling-inprogress", (m) => {
    addActive(m, 4);
    for (const c of activeCards(m)) { c.status = "in_progress"; c.plan = m.work.active_plan; }
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /4 cards in_progress; ceiling is 3/);
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

test("rule 8: 11 owner cards fails", () => {
  const r = run("ceiling-owner", (m) => {
    addActive(m, 11);
    activeCards(m).slice(0, 11).forEach((c) => { c.actor = "owner"; });
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /11 active owner cards; ceiling is 10/);
});

test("rule 8: deferred cards do not count toward ceilings", () => {
  const r = run("deferred-exempt", (m) => {
    addActive(m, 30);
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
  assert.match(r.out, new RegExp(`threads \\(${firstThread}\\): file must be specs/threads/${firstThread}\\.md`));
});

test("carried over: thread created later than last_updated fails", () => {
  const r = run("thread-created", (m) => { m.metadata.threads[0].created = "2099-01-01"; });
  assert.equal(r.code, 1);
  assert.match(r.out, new RegExp(`threads \\(${firstThread}\\): created 2099-01-01 is later than last_updated`));
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
