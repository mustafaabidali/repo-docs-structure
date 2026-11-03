// Copies of a checkout for the tests to work in. A test reads, writes and
// deletes only inside its own temporary copy: the copy holds no link that
// leads out of it, and insideCopy() refuses a path that resolves outside the
// copy before anything touches it.

import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { copyFileSync, lstatSync, mkdirSync, readdirSync, realpathSync, symlinkSync } from "node:fs";

/** @param {string} base @param {string} path both real paths */
function isWithin(base, path) {
  const rel = relative(base, path);
  return rel === "" || (rel.split(sep)[0] !== ".." && !isAbsolute(rel));
}

/**
 * Copy the folder `source` to `dest`. Files and folders are copied; a link is
 * copied only when it resolves inside `source`, and is then recreated as a
 * relative link to the same place inside `dest`. A link that resolves outside
 * `source`, or is broken, is left out, so nothing in the copy leads back to
 * the checkout or beyond it.
 * @param {string} source @param {string} dest
 * @param {string[]} [skipTop] top-level names to leave out
 */
export function copyCheckout(source, dest, skipTop = [".git", "node_modules"]) {
  const realSource = realpathSync(source);
  /** @param {string} from @param {string} to @param {boolean} top */
  const visit = (from, to, top) => {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) {
      if (top && skipTop.includes(name)) continue;
      const src = join(from, name);
      const dst = join(to, name);
      const stat = lstatSync(src);
      if (stat.isSymbolicLink()) {
        let real;
        try {
          real = realpathSync(src);
        } catch {
          continue;
        }
        if (!isWithin(realSource, real)) continue;
        symlinkSync(relative(dirname(dst), join(dest, relative(realSource, real))) || ".", dst);
      } else if (stat.isDirectory()) {
        visit(src, dst, false);
      } else if (stat.isFile()) {
        copyFileSync(src, dst);
      }
    }
  };
  visit(source, dest, true);
}

/**
 * `path`, after checking that its real path, through every link on the way,
 * lies inside the copy `base`. A part of the path that does not exist yet
 * counts as written. Throws, before anything is read, written or deleted,
 * when it would land outside.
 * @param {string} base @param {string} path
 * @returns {string}
 */
export function insideCopy(base, path) {
  const rest = [];
  let current = resolve(path);
  for (;;) {
    try {
      lstatSync(current);
      break;
    } catch {
      const parent = dirname(current);
      if (parent === current) break;
      rest.unshift(basename(current));
      current = parent;
    }
  }
  const real = join(realpathSync(current), ...rest);
  if (!isWithin(realpathSync(base), real)) throw new Error(`${path} resolves outside the copy ${base}; refusing to touch it`);
  return path;
}
