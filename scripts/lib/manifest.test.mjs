// Unit tests for scripts/lib/manifest.mjs.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { GENERATED_END, GENERATED_START, compareActiveCards, duplicateAdrNumbers, parseAdr, spliceGenerated, walkMarkdown } from "./manifest.mjs";

const dir = mkdtempSync(join(tmpdir(), "manifest-lib-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** @param {string} name @param {string} tagsBody */
function writeAdr(name, tagsBody) {
  const path = join(dir, name);
  writeFileSync(
    path,
    `# ADR-0042: Fixture\n\n## Status\n\nAccepted\n\n## Tags\n\n${tagsBody}\n\n## Date\n\n2026-09-16\n\n## Context\n\nx\n\n## Decision\n\nx\n\n## Consequences\n\nx\n\n## Alternatives Considered\n\nx\n\n## References\n\nx\n`,
  );
  return path;
}

test("parseAdr joins multi-line Tags", () => {
  const adr = parseAdr(writeAdr("0042-multi.md", "login,\n  security"));
  assert.deepEqual(adr.tags, ["login", "security"]);
});

test("parseAdr still reads single-line Tags", () => {
  const adr = parseAdr(writeAdr("0042-single.md", "login, security"));
  assert.deepEqual(adr.tags, ["login", "security"]);
  assert.equal(adr.status, "Accepted");
  assert.equal(adr.number, "0042");
});

test("spliceGenerated treats a marker mention in prose as text", () => {
  const prose = `# T\n\n## Current state\n\nSee \`${GENERATED_START}\` for the boundary.\n\nAUTHORED NOTE KEEP ME\n\n`;
  const existing = `${prose}${GENERATED_START}\nold\n${GENERATED_END}\n`;
  const result = spliceGenerated(existing, "new", "");
  assert.ok(result.includes("AUTHORED NOTE KEEP ME"), result);
  assert.ok(result.includes(`See \`${GENERATED_START}\` for the boundary.`), result);
  assert.equal(result, `${prose}${GENERATED_START}\nnew\n${GENERATED_END}\n`);
});

test("spliceGenerated is idempotent", () => {
  const once = spliceGenerated("# T\n\nhand\n", "body", "");
  const twice = spliceGenerated(once, "body", "");
  assert.equal(once, twice);
});

test("spliceGenerated appends a block when none exists", () => {
  const result = spliceGenerated("# T\n\nhand\n", "body", "");
  assert.equal(result, `# T\n\nhand\n\n${GENERATED_START}\nbody\n${GENERATED_END}\n`);
});

test("spliceGenerated uses the header for an empty file", () => {
  const result = spliceGenerated("", "body", "# New\n\n## Current state\n");
  assert.equal(result, `# New\n\n## Current state\n\n${GENERATED_START}\nbody\n${GENERATED_END}\n`);
});

test("spliceGenerated preserves text after the end marker", () => {
  const existing = `# T\n\n${GENERATED_START}\nold\n${GENERATED_END}\n\n## Footer\n\nkeep\n`;
  const result = spliceGenerated(existing, "new", "");
  assert.equal(result, `# T\n\n${GENERATED_START}\nnew\n${GENERATED_END}\n\n## Footer\n\nkeep\n`);
});

test("duplicateAdrNumbers reports a reused number once", () => {
  const adrDir = mkdtempSync(join(dir, "manifest-adr-"));
  for (const name of ["0001-a.md", "0001-b.md", "0002-c.md"]) {
    writeFileSync(join(adrDir, name), "# ADR\n\n## Status\n\nAccepted\n\n## Tags\n\nx\n");
  }
  assert.deepEqual(duplicateAdrNumbers(adrDir), ["0001"]);
});

test("walkMarkdown finds nested files", () => {
  const base = mkdtempSync(join(dir, "manifest-walk-"));
  writeFileSync(join(base, "top.md"), "x");
  const nested = join(base, "nested");
  mkdirSync(nested);
  writeFileSync(join(nested, "deep.md"), "x");
  writeFileSync(join(nested, "not-markdown.txt"), "x");
  assert.deepEqual(walkMarkdown(base).sort(), ["nested/deep.md", "top.md"]);
});

test("compareActiveCards orders by status then priority then created", () => {
  const cards = [
    { id: "a", status: "pending", priority: 1, created: "2026-01-01" },
    { id: "b", status: "in_progress", priority: 2, created: "2026-01-01" },
    { id: "c", status: "paused", priority: 2, created: "2026-01-01" },
    { id: "d", status: "pending", priority: 2, created: "2026-01-02" },
    { id: "e", status: "pending", priority: 2, created: "2026-01-01" },
    { id: "f", status: "blocked", priority: 3, created: "2026-01-01" },
  ];
  const ordered = [...cards].sort(compareActiveCards).map((c) => c.id);
  assert.deepEqual(ordered, ["b", "f", "c", "a", "e", "d"]);
});

test("spliceGenerated ignores a marker inside a fenced code block", () => {
  const prose = `# T\n\n## Current state\n\nExample of the boundary:\n\n~~~html\n${GENERATED_START}\n~~~\n\nAUTHORED NOTE KEEP ME\n\n`;
  const existing = `${prose}${GENERATED_START}\nold\n${GENERATED_END}\n`;
  const result = spliceGenerated(existing, "new", "");
  assert.equal(result, `${prose}${GENERATED_START}\nnew\n${GENERATED_END}\n`);
});

test("spliceGenerated ignores a marker inside a backtick fence too", () => {
  const prose = "# T\n\n```md\n" + GENERATED_START + "\n" + GENERATED_END + "\n```\n\nAUTHORED NOTE KEEP ME\n\n";
  const existing = `${prose}${GENERATED_START}\nold\n${GENERATED_END}\n`;
  const result = spliceGenerated(existing, "new", "");
  assert.equal(result, `${prose}${GENERATED_START}\nnew\n${GENERATED_END}\n`);
});

test("spliceGenerated ignores a marker inside an indented fence", () => {
  const prose = `# T\n\n  ~~~html\n${GENERATED_START}\n  ~~~\n\nAUTHORED NOTE KEEP ME\n\n`;
  const existing = `${prose}${GENERATED_START}\nold\n${GENERATED_END}\n`;
  assert.equal(spliceGenerated(existing, "new", ""), `${prose}${GENERATED_START}\nnew\n${GENERATED_END}\n`);
});

test("spliceGenerated does not close a fence on a shorter run", () => {
  const prose = `# T\n\n~~~~md\n~~~\n${GENERATED_START}\n~~~~\n\nAUTHORED NOTE KEEP ME\n\n`;
  const existing = `${prose}${GENERATED_START}\nold\n${GENERATED_END}\n`;
  assert.equal(spliceGenerated(existing, "new", ""), `${prose}${GENERATED_START}\nnew\n${GENERATED_END}\n`);
});

test("spliceGenerated does not close a fence on a line with trailing text", () => {
  const prose = `# T\n\n~~~md\n~~~still-code\n${GENERATED_START}\n~~~\n\nAUTHORED NOTE KEEP ME\n\n`;
  const existing = `${prose}${GENERATED_START}\nold\n${GENERATED_END}\n`;
  assert.equal(spliceGenerated(existing, "new", ""), `${prose}${GENERATED_START}\nnew\n${GENERATED_END}\n`);
});

test("walkMarkdown returns an empty list for a folder that does not exist", () => {
  const base = mkdtempSync(join(dir, "manifest-walk-missing-"));
  assert.deepEqual(walkMarkdown(join(base, "design")), []);
});

test("spliceGenerated refuses a start marker with no end marker, keeping the footer", () => {
  const existing = `# T\n\n${GENERATED_START}\nold\n\n## Footer\n\nkeep\n`;
  assert.throws(() => spliceGenerated(existing, "new", ""), /generated:start marker with no generated:end marker/);
});

test("spliceGenerated refuses two start markers", () => {
  const existing = `# T\n\n${GENERATED_START}\na\n${GENERATED_END}\n\n${GENERATED_START}\nb\n${GENERATED_END}\n`;
  assert.throws(() => spliceGenerated(existing, "new", ""), /more than one generated:start marker/);
});

test("spliceGenerated refuses an end marker with no start marker", () => {
  const existing = `# T\n\nhand\n${GENERATED_END}\n`;
  assert.throws(() => spliceGenerated(existing, "new", ""), /generated:end marker with no generated:start marker before it/);
});

test("spliceGenerated still ignores markers inside a fence when counting", () => {
  const prose = `# T\n\n~~~md\n${GENERATED_START}\n${GENERATED_START}\n~~~\n\n`;
  const existing = `${prose}${GENERATED_START}\nold\n${GENERATED_END}\n`;
  assert.equal(spliceGenerated(existing, "new", ""), `${prose}${GENERATED_START}\nnew\n${GENERATED_END}\n`);
});
