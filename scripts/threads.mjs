#!/usr/bin/env node
/**
 * Renders one specs/threads/<id>.md per metadata.threads[] entry, and the
 * index table in docs/adr/README.md.
 *
 * Each thread file has two parts. Everything above the generated:start marker
 * is hand-written (the current-state paragraph and an optional log) and is
 * preserved byte for byte. Everything between the markers is generated from
 * tags: active cards ordered in_progress, blocked, paused, pending, open (then
 * priority, then created), deferred cards, then plans, designs, reviews, and decisions.
 *
 *   npm run threads             rewrite every output
 *   npm run threads -- --check  exit 1 when any output is stale
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  actorOf,
  compareActiveCards,
  containedPath,
  isActive,
  manifestPath,
  readAdrs,
  readManifest,
  spliceGenerated,
  threadEntryProblems,
} from "./lib/manifest.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
/** Read in main, through the link guard, before anything renders. @type {any} */
let manifest;
/** @type {ReturnType<typeof readAdrs>} */
let adrs = [];

/** @param {string} text @param {number} max */
function clip(text, max) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

/** @param {Record<string, unknown>} card */
function cardLine(card) {
  const owner = actorOf(card) === "owner" ? " (owner)" : "";
  return `- P${card.priority} \`${card.id}\` ${card.title}${owner}, ${card.status}\n  ${clip(card.scope, 220)}`;
}

/** @param {Record<string, unknown>} card */
function deferredLine(card) {
  return `- \`${card.id}\` ${card.title} (deferred ${card.deferred.date}): ${card.deferred.reason}`;
}

/**
 * A registry entry in the live tree links to its file; an archived one links
 * to its URL in the archive repo.
 * @param {Record<string, unknown>} entry
 */
function docLine(entry) {
  if (entry.archived) return `- [${entry.title}](${entry.archived}) (\`${entry.id}\`, ${entry.status}, archived)`;
  return `- [${entry.title}](../../${entry.file}) (\`${entry.id}\`, ${entry.status})`;
}

/** @param {ReturnType<typeof readAdrs>[number]} adr */
function adrLine(adr) {
  return `- [ADR-${adr.number}](../../docs/adr/${adr.file.split("/").pop()}) ${adr.title} (${adr.status})`;
}

/** @param {string} title @param {string[]} lines */
function section(title, lines) {
  return lines.length > 0 ? `## ${title}\n\n${lines.join("\n")}\n` : "";
}

/** @param {Record<string, unknown>} thread */
function renderThread(thread) {
  const has = (item) => Array.isArray(item.tags) && item.tags.includes(thread.id);
  const cards = manifest.work.next.filter(has);
  const active = cards.filter(isActive).sort(compareActiveCards);
  const deferred = cards.filter((c) => c.status === "deferred");
  const plans = manifest.metadata.plans.filter(has);
  const specs = manifest.metadata.specs.filter(has);
  const reviews = manifest.metadata.reviews.filter(has);
  const decisions = adrs.filter(has);

  const body = [
    section("Active cards", active.map(cardLine)),
    section("Deferred cards", deferred.map(deferredLine)),
    section("Plans", plans.map(docLine)),
    section("Designs", specs.map(docLine)),
    section("Reviews", reviews.map(docLine)),
    section("Decisions", decisions.map(adrLine)),
  ]
    .filter(Boolean)
    .join("\n");

  const header = `# ${thread.title}\n\n## Current state\n\nWrite the current state of this thread here. This paragraph is hand-written and must stay complete.\n`;
  return { file: thread.file, dir: "specs/threads", body: body || "_Nothing tagged \`" + thread.id + "\` yet._\n", header };
}

function renderAdrIndex() {
  const rows = adrs.map((adr) => `| [ADR-${adr.number}](${adr.file.split("/").pop()}) | ${adr.title} | ${adr.status} | ${adr.tags.map((t) => `\`${t}\``).join(", ")} |`);
  const table = ["| ADR | Title | Status | Tags |", "|---|---|---|---|", ...rows].join("\n");
  return { file: "docs/adr/README.md", dir: "docs/adr", body: `${table}\n`, header: "# Architecture Decision Records\n" };
}

/**
 * Every output is resolved, read and rendered before anything is written, so
 * a refused output leaves every file as it was.
 */
function main() {
  try {
    manifest = readManifest(manifestPath(root));
    adrs = readAdrs(root);
  } catch (error) {
    return report([error instanceof Error ? error.message : String(error)]);
  }
  const errors = manifest.metadata.threads.flatMap(threadEntryProblems);
  if (errors.length > 0) return report(errors);

  /** @type {{ file: string, path: string, existing: string, next: string }[]} */
  const planned = [];
  for (const { file, dir, body, header } of [...manifest.metadata.threads.map(renderThread), renderAdrIndex()]) {
    try {
      const path = containedPath(root, file, dir);
      const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
      planned.push({ file, path, existing, next: spliceGenerated(existing, body, header) });
    } catch (error) {
      errors.push(error instanceof Error && error.message.startsWith(file) ? error.message : `${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (errors.length > 0) return report(errors);

  let stale = 0;
  for (const { file, path, existing, next } of planned) {
    if (existing === next) continue;
    if (check) {
      console.error(`${file} is stale; run \`npm run threads\``);
      stale += 1;
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, next);
      console.log(`Wrote ${file}`);
    }
  }

  if (check && stale > 0) process.exitCode = 1;
  if (!check) console.log(`${planned.length} outputs checked`);
}

/** @param {string[]} errors */
function report(errors) {
  for (const error of errors) console.error(`ERROR ${error}`);
  console.error("threads: nothing written");
  process.exitCode = 1;
}

main();
