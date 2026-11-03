#!/usr/bin/env node
/**
 * Validates specs/manifest.json, the ADR files, and the generated views.
 *
 * Rules (hard, exit 1):
 *   1. The file validates against specs/manifest.schema.json.
 *   2. Every tag on a card, registry entry, or ADR resolves to metadata.threads[].id.
 *   3. threads[].id is unique. threads[].file equals specs/threads/<id>.md and exists.
 *      threads[].created is not later than last_updated.
 *   4. Every registry file exists (an archived entry has a URL, not a file).
 *      Every file under specs/plans, specs/design, specs/reviews (recursively)
 *      is registered; a missing folder has none.
 *      Every docs/adr/NNNN-*.md has the eight sections in order and no number
 *      is used twice.
 *   5. depends_on, blocked_by, supersedes, superseded_by resolve; supersede pairs agree.
 *   6. No key outside the schema on a card or registry entry (schema). An
 *      archived URL matches the schema's $defs.archiveUrl pattern; narrow it
 *      there to this repository's archive repo.
 *   7. work.active_plan resolves to plans[].id.
 *   8. Ceilings on active cards (CEILINGS below): 30 total, 10 P1,
 *      3 in_progress, 10 owner.
 *   9. Every D-NNN cited in a scope resolves to a heading in docs/ops/decision-log.md.
 *  10. kanban.mjs --check and threads.mjs --check pass.
 *  Carried over: no created later than last_updated.
 *
 * Soft (WARN, exit 0): unused thread; card deferred over 90 days; active card
 * older than 60 days; title outside 3 to 8 words; in_progress card on a plan
 * other than active_plan; active_plan with no active card.
 *
 * Pass another manifest path to exercise the schema and cross-reference rules
 * without the filesystem or generated-view rules:
 *
 *   node scripts/check-manifest.mjs path/to/fixture-manifest.json
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { ADR_SECTIONS, actorOf, duplicateAdrNumbers, isActive, manifestPath, readAdrs, readManifest, walkMarkdown } from "./lib/manifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const givenPath = process.argv[2];
const path = resolve(givenPath ?? manifestPath(root));
const fixtureMode = givenPath !== undefined;
const schemaPath = join(root, "specs", "manifest.schema.json");
const decisionLogPath = join(root, "docs", "ops", "decision-log.md");

// The template's ceilings. A repo may change them here; the rule 8 cases in
// check-manifest.test.mjs probe these values, so change the two together.
const CEILINGS = { total: 30, p1: 10, inProgress: 3, owner: 10 };
const DAY_MS = 24 * 60 * 60 * 1000;
const REGISTERED_DIRS = ["specs/plans", "specs/design", "specs/reviews"];

/** @param {unknown} value */
function oneLine(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

/** @param {string} relative */
function isFile(relative) {
  try {
    return statSync(resolve(root, relative)).isFile();
  } catch {
    return false;
  }
}

/** @param {string} script @param {string[]} errors @param {string} label */
function runCheck(script, errors, label) {
  const result = spawnSync(process.execPath, [join(root, "scripts", script), "--check"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) {
    errors.push(`${label} could not start: ${oneLine(result.error.message)}`);
    return;
  }
  if (result.status !== 0) {
    const detail = oneLine([result.stdout, result.stderr].filter(Boolean).join(" "));
    errors.push(`${label} failed${detail ? `: ${detail}` : ""}`);
  }
}

function main() {
  const errors = [];
  const warnings = [];

  let manifest;
  try {
    manifest = readManifest(path);
  } catch (error) {
    console.error(`ERROR could not read manifest: ${oneLine(error)}`);
    process.exitCode = 1;
    return;
  }

  // Rule 1: schema.
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, "utf8")));
  if (!validate(manifest)) {
    for (const issue of validate.errors ?? []) {
      errors.push(`schema ${issue.instancePath || "/"}: ${issue.message}${issue.params?.additionalProperty ? ` (${issue.params.additionalProperty})` : ""}`);
    }
    // A manifest that fails the schema has no reliable shape for the rest.
    report(errors, warnings);
    return;
  }

  const cards = manifest.work.next;
  const { threads, plans, specs, reviews } = manifest.metadata;
  const threadIds = new Set(threads.map((t) => t.id));
  const validTagList = threads.map((t) => t.id).sort().join(", ");
  const planIds = new Set(plans.map((p) => p.id));
  const specIds = new Set(specs.map((s) => s.id));
  const cardIds = new Set(cards.map((c) => c.id));
  const registry = [
    ...plans.map((e) => ({ kind: "plans", entry: e })),
    ...specs.map((e) => ({ kind: "specs", entry: e })),
    ...reviews.map((e) => ({ kind: "reviews", entry: e })),
  ];

  /** @param {string} label @param {string[]} tags */
  const checkTags = (label, tags) => {
    for (const tag of tags) {
      if (!threadIds.has(tag)) errors.push(`${label}: tag "${tag}" is not in threads[]. Valid: ${validTagList}`);
    }
  };

  // Rule 3: threads unique (schema does not check cross-item uniqueness).
  const seenThreads = new Set();
  for (const t of threads) {
    if (seenThreads.has(t.id)) errors.push(`threads: duplicate id ${t.id}`);
    seenThreads.add(t.id);
    const expectedFile = `specs/threads/${t.id}.md`;
    if (t.file !== expectedFile) errors.push(`threads (${t.id}): file must be ${expectedFile}; found ${t.file}`);
    if (t.created > manifest.last_updated) errors.push(`threads (${t.id}): created ${t.created} is later than last_updated ${manifest.last_updated}`);
    if (!fixtureMode && !isFile(t.file)) errors.push(`threads (${t.id}): file ${t.file} does not exist`);
  }

  // Cards: unique ids, tags, pointers, dates, titles.
  const seenCards = new Set();
  const decisionRefs = new Set();
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  for (const card of cards) {
    const label = `card ${card.id}`;
    if (seenCards.has(card.id)) errors.push(`${label}: duplicate id`);
    seenCards.add(card.id);
    checkTags(label, card.tags);
    if (card.plan && !planIds.has(card.plan)) errors.push(`${label}: plan ${card.plan} does not resolve`);
    if (card.spec && !specIds.has(card.spec)) errors.push(`${label}: spec ${card.spec} does not resolve`);
    for (const dep of card.blocked_by ?? []) {
      if (!cardIds.has(dep)) errors.push(`${label}: blocked_by ${dep} does not resolve to a card`);
    }
    if (card.created > manifest.last_updated) errors.push(`${label}: created ${card.created} is later than last_updated ${manifest.last_updated}`);
    for (const ref of String(card.scope).matchAll(/\bD-\d{3}\b/g)) decisionRefs.add(ref[0]);

    const words = String(card.title).trim().split(/\s+/).filter(Boolean).length;
    if (words < 3 || words > 8) warnings.push(`${label}: title has ${words} words; expected 3 to 8`);
    const createdAt = Date.parse(`${card.created}T00:00:00Z`);
    if (isActive(card) && todayUtc - createdAt > 60 * DAY_MS) warnings.push(`${label}: active and created ${card.created}, older than 60 days`);
    if (card.status === "deferred") {
      const deferredAt = Date.parse(`${card.deferred.date}T00:00:00Z`);
      if (todayUtc - deferredAt > 90 * DAY_MS) warnings.push(`${label}: deferred since ${card.deferred.date}, over 90 days`);
    }
  }

  // Registry: unique ids, tags, pointers, files.
  const seenRegistry = new Set();
  const supersedes = new Map();
  const supersededBy = new Map();
  for (const { kind, entry } of registry) {
    const label = `${kind} ${entry.id}`;
    if (seenRegistry.has(entry.id)) errors.push(`${label}: duplicate id across registries`);
    seenRegistry.add(entry.id);
    checkTags(label, entry.tags);
    if (entry.created > manifest.last_updated) errors.push(`${label}: created ${entry.created} is later than last_updated`);
    if (!fixtureMode && entry.file && !isFile(entry.file)) errors.push(`${label}: file ${entry.file} does not exist`);
    for (const dep of entry.depends_on ?? []) {
      if (!planIds.has(dep) && !specIds.has(dep)) errors.push(`${label}: depends_on ${dep} does not resolve to a plan or spec`);
    }
    if (entry.supersedes) {
      if (!planIds.has(entry.supersedes) && !specIds.has(entry.supersedes)) errors.push(`${label}: supersedes ${entry.supersedes} does not resolve`);
      supersedes.set(entry.id, entry.supersedes);
    }
    if (entry.superseded_by) {
      if (!planIds.has(entry.superseded_by) && !specIds.has(entry.superseded_by)) errors.push(`${label}: superseded_by ${entry.superseded_by} does not resolve`);
      supersededBy.set(entry.id, entry.superseded_by);
    }
  }
  for (const [x, y] of supersedes) {
    if (supersededBy.get(y) !== x) errors.push(`${x} supersedes ${y}, but ${y} does not say superseded_by ${x}`);
  }
  for (const [y, x] of supersededBy) {
    if (supersedes.get(x) !== y) errors.push(`${y} is superseded_by ${x}, but ${x} does not say supersedes ${y}`);
  }

  // Rule 7: active plan.
  if (!planIds.has(manifest.work.active_plan)) errors.push(`work.active_plan ${manifest.work.active_plan} does not resolve to plans[].id`);

  // Rule 8: ceilings.
  const active = cards.filter(isActive);
  const p1 = active.filter((c) => c.priority === 1);
  const inProgress = active.filter((c) => c.status === "in_progress");
  const owner = active.filter((c) => actorOf(c) === "owner");
  const ceilingHint = "Defer a card with a dated reason (status deferred) to bring the count down.";
  if (active.length > CEILINGS.total) errors.push(`${active.length} active cards; ceiling is ${CEILINGS.total}. ${ceilingHint}`);
  if (p1.length > CEILINGS.p1) errors.push(`${p1.length} active priority-1 cards; ceiling is ${CEILINGS.p1}. ${ceilingHint}`);
  if (inProgress.length > CEILINGS.inProgress) errors.push(`${inProgress.length} cards in_progress; ceiling is ${CEILINGS.inProgress}. ${ceilingHint}`);
  // active_plan drift is an owner signal, not a build breaker: in_progress cards
  // may sit on other plans or on no plan, but the active plan should be moving.
  for (const c of inProgress) {
    if (c.plan && c.plan !== manifest.work.active_plan) {
      warnings.push(`card ${c.id}: in_progress on plan ${c.plan} while work.active_plan is ${manifest.work.active_plan}`);
    }
  }
  if (!active.some((c) => c.plan === manifest.work.active_plan)) {
    warnings.push(`work.active_plan ${manifest.work.active_plan} has no active card; point it at the plan being worked or add a card`);
  }
  if (owner.length > CEILINGS.owner) errors.push(`${owner.length} active owner cards; ceiling is ${CEILINGS.owner}. ${ceilingHint}`);

  // Filesystem and generated-view rules run only against the live tree.
  if (!fixtureMode) {
    // Rule 4: bidirectional registry.
    const registeredFiles = new Set(registry.map(({ entry }) => entry.file).filter(Boolean));
    for (const dir of REGISTERED_DIRS) {
      for (const name of walkMarkdown(join(root, dir))) {
        const relative = `${dir}/${name}`;
        if (registeredFiles.has(relative)) continue;
        errors.push(name.includes("/")
          ? `${relative}: nested files are not allowed under ${dir}; move it to the folder root and register it`
          : `${relative} is not registered in the manifest`);
      }
    }

    // Rule 4 (ADRs): numbers are never reused.
    for (const number of duplicateAdrNumbers(join(root, "docs", "adr"))) {
      errors.push(`docs/adr: number ${number} is used by more than one file; never reuse an ADR number`);
    }

    // Rule 4 (ADRs) and rule 2 (ADR tags).
    for (const adr of readAdrs(root)) {
      const label = `ADR-${adr.number}`;
      const expected = ADR_SECTIONS.join(" > ");
      if (adr.headings.join(" > ") !== expected) {
        errors.push(`${label}: sections must be exactly [${expected}] in order; found [${adr.headings.join(" > ")}]`);
      }
      if (adr.tags.length === 0) errors.push(`${label}: ## Tags is empty`);
      checkTags(label, adr.tags);
      if (!/^(Proposed|Accepted|Superseded by \d{4})$/.test(adr.status)) errors.push(`${label}: status "${adr.statusLine}" does not start with Proposed, Accepted, or Superseded by NNNN`);
    }

    // Rule 9: decision ids.
    const log = existsSync(decisionLogPath) ? readFileSync(decisionLogPath, "utf8") : "";
    const logIds = new Set([...log.matchAll(/^##+ (D-\d{3})\b/gm)].map((m) => m[1]));
    for (const ref of decisionRefs) {
      if (!logIds.has(ref)) errors.push(`decision ${ref} is cited in a card scope but has no heading in docs/ops/decision-log.md`);
    }

    // Soft: unused threads (needs ADR tags too).
    const used = new Set([
      ...cards.flatMap((c) => c.tags),
      ...registry.flatMap(({ entry }) => entry.tags),
      ...readAdrs(root).flatMap((a) => a.tags),
    ]);
    for (const t of threads) if (!used.has(t.id)) warnings.push(`thread ${t.id} is used by no card, document, or ADR`);

    // Rule 10: generated views fresh.
    runCheck("kanban.mjs", errors, "kanban check");
    runCheck("threads.mjs", errors, "threads check");
  }

  report(errors, warnings);
}

/** @param {string[]} errors @param {string[]} warnings */
function report(errors, warnings) {
  for (const error of errors) console.error(`ERROR ${error}`);
  for (const warning of warnings) console.warn(`WARN ${warning}`);
  if (errors.length > 0) process.exitCode = 1;
}

main();
