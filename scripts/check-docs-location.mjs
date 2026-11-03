#!/usr/bin/env node
/**
 * Rejects new Markdown files outside the repository's approved document homes.
 * Only added files (status A) are judged; existing files stay where they are.
 *
 * The allowed globs are ALLOWED_MARKDOWN in scripts/lib/settings.mjs. A note
 * anywhere else goes to docs/ops/.
 */

import process from "node:process";

import { changedFilesOrFail } from "./changed-files.mjs";
import { disallowedMarkdown, isMain } from "./lib/paths.mjs";
import { ALLOWED_MARKDOWN } from "./lib/settings.mjs";

if (isMain(import.meta.url)) {
  const files = changedFilesOrFail("check-docs-location");
  const invalid = files === null ? [] : disallowedMarkdown(files, ALLOWED_MARKDOWN);
  if (invalid.length > 0) {
    console.error("New files use a disallowed documentation location:");
    for (const { path } of invalid) console.error(`- ${path}`);
    process.exitCode = 1;
  }
}
