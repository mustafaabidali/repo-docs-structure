#!/usr/bin/env node
/**
 * Lists files changed from the event's base commit.
 *
 * Imported callers receive `{ status, path }` records, paths verbatim (read
 * with -z, so git never quotes them). Direct execution prints the same records
 * as `<status>\t<path>` lines for people reading a terminal.
 *
 * A base the clone cannot find is an error, never an empty change set: after a
 * force-push or a shallow fetch the checks fail and say why, instead of
 * passing without looking.
 *
 * A pull request is judged against its base branch and an ordinary push from
 * the commit before the push. A local run, and a push that creates a branch,
 * are judged from their merge base with DEFAULT_BRANCH (scripts/lib/settings.mjs).
 */

import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { isMain } from "./lib/paths.mjs";
import { DEFAULT_BRANCH } from "./lib/settings.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ZERO_SHA = /^0+$/;

/** @param {string[]} args @param {string} cwd */
function runGit(args, cwd = root) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr.trim();
    throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }

  return result.stdout;
}

/**
 * The two git questions diffRange asks, against the checkout at `cwd`.
 * @param {string} cwd
 */
export function gitAt(cwd) {
  return {
    /** @param {string} ref */
    hasCommit(ref) {
      const result = spawnSync("git", ["cat-file", "-e", `${ref}^{commit}`], { cwd, encoding: "utf8" });
      if (result.error) throw result.error;
      return result.status === 0;
    },
    /** One fetch attempt; a failure is left for the caller's second look to report. @param {string} refspec */
    fetch(refspec) {
      const result = spawnSync("git", ["fetch", "--no-tags", "--quiet", "origin", refspec], { cwd, encoding: "utf8" });
      if (result.error) throw result.error;
    },
  };
}

/**
 * Make sure `ref` is present, fetching `refspec` once if it is not.
 * @param {ReturnType<typeof gitAt>} git @param {string} ref @param {string} refspec @param {string} missing
 */
function ensure(git, ref, refspec, missing) {
  if (git.hasCommit(ref)) return;
  git.fetch(refspec);
  if (!git.hasCommit(ref)) throw new Error(`${missing}; cannot tell what changed`);
}

/** @param {ReturnType<typeof gitAt>} git @param {string} branch */
function againstBranch(git, branch) {
  ensure(git, `origin/${branch}`, `+refs/heads/${branch}:refs/remotes/origin/${branch}`, `origin/${branch} is missing even after git fetch`);
  return `origin/${branch}...HEAD`;
}

/**
 * The commit range to diff for this event. Throws when the base is unknown.
 * @param {Record<string, string | undefined>} env
 * @param {ReturnType<typeof gitAt>} git
 * @returns {string}
 */
export function diffRange(env = process.env, git = gitAt(root)) {
  if (env.GITHUB_EVENT_NAME === "pull_request") {
    const baseRef = env.GITHUB_BASE_REF;
    if (!baseRef) throw new Error("pull_request event without GITHUB_BASE_REF; cannot tell what changed");
    return againstBranch(git, baseRef);
  }

  if (env.GITHUB_EVENT_NAME === "push") {
    const before = env.GITHUB_EVENT_BEFORE;
    if (!before) throw new Error("push event without GITHUB_EVENT_BEFORE; cannot tell what changed");
    // An all-zero before is a branch being created: judge it from its merge base with the default branch.
    if (ZERO_SHA.test(before)) return againstBranch(git, DEFAULT_BRANCH);
    ensure(git, before, before, `push base ${before} is not in this clone even after git fetch (a force-push?)`);
    return `${before}..HEAD`;
  }

  return againstBranch(git, DEFAULT_BRANCH);
}

/**
 * Parse `git diff --name-status -z --no-renames`: NUL-separated status and
 * path fields, each path verbatim (no quoting, any byte but NUL allowed).
 * @param {string} output
 * @returns {{ status: string, path: string }[]}
 */
export function parseNameStatusZ(output) {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2 !== 0) throw new Error(`unexpected git diff output: ${JSON.stringify(output)}`);
  /** @type {{ status: string, path: string }[]} */
  const files = [];
  for (let index = 0; index < fields.length; index += 2) files.push({ status: fields[index], path: fields[index + 1] });
  return files;
}

/** @returns {{ status: string, path: string }[]} */
export function changedFiles() {
  return parseNameStatusZ(runGit(["diff", "--name-status", "-z", "--no-renames", diffRange()]));
}

/**
 * changedFiles for a check's command line: on an unknown base, print why and
 * set a failing exit code, returning null so the check judges nothing.
 * @param {string} label the check's name
 * @returns {{ status: string, path: string }[] | null}
 */
export function changedFilesOrFail(label) {
  try {
    return changedFiles();
  } catch (error) {
    console.error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return null;
  }
}

if (isMain(import.meta.url)) {
  const files = changedFilesOrFail("changed-files");
  for (const file of files ?? []) console.log(`${file.status}\t${file.path}`);
}
