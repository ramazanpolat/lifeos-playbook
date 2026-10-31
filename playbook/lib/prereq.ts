import { accessSync, constants, lstatSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

/** bun's package cache, resolved the way bun resolves it (bunfig overrides aside). */
export function bunCacheDir(env: Record<string, string | undefined>, home: string): string {
  if (env.BUN_INSTALL_CACHE_DIR) return env.BUN_INSTALL_CACHE_DIR;
  return join(env.BUN_INSTALL || join(home, ".bun"), "install", "cache");
}

function owner(p: string): number | null {
  try {
    return lstatSync(p).uid;
  } catch {
    return null;
  }
}

/** Strictly below `home`: the only place a suggested recursive chown is safe. */
function belowHome(p: string, home: string): boolean {
  const r = relative(home, p);
  return r !== "" && !r.startsWith("..") && !isAbsolute(r);
}

/**
 * Why `bun install` cannot use the cache at `dir`, or null. Upstream's installer runs bun install
 * in about twenty directories; a cache left owned by root (an earlier `sudo bun ...`) fails every
 * one of them with EACCES halfway through the install. The test is the one bun needs: write and
 * search permission on the cache, or on the nearest existing ancestor it would be created in.
 * Entries owned by someone else in a usable cache are not a problem. A fix is named only below
 * the home: the topmost directory there that is not the user's, so one chown covers it.
 */
export function bunCacheProblem(dir: string, home: string, uid: number): string | null {
  let existing = dir;
  while (owner(existing) === null && dirname(existing) !== existing) existing = dirname(existing);
  try {
    accessSync(existing, constants.W_OK | constants.X_OK);
    return null;
  } catch {}
  let fix: string;
  if (belowHome(existing, home)) {
    let target: string | null = null;
    for (let p = existing; belowHome(p, home); p = dirname(p)) if (owner(p) !== uid) target = p;
    fix = target ? `sudo chown -R "$(id -un)" ${target}` : `chmod u+rwx ${existing}`;
  } else fix = `make ${existing} writable for you, or point BUN_INSTALL_CACHE_DIR at a directory you own`;
  return `bun's package cache ${dir} cannot be used: ${existing} is not writable by you (often left by an earlier sudo bun), and upstream's installer runs bun install about twenty times. Fix: ${fix}`;
}
