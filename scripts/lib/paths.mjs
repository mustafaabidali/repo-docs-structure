// Path matching shared by the two changed-file checks.
//
// check-docs-location.mjs and check-rule-files-alone.mjs each hold their own
// path lists; the glob and the classification live here once, so both checks
// and their tests use the same code.

import { realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REGEXP_SPECIAL = new Set(["\\", "^", "$", ".", "+", "?", "(", ")", "[", "]", "{", "}", "|"]);

/**
 * Compile a path glob to an anchored RegExp. `**` crosses folders, `**\/`
 * also matches zero folders, `*` stays inside one folder.
 * @param {string} pattern
 */
export function glob(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; ) {
    if (pattern.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 3;
    } else if (pattern.startsWith("**", index)) {
      source += ".*";
      index += 2;
    } else if (pattern[index] === "*") {
      source += "[^/]*";
      index += 1;
    } else {
      const character = pattern[index];
      source += REGEXP_SPECIAL.has(character) ? `\\${character}` : character;
      index += 1;
    }
  }
  return new RegExp(`${source}$`);
}

/** @param {string} path @param {RegExp[]} patterns */
export function matchesAny(path, patterns) {
  return patterns.some((pattern) => pattern.test(path));
}

/**
 * New Markdown files (status A) outside the allowed globs. Modified, deleted
 * and non-Markdown files are never judged.
 * @param {{ status: string, path: string }[]} files
 * @param {string[]} allowed globs
 */
export function disallowedMarkdown(files, allowed) {
  const patterns = allowed.map(glob);
  return files.filter(({ status, path }) => status === "A" && path.endsWith(".md") && !matchesAny(path, patterns));
}

/**
 * When a rule file is in the change set, every file that is neither a rule
 * file nor an allowed extra. A change set without a rule file is not checked.
 * @param {{ status: string, path: string }[]} files
 * @param {string[]} ruleFiles globs
 * @param {string[]} extras globs
 */
export function ruleFileViolations(files, ruleFiles, extras) {
  const rules = ruleFiles.map(glob);
  if (!files.some(({ path }) => matchesAny(path, rules))) return [];
  const allowed = [...rules, ...extras.map(glob)];
  return files.filter(({ path }) => !matchesAny(path, allowed));
}

/**
 * True when the module at `moduleUrl` is the script node was started with.
 * Both sides are compared by real path, so a checkout reached through a link
 * (macOS's /var and /tmp, a linked home folder) still runs its checks.
 * @param {string} moduleUrl import.meta.url of the caller
 */
export function isMain(moduleUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
