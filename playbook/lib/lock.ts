import { readFileSync, rmSync, writeFileSync } from "node:fs";

export type LockResult = { release: () => void; tookOverFrom?: number } | { busy: number | null; takeover?: string };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by another user
  }
}

/**
 * Take the lock file `f` for this process. A dead owner's lock is replaced only under a second
 * lock (`<f>.takeover`), so two processes can never both clear it, and a live owner's lock is
 * never touched: acquiring is an atomic create, which fails while the dead owner's file stays.
 * Returns `busy` with the holder's pid (null when unknown), and `takeover` when that second lock
 * is held (by a process starting at this moment, or left by one that crashed mid-takeover).
 */
export function acquireLock(f: string, pid = process.pid): LockResult {
  const mine = String(pid);
  const release = () => {
    try {
      if (readFileSync(f, "utf8").trim() === mine) rmSync(f, { force: true });
    } catch {}
  };
  const create = (file: string) => {
    try {
      writeFileSync(file, mine, { flag: "wx" });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      return false;
    }
  };
  if (create(f)) return { release };
  const takeover = `${f}.takeover`;
  if (!create(takeover)) return { busy: null, takeover };
  try {
    let owner = NaN;
    try {
      owner = Number(readFileSync(f, "utf8").trim());
    } catch {
      if (create(f)) return { release }; // released in between
    }
    if (!(owner > 0)) return { busy: null };
    if (alive(owner)) return { busy: owner };
    rmSync(f, { force: true });
    if (!create(f)) return { busy: null };
    return { release, tookOverFrom: owner };
  } finally {
    rmSync(takeover, { force: true });
  }
}
