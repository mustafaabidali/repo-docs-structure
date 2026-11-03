#!/usr/bin/env node
/**
 * Renders specs/KANBAN.md from specs/manifest.json.
 *
 * manifest.json stays the single source of truth; the board is a derived
 * view and must never be hand-edited. Re-run after any manifest change:
 *
 *   npm run kanban
 *
 * Column mapping (deterministic, driven by work.next[] + metadata.plans[]):
 *   Owner Gate    active cards and plans with actor "owner"
 *   In Progress   cards with status "in_progress"
 *   Next Up (P1)  priority-1 cards with status pending/open
 *   Backlog (P2)  priority-2 cards with status pending/open
 *   Later (P3+)   priority>=3 cards with status pending/open
 *   Paused        cards with status "paused" or "blocked"
 *   Deferred      cards with status "deferred", one line each
 *   Done          plans with status "completed"
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { actorOf, containedPath, isActive, manifestPath, readManifest } from "./lib/manifest.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = "specs/KANBAN.md";

/** @param {string} text @param {number} max */
function clip(text, max) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function renderKanban(manifest) {
  const cards = manifest.work.next;
  const plans = manifest.metadata.plans;
  const plansById = new Map(plans.map((p) => [p.id, p]));

  /** @param {Record<string, unknown>} item */
  function card(item) {
    const badge = item.plan
      ? `plan: \`${item.plan}\``
      : item.spec
        ? `spec: \`${item.spec}\``
        : `tags: ${item.tags.map((t) => `\`${t}\``).join(" ")}`;
    const branch = item.branch ? ` [\`${item.branch}\`]` : "";
    const owner = actorOf(item) === "owner" ? " (owner)" : "";
    const lines = [
      `- **P${item.priority} ${item.title}**${owner}${branch} (${badge}, status: ${item.status}, created: ${item.created})`,
      `  ${clip(item.scope, 220)}`,
    ];
    if (item.acceptance) lines.push(`  Done when: ${item.acceptance}`);
    return lines.join("\n");
  }

  /** @param {Record<string, unknown>} item */
  function deferredLine(item) {
    return `- \`${item.id}\` ${item.title} (deferred ${item.deferred.date}): ${item.deferred.reason}`;
  }

  /** @param {Record<string, unknown>} plan */
  function planLine(plan) {
    return `- **${plan.title}** (plan: \`${plan.id}\`, status: ${plan.status})`;
  }

  const isOpenish = (c) => c.status === "pending" || c.status === "open";
  const notOwner = (c) => actorOf(c) !== "owner";

  const ownerGate = cards.filter((c) => isActive(c) && actorOf(c) === "owner");
  const inProgress = cards.filter((c) => notOwner(c) && c.status === "in_progress");
  const nextUp = cards.filter((c) => notOwner(c) && c.priority === 1 && isOpenish(c));
  const backlog = cards.filter((c) => notOwner(c) && c.priority === 2 && isOpenish(c));
  const later = cards.filter((c) => notOwner(c) && c.priority >= 3 && isOpenish(c));
  const paused = cards.filter((c) => notOwner(c) && (c.status === "paused" || c.status === "blocked"));
  const deferred = cards.filter((c) => c.status === "deferred");

  const ownerPlans = plans.filter((p) => p.actor === "owner" && p.status !== "completed");
  const donePlans = plans.filter((p) => p.status === "completed");

  const claimed = new Set([...ownerGate, ...inProgress, ...nextUp, ...backlog, ...later, ...paused, ...deferred]);
  const unclassified = cards.filter((c) => !claimed.has(c));

  const columns = [
    ["🚧 Owner Gate", [...ownerGate.map(card), ...ownerPlans.map(planLine)]],
    ["🏃 In Progress", inProgress.map(card)],
    ["🔥 Next Up (P1)", nextUp.map(card)],
    ["📋 Backlog (P2)", backlog.map(card)],
    ["🗓 Later (P3+)", later.map(card)],
    ["⏸ Paused", paused.map(card)],
    ["🧊 Deferred", deferred.map(deferredLine)],
    ["✅ Done", donePlans.map((p) => `- **${p.title}** (\`${p.id}\`)`)],
  ];

  if (unclassified.length > 0) {
    columns.push(["❓ Unclassified (fix manifest or mapping)", unclassified.map(card)]);
  }

  const activePlan = plansById.get(manifest.work.active_plan);
  const active = cards.filter(isActive);
  const counts = `${active.length} active (${active.filter((c) => c.priority === 1).length} P1, ${ownerGate.length} owner), ${deferred.length} deferred.`;

  return `<!-- GENERATED FILE - DO NOT EDIT. Run \`npm run kanban\` after changing specs/manifest.json. -->

# ${manifest.name} Kanban

Derived from [\`specs/manifest.json\`](./manifest.json) (last_updated: ${manifest.last_updated}).
Active plan: ${activePlan ? `\`${activePlan.id}\` ${activePlan.title}` : "_none_"}. ${counts}
Threads: ${manifest.metadata.threads.map((t) => `[\`${t.id}\`](./threads/${t.id}.md)`).join(" ")}

${columns
  .filter(([, entries]) => entries.length > 0)
  .map(([title, entries]) => `## ${title}\n\n${entries.join("\n")}`)
  .join("\n\n")}
`;
}

function main() {
  let outPath;
  try {
    outPath = containedPath(root, OUT_FILE, "specs");
  } catch (error) {
    console.error(`ERROR ${error instanceof Error ? error.message : String(error)}`);
    console.error("kanban: nothing written");
    process.exitCode = 1;
    return;
  }

  let manifest;
  try {
    manifest = readManifest(manifestPath(root));
  } catch (error) {
    console.error(`ERROR ${error instanceof Error ? error.message : String(error)}`);
    console.error("kanban: nothing written");
    process.exitCode = 1;
    return;
  }
  const out = renderKanban(manifest);

  if (process.argv.includes("--check")) {
    const current = existsSync(outPath) ? readFileSync(outPath, "utf8") : null;
    if (current !== out) {
      console.error("specs/KANBAN.md is stale; run `npm run kanban`");
      process.exitCode = 1;
    }
  } else {
    writeFileSync(outPath, out);
    console.log(`Wrote ${outPath}`);
  }
}

main();
