#!/usr/bin/env node
/**
 * Keeps agent-rule changes isolated from code and unrelated repository changes.
 * ADR registration, the decision log, and generated manifest views may travel with them.
 *
 * RULE_FILES lists the files agents read as rules, as globs from the root. Add
 * any other rules file your agents load (a tool's own rules folder, a nested
 * AGENTS.md) so its changes travel alone too.
 */

import process from "node:process";

import { changedFilesOrFail } from "./changed-files.mjs";
import { isMain, ruleFileViolations } from "./lib/paths.mjs";

export const RULE_FILES = ["AGENTS.md", "CLAUDE.md"];
export const ALLOWED_EXTRAS = [
  "docs/adr/**",
  "docs/ops/decision-log.md",
  "specs/manifest.json",
  "specs/KANBAN.md",
  "specs/threads/**",
];

if (isMain(import.meta.url)) {
  const files = changedFilesOrFail("check-rule-files-alone");
  const invalid = files === null ? [] : ruleFileViolations(files, RULE_FILES, ALLOWED_EXTRAS);
  if (invalid.length > 0) {
    console.error("Rule-file changes include unrelated paths:");
    for (const { path } of invalid) console.error(`- ${path}`);
    process.exitCode = 1;
  }
}
