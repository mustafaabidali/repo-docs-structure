// The CI workflow's concurrency group. Runs from different sources must never
// cancel each other: a push to the default branch, and pull requests from
// forks that share a branch name, each get a group of their own; two pushes
// to the same branch share one, so the newer cancels the older.
//
// The group is read from .github/workflows/ci.yml and evaluated here with the
// few expression forms it may use (context paths joined by ||); any other form
// fails the test rather than being guessed at. It tests the template's own
// workflow, so it lives in template-tests/, which the Install steps never copy.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = join(root, ".github", "workflows", "ci.yml");
assert.ok(existsSync(workflowPath), "the template has its workflow");

/** The concurrency block's group and cancel-in-progress lines. @param {string} text */
function concurrency(text) {
  const block = /^concurrency:\n((?:[ \t]+.*\n)+)/m.exec(text);
  assert.ok(block, "the workflow has a top-level concurrency block");
  const group = /^[ \t]+group:[ \t]*(.+?)[ \t]*$/m.exec(block[1]);
  const cancel = /^[ \t]+cancel-in-progress:[ \t]*(.+?)[ \t]*$/m.exec(block[1]);
  assert.ok(group, "the concurrency block names a group");
  return { group: group[1], cancel: cancel?.[1] };
}

/**
 * Evaluate a group template: literal text and ${{ a.b || c.d }} expressions.
 * @param {string} template @param {Record<string, any>} context
 */
function evaluate(template, context) {
  return template.replace(/\$\{\{(.*?)\}\}/g, (_, expression) => {
    for (const part of expression.split("||")) {
      const path = part.trim();
      if (!/^[a-z_]+(\.[a-z_]+)*$/.test(path)) throw new Error(`unsupported expression in the group: ${path}`);
      const value = path.split(".").reduce((object, key) => object?.[key], context);
      if (value !== undefined && value !== null && value !== "") return String(value);
    }
    return "";
  });
}

const base = { workflow: "CI", repository: "owner/repo" };
/**
 * Each run differs in every value a run has of its own (its id, number,
 * attempt and commit), so a group that keys on any of them gives two runs of
 * the same source two groups, and the cases below fail.
 * @param {number} run
 */
const runValues = (run) => ({ run_id: 9000 + run, run_number: run, run_attempt: 1, sha: String(run).repeat(40).slice(0, 40) });
/** A push to a branch of this repo. @param {string} branch @param {number} [run] */
const push = (branch, run = 1) => ({ github: { ...base, ...runValues(run), event_name: "push", ref: `refs/heads/${branch}`, ref_name: branch, head_ref: "", event: {} } });
/** A pull request, its head branch in a fork. @param {number} number @param {string} head @param {number} [run] */
const forkPullRequest = (number, head, run = 1) => ({
  github: { ...base, ...runValues(run), event_name: "pull_request", ref: `refs/pull/${number}/merge`, ref_name: `${number}/merge`, head_ref: head, event: { pull_request: { number } } },
});

test("evaluate: reads context paths, falls through || and refuses other forms", () => {
  const context = { github: { a: "", b: "x" } };
  assert.equal(evaluate("g-${{ github.a || github.b }}", context), "g-x");
  assert.throws(() => evaluate("${{ format('{0}', github.b) }}", context), /unsupported expression/);
});

test("ci: a push to main and two fork pull requests from their own main get three different groups", () => {
  const { group } = concurrency(readFileSync(workflowPath, "utf8"));
  const groups = [push("main"), forkPullRequest(5, "main"), forkPullRequest(6, "main")].map((context) => evaluate(group, context));
  assert.equal(new Set(groups).size, 3, `groups: ${groups.join(" | ")}`);
});

test("ci: two pushes to the same branch, two separate runs, share a group, and a newer run cancels the older", () => {
  const { group, cancel } = concurrency(readFileSync(workflowPath, "utf8"));
  assert.equal(evaluate(group, push("main", 1)), evaluate(group, push("main", 2)));
  assert.equal(cancel, "true");
});

test("ci: two runs of one pull request share a group", () => {
  const { group } = concurrency(readFileSync(workflowPath, "utf8"));
  assert.equal(evaluate(group, forkPullRequest(5, "main", 1)), evaluate(group, forkPullRequest(5, "main", 2)));
});

test("ci: a push and a pull request get two groups, and so do pushes to two branches", () => {
  const { group } = concurrency(readFileSync(workflowPath, "utf8"));
  assert.notEqual(evaluate(group, push("main")), evaluate(group, forkPullRequest(5, "feature")));
  assert.notEqual(evaluate(group, push("main")), evaluate(group, push("feature")));
});
