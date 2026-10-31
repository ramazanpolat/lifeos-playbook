import { accessSync, constants, lstatSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

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

/**
 * Why `bun install` cannot use the cache at `dir`, or null. Upstream's installer runs bun install
 * in about twenty directories; a cache left owned by root (an earlier `sudo bun ...`) fails every
 * one of them with EACCES halfway through the install. The fix names the topmost directory under
 * the home that is not the user's, so one chown covers it.
 */
export function bunCacheProblem(dir: string, home: string, uid: number): string | null {
  let existing = dir;
  while (owner(existing) === null && dirname(existing) !== existing) existing = dirname(existing);
  let foreign = 0;
  let writable = true;
  try {
    accessSync(existing, constants.W_OK);
  } catch {
    writable = false;
  }
  if (existing === dir && writable) {
    try {
      for (const name of readdirSync(dir)) if (owner(join(dir, name)) !== uid) foreign++;
    } catch {}
  }
  if (writable && foreign === 0) return null;
  let target = existing;
  for (let p = existing; p !== home && !relative(home, p).startsWith("..") && dirname(p) !== p; p = dirname(p)) if (owner(p) !== uid) target = p;
  const what = writable ? `${foreign} of its entries belong to another user` : `${existing} is not writable by you`;
  return `bun's package cache ${dir} cannot be used: ${what} (usually left by an earlier sudo bun), and upstream's installer runs bun install about twenty times. Fix: sudo chown -R "$(id -un)" ${target}`;
}
