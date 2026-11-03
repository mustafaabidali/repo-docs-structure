#!/usr/bin/env node
/**
 * Keeps agent-rule changes isolated from code and unrelated repository changes.
 * ADR registration, the decision log, and generated manifest views may travel with them.
 *
 * The rule files and the extras are RULE_FILES and ALLOWED_EXTRAS in
 * scripts/lib/settings.mjs.
 */

import process from "node:process";

import { changedFilesOrFail } from "./changed-files.mjs";
import { isMain, ruleFileViolations } from "./lib/paths.mjs";
import { ALLOWED_EXTRAS, RULE_FILES } from "./lib/settings.mjs";

if (isMain(import.meta.url)) {
  const files = changedFilesOrFail("check-rule-files-alone");
  const invalid = files === null ? [] : ruleFileViolations(files, RULE_FILES, ALLOWED_EXTRAS);
  if (invalid.length > 0) {
    console.error("Rule-file changes include unrelated paths:");
    for (const { path } of invalid) console.error(`- ${path}`);
    process.exitCode = 1;
  }
}
