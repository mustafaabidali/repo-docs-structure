// The settings probes can fail. In a copy of this checkout, each check is
// rewired to ignore the settings (a hard-coded list or branch, the template's
// defaults), and the command-line probes in scripts/settings.test.mjs must then
// fail, at the probe for that value.
//
// It tests the template's own suite, so it lives in template-tests/, which the
// Install steps never copy.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { copyCheckout } from "../scripts/lib/copy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temps = [];
after(() => { for (const base of temps) rmSync(base, { recursive: true, force: true }); });

/** @param {Record<string, string>} [extra] */
function localEnv(extra = {}) {
  const kept = Object.entries(process.env).filter(([key]) => !key.startsWith("GITHUB_") && key !== "NODE_TEST_CONTEXT");
  return { ...Object.fromEntries(kept), ...extra };
}

const REWIRINGS = [
  {
    name: "ALLOWED_MARKDOWN",
    file: "scripts/check-docs-location.mjs",
    from: 'import { ALLOWED_MARKDOWN } from "./lib/settings.mjs";',
    to: 'const ALLOWED_MARKDOWN = ["docs/**", "specs/design/**", "specs/plans/**", "specs/reviews/**", "specs/threads/**", "specs/KANBAN.md", "**/README.md", "AGENTS.md", "CLAUDE.md", ".agents/**", ".github/**"];',
    fails: /markdown-(pass|fail)/,
  },
  {
    name: "RULE_FILES",
    file: "scripts/check-rule-files-alone.mjs",
    from: 'import { ALLOWED_EXTRAS, RULE_FILES } from "./lib/settings.mjs";',
    to: 'import { ALLOWED_EXTRAS } from "./lib/settings.mjs";\nconst RULE_FILES = ["AGENTS.md", "CLAUDE.md"];',
    fails: /rules-(pass|fail)/,
  },
  {
    name: "ALLOWED_EXTRAS",
    file: "scripts/check-rule-files-alone.mjs",
    from: 'import { ALLOWED_EXTRAS, RULE_FILES } from "./lib/settings.mjs";',
    to: 'import { RULE_FILES } from "./lib/settings.mjs";\nconst ALLOWED_EXTRAS = ["docs/adr/**", "docs/ops/decision-log.md", "specs/manifest.json", "specs/KANBAN.md", "specs/threads/**"];',
    fails: /extras-(pass|fail)/,
  },
  {
    name: "DEFAULT_BRANCH",
    file: "scripts/changed-files.mjs",
    from: 'import { DEFAULT_BRANCH } from "./lib/settings.mjs";',
    to: 'const DEFAULT_BRANCH = "main";',
    fails: /origin\/main is missing/,
  },
];

for (const rewiring of REWIRINGS) {
  test(`probes: a check that ignores ${rewiring.name} turns the command-line probes red`, () => {
    const base = mkdtempSync(join(tmpdir(), "probes-mutation-"));
    temps.push(base);
    const repo = join(base, "repo");
    copyCheckout(root, repo);
    symlinkSync(join(root, "node_modules"), join(repo, "node_modules"), "dir");
    const path = join(repo, rewiring.file);
    const text = readFileSync(path, "utf8");
    assert.ok(text.includes(rewiring.from), `${rewiring.file} reads ${rewiring.name} from the settings`);
    writeFileSync(path, text.replace(rewiring.from, rewiring.to));
    const r = spawnSync(process.execPath, ["--test", "--test-name-pattern=command lines", "scripts/settings.test.mjs"], { cwd: repo, encoding: "utf8", env: localEnv({ TMPDIR: base }) });
    const out = `${r.stdout}${r.stderr}`;
    assert.notEqual(r.status, 0, out.slice(-3000));
    assert.match(out, /^# fail 1$/m);
    assert.match(out, rewiring.fails);
  });
}
