// Shared readers for specs/manifest.json and docs/adr/*.md.
//
// Used by check-manifest.mjs, kanban.mjs, and threads.mjs so the three scripts
// agree on paths, ADR parsing, and which card statuses count as active.

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const ACTIVE_STATUSES = new Set(["pending", "open", "in_progress", "paused", "blocked"]);

export const ADR_SECTIONS = [
  "Status",
  "Tags",
  "Date",
  "Context",
  "Decision",
  "Consequences",
  "Alternatives Considered",
  "References",
];

export const GENERATED_START = "<!-- generated:start -->";
export const GENERATED_END = "<!-- generated:end -->";

/** The schema's id pattern; a thread id names its own file. */
export const ID_PATTERN = /^[a-z0-9-]+$/;

/**
 * Problems with one metadata.threads[] entry's id and file, checked before a
 * generator touches the filesystem (the generators do not run the schema).
 * @param {{ id: unknown, file: unknown }} thread
 * @returns {string[]}
 */
export function threadEntryProblems(thread) {
  const id = String(thread.id);
  if (typeof thread.id !== "string" || !ID_PATTERN.test(id)) return [`thread ${id}: id must match ${ID_PATTERN.source}`];
  const expected = `specs/threads/${id}.md`;
  if (thread.file !== expected) return [`thread ${id}: file must be ${expected}; found ${String(thread.file)}`];
  return [];
}

/** @param {string} from @param {string} to */
function isInside(from, to) {
  const rel = relative(from, to);
  return rel !== "" && rel.split(sep)[0] !== ".." && !isAbsolute(rel);
}

/**
 * The real path of `path`, following every link. A part of the path that does
 * not exist yet is appended as written. Throws on a broken link.
 * @param {string} path absolute
 */
function realPathOf(path) {
  const rest = [];
  let current = path;
  for (;;) {
    let exists = true;
    try {
      lstatSync(current);
    } catch {
      exists = false;
    }
    if (exists) return join(realpathSync(current), ...rest);
    const parent = dirname(current);
    if (parent === current) return join(current, ...rest);
    rest.unshift(basename(current));
    current = parent;
  }
}

/**
 * Resolve a generator's output file and refuse one that leaves `dir`, by its
 * written path or through a link, or a `dir` that itself leaves the checkout.
 * @param {string} root absolute checkout path
 * @param {string} file repo-relative path, as the manifest or the generator names it
 * @param {string} dir repo-relative folder the file must stay inside
 * @returns {string} absolute path to read and write
 */
export function containedPath(root, file, dir) {
  const base = resolve(root, dir);
  const target = resolve(root, file);
  if (!isInside(base, target)) throw new Error(`${file} is outside ${dir}/`);
  let realRoot, realBase, realTarget;
  try {
    realRoot = realPathOf(resolve(root));
    realBase = realPathOf(base);
    realTarget = realPathOf(target);
  } catch {
    throw new Error(`${file} is a broken link; refusing to write through it`);
  }
  if (!isInside(realRoot, realBase)) throw new Error(`${dir}/ resolves outside the checkout through a link`);
  if (!isInside(realBase, realTarget)) throw new Error(`${file} resolves outside ${dir}/ through a link`);
  return target;
}

/** @param {string} root */
export function manifestPath(root) {
  return join(root, "specs", "manifest.json");
}

/** @param {string} path */
export function readManifest(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Display order for active statuses: what is moving first, then what is stuck, then what waits. */
export const STATUS_ORDER = ["in_progress", "blocked", "paused", "pending", "open"];

/**
 * Sort active cards by status (STATUS_ORDER), then priority, then created.
 * @param {{ status: string, priority: number, created: string }} a
 * @param {{ status: string, priority: number, created: string }} b
 */
export function compareActiveCards(a, b) {
  const byStatus = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
  if (byStatus !== 0) return byStatus;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.created.localeCompare(b.created);
}

/** @param {Record<string, unknown>} card */
export function isActive(card) {
  return ACTIVE_STATUSES.has(String(card.status));
}

/** @param {Record<string, unknown>} card */
export function actorOf(card) {
  return card.actor === "owner" ? "owner" : "agent";
}

/**
 * Parse one ADR file. Returns headings in order, the title, status, tags, date.
 * @param {string} file absolute path
 */
export function parseAdr(file) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const titleLine = lines.find((line) => line.startsWith("# ")) ?? "";
  const title = titleLine.replace(/^# /, "").replace(/^ADR-\d{4}:\s*/, "").trim();
  const number = basename(file).slice(0, 4);

  /** @type {string[]} */
  const headings = [];
  /** @type {Record<string, string>} */
  const bodies = {};
  let current = null;
  for (const line of lines) {
    const match = /^## (.+?)\s*$/.exec(line);
    if (match) {
      current = match[1];
      headings.push(current);
      bodies[current] = "";
    } else if (current !== null) {
      bodies[current] += `${line}\n`;
    }
  }

  const firstLine = (section) =>
    (bodies[section] ?? "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";

  // Tags may wrap across lines; every non-empty line of the section counts.
  const tags = (bodies.Tags ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

  // The status line may carry a trailing note (an amendment, say).
  // The status itself is the leading vocabulary term.
  const statusLine = firstLine("Status");
  const statusMatch = /^(Proposed|Accepted|Superseded by \d{4})/.exec(statusLine);
  const status = statusMatch ? statusMatch[1] : statusLine;

  return {
    file,
    number,
    id: `adr-${number}`,
    title,
    headings,
    status,
    statusLine,
    date: firstLine("Date"),
    tags,
  };
}

/** @param {string} root */
export function readAdrs(root) {
  const dir = join(root, "docs", "adr");
  return readdirSync(dir)
    .filter((name) => /^\d{4}-.+\.md$/.test(name))
    .sort()
    .map((name) => parseAdr(resolve(dir, name)));
}

/**
 * ADR numbers (the four-digit prefix) that appear on more than one file.
 * @param {string} dir absolute path to docs/adr
 */
export function duplicateAdrNumbers(dir) {
  const counts = new Map();
  for (const name of readdirSync(dir)) {
    const match = /^(\d{4})-.+\.md$/.exec(name);
    if (match) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }
  return [...counts].filter(([, n]) => n > 1).map(([number]) => number).sort();
}

/**
 * Every .md file under dir, recursively, as paths relative to dir with / separators.
 * A folder that does not exist yet (specs/design before the first design) has none.
 * @param {string} dir absolute path
 */
export function walkMarkdown(dir) {
  /** @type {string[]} */
  const found = [];
  if (!existsSync(dir)) return found;
  const visit = (current) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) visit(full);
      else if (name.endsWith(".md")) found.push(relative(dir, full).split("\\").join("/"));
    }
  };
  visit(dir);
  return found;
}

/**
 * Replace the block between the generated markers, or append one if absent.
 * Text above the start marker is preserved byte for byte.
 * @param {string} existing current file contents, or "" for a new file
 * @param {string} generated body to place between the markers
 * @param {string} header used only when the file does not exist yet
 */
export function spliceGenerated(existing, generated, header) {
  const block = `${GENERATED_START}\n${generated.trimEnd()}\n${GENERATED_END}\n`;
  const bounds = findGeneratedBounds(existing);
  if (bounds === null) {
    const head = existing.length > 0 ? existing.trimEnd() : header.trimEnd();
    return `${head}\n\n${block}`;
  }
  const tail = existing.slice(bounds.end).replace(/^\n/, "");
  return `${existing.slice(0, bounds.start)}${block}${tail}`;
}

/**
 * Locate the real generated block. A marker counts only when it is a whole
 * line outside any fenced code block (``` or ~~~), so prose that quotes a
 * marker inline or shows it in a fenced example is never treated as the
 * boundary. Returns character offsets: `start` of the start-marker line and
 * `end` at the end of the end-marker line, before its newline; null when the
 * text has no marker. Throws, before anything is written, when the markers do
 * not form exactly one start followed by one end, so authored text after a
 * lost end marker is never discarded.
 * @param {string} text
 * @returns {{ start: number, end: number } | null}
 */
export function findGeneratedBounds(text) {
  let offset = 0;
  /** Open fence: its character and run length, per CommonMark 4.5. */
  let fence = null;
  /** @type {{ kind: "start" | "end", start: number, end: number }[]} */
  const markers = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const lineEnd = offset + rawLine.length + 1;
    // A fence line may be indented up to three spaces. An opener may carry an
    // info string (backtick fences may not contain a backtick in it). A closer
    // must use the same character, be at least as long, and carry nothing but
    // whitespace after the run.
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence === null) {
      if (fenceMatch && !(fenceMatch[1][0] === "`" && fenceMatch[2].includes("`"))) {
        fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
      } else if (/^<!-- generated:start -->[ \t]*$/.test(line)) {
        markers.push({ kind: "start", start: offset, end: offset + rawLine.length });
      } else if (/^<!-- generated:end -->[ \t]*$/.test(line)) {
        markers.push({ kind: "end", start: offset, end: offset + rawLine.length });
      }
    } else if (
      fenceMatch &&
      fenceMatch[1][0] === fence.char &&
      fenceMatch[1].length >= fence.length &&
      fenceMatch[2].trim() === ""
    ) {
      fence = null;
    }
    offset = lineEnd;
  }

  if (markers.length === 0) return null;
  const starts = markers.filter((m) => m.kind === "start");
  const ends = markers.filter((m) => m.kind === "end");
  if (starts.length > 1) throw new Error("more than one generated:start marker; keep one generated block and fix the file by hand");
  if (ends.length > 1) throw new Error("more than one generated:end marker; keep one generated block and fix the file by hand");
  if (starts.length === 0) throw new Error("generated:end marker with no generated:start marker before it; fix the file by hand");
  if (ends.length === 0 || ends[0].start < starts[0].start) {
    throw new Error("generated:start marker with no generated:end marker after it; restore the end marker by hand");
  }
  return { start: starts[0].start, end: ends[0].end };
}
