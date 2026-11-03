// Unit tests for scripts/lib/copy.mjs.

import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { copyCheckout, insideCopy } from "./copy.mjs";

const base = mkdtempSync(join(tmpdir(), "copy-lib-"));
after(() => rmSync(base, { recursive: true, force: true }));

/** A source with a file, a link inside it, a link outside it, a broken link, and .git and node_modules. */
function source(name) {
  const src = join(base, name, "src");
  const outside = join(base, name, "outside");
  mkdirSync(join(src, "decisions"), { recursive: true });
  mkdirSync(join(src, "docs"), { recursive: true });
  mkdirSync(join(src, ".git"));
  mkdirSync(join(src, "node_modules"));
  mkdirSync(outside);
  writeFileSync(join(src, "decisions", "0001-a.md"), "inside\n");
  writeFileSync(join(outside, "x.md"), "outside\n");
  symlinkSync("../decisions", join(src, "docs", "adr"));
  symlinkSync(outside, join(src, "docs", "beyond"));
  symlinkSync(join(src, "missing"), join(src, "docs", "broken"));
  return { src, outside };
}

test("copyCheckout: a link inside the source becomes a relative link inside the copy", () => {
  const { src } = source("inside");
  const dest = join(base, "inside", "dest");
  copyCheckout(src, dest);
  assert.ok(lstatSync(join(dest, "docs", "adr")).isSymbolicLink());
  assert.equal(readlinkSync(join(dest, "docs", "adr")), "../decisions");
  assert.equal(realpathSync(join(dest, "docs", "adr")), realpathSync(join(dest, "decisions")));
  assert.equal(readFileSync(join(dest, "docs", "adr", "0001-a.md"), "utf8"), "inside\n");
});

test("copyCheckout: a link outside the source, a broken link, .git and node_modules are left out", () => {
  const { src } = source("outside");
  const dest = join(base, "outside", "dest");
  copyCheckout(src, dest);
  assert.ok(!existsSync(join(dest, "docs", "beyond")));
  assert.throws(() => lstatSync(join(dest, "docs", "broken")));
  assert.ok(!existsSync(join(dest, ".git")));
  assert.ok(!existsSync(join(dest, "node_modules")));
});

test("insideCopy: a path inside the copy, existing or not, is returned; one through a link out of it is refused", () => {
  const { src, outside } = source("guard");
  symlinkSync(outside, join(src, "out"));
  assert.equal(insideCopy(src, join(src, "decisions", "0001-a.md")), join(src, "decisions", "0001-a.md"));
  assert.equal(insideCopy(src, join(src, "new", "file.md")), join(src, "new", "file.md"));
  assert.equal(insideCopy(src, join(src, "docs", "adr", "0001-a.md")), join(src, "docs", "adr", "0001-a.md"));
  assert.throws(() => insideCopy(src, join(src, "out", "x.md")), /resolves outside the copy/);
  assert.throws(() => insideCopy(src, join(src, "..", "outside", "x.md")), /resolves outside the copy/);
});
