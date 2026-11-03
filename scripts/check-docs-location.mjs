#!/usr/bin/env node
/**
 * Rejects new Markdown files outside the repository's approved document homes.
 * Only added files (status A) are judged; existing files stay where they are.
 *
 * ALLOWED_MARKDOWN is the default list. Add your own folders that hold
 * Markdown by design (an app's docs, vendored skills) as globs: `**` crosses
 * folders, `*` stays inside one. A note anywhere else goes to docs/ops/.
 */

import process from "node:process";

import { changedFilesOrFail } from "./changed-files.mjs";
import { disallowedMarkdown, isMain } from "./lib/paths.mjs";

export const ALLOWED_MARKDOWN = [
  "docs/**",
  "specs/design/**",
  "specs/plans/**",
  "specs/reviews/**",
  "specs/threads/**",
  "specs/KANBAN.md",
  "**/README.md",
  "AGENTS.md",
  "CLAUDE.md",
  ".agents/**",
  ".github/**",
];

if (isMain(import.meta.url)) {
  const files = changedFilesOrFail("check-docs-location");
  const invalid = files === null ? [] : disallowedMarkdown(files, ALLOWED_MARKDOWN);
  if (invalid.length > 0) {
    console.error("New files use a disallowed documentation location:");
    for (const { path } of invalid) console.error(`- ${path}`);
    process.exitCode = 1;
  }
}
