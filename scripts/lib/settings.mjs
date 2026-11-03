// The values a repository may change, in one place. Every check and every
// boundary test reads them from here, so changing one never breaks a test.
// Path lists are globs from the repository root: `**` crosses folders, `*`
// stays inside one folder.

/** Where a new Markdown file may be added. Add the folders that hold Markdown by design (an app's docs, vendored skills). */
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

/** The files agents read as rules. A change to one travels in a pull request of its own. Add any other rules file the agents load. */
export const RULE_FILES = ["AGENTS.md", "CLAUDE.md"];

/** What may travel with a rule-file change: ADRs, the decision log, the manifest and its generated views. */
export const ALLOWED_EXTRAS = [
  "docs/adr/**",
  "docs/ops/decision-log.md",
  "specs/manifest.json",
  "specs/KANBAN.md",
  "specs/threads/**",
];

/** Ceilings on active cards (deferred cards do not count). The build fails above them. */
export const CEILINGS = { total: 30, p1: 10, inProgress: 3, owner: 10 };

/**
 * The repository's default branch. A local run, and a push that creates any
 * other branch, are judged from their merge base with it. A pull request is
 * judged against its own base branch, and an ordinary push from the commit
 * before the push to HEAD, so neither reads this value.
 */
export const DEFAULT_BRANCH = "main";
