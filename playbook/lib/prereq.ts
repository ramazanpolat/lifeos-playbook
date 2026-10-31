import { accessSync, constants, lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * bun's package cache, resolved in bun's order: BUN_INSTALL_CACHE_DIR, BUN_INSTALL/install/cache,
 * XDG_CACHE_HOME/.bun/install/cache, ~/.bun/install/cache (a bunfig cache.dir override aside).
 * Always absolute.
 */
export function bunCacheDir(env: Record<string, string | undefined>, home: string): string {
  if (env.BUN_INSTALL_CACHE_DIR) return resolve(env.BUN_INSTALL_CACHE_DIR);
  if (env.BUN_INSTALL) return join(resolve(env.BUN_INSTALL), "install", "cache");
  if (env.XDG_CACHE_HOME) return join(resolve(env.XDG_CACHE_HOME), ".bun", "install", "cache");
  return join(home, ".bun", "install", "cache");
}

export interface CacheProblem {
  /** The node bun cannot use: the cache itself, or the nearest existing ancestor it would be created in. */
  blocked: string;
  /** How the user can make the shared cache usable again (shell-quoted paths). */
  fix: string;
}

/** A single-quoted shell word. */
export function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Strictly below `home`, both sides with symlinks resolved. */
function belowHome(p: string, home: string): boolean {
  const r = relative(real(home), p);
  return r !== "" && !r.startsWith("..") && !isAbsolute(r);
}

/**
 * Why `bun install` cannot use the cache at `dir`, or null. Upstream's installer runs bun install
 * in about twenty directories; a cache left owned by root (an earlier `sudo bun ...`) fails every
 * one of them with EACCES. The test is the one bun needs: the cache, or the nearest existing
 * ancestor it would be created in, is a directory with write and search permission. Entries owned
 * by someone else in a usable cache do not count. A chown is suggested only for the cache itself
 * and only when, symlinks resolved, it lies below the home.
 */
export function bunCacheProblem(dir: string, home: string): CacheProblem | null {
  const cache = resolve(dir);
  let existing = cache;
  for (;;) {
    try {
      lstatSync(existing);
      break;
    } catch {}
    if (dirname(existing) === existing) break;
    existing = dirname(existing);
  }
  let isDir = false;
  try {
    isDir = statSync(existing).isDirectory(); // follows links: a dangling one is not a directory
  } catch {}
  if (isDir) {
    try {
      accessSync(existing, constants.W_OK | constants.X_OK);
      return null;
    } catch {}
  }
  const target = existing === cache ? real(cache) : join(real(existing), relative(existing, cache));
  let fix: string;
  if (!isDir || !belowHome(target, home)) fix = `make ${shellQuote(cache)} a directory you can write, or point BUN_INSTALL_CACHE_DIR at one`;
  else if (existing === cache) fix = `sudo chown -R "$(id -un)" ${shellQuote(target)}`;
  else fix = `sudo mkdir -p ${shellQuote(target)} && sudo chown -R "$(id -un)" ${shellQuote(target)}`;
  return { blocked: existing, fix };
}
