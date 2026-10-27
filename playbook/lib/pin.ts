import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { run } from "./sh";

/**
 * The upstream release a playbook converts. Pinned by commit, never by tag alone:
 * upstream force-moves release tags, so a tag can point at different bytes later.
 */
export interface Pin {
  repo: string; // owner/name
  version: string; // x.y.z
  tag: string; // vX.Y.Z
  commit: string; // 40-hex the tag pointed at when pinned
  subpath: string; // skill directory inside the repo
  pinned: string; // YYYY-MM-DD-HH_MM
}

const SHA = /^[0-9a-f]{40}$/;
const VERSION = /^\d+\.\d+\.\d+$/;

export function validatePin(p: Pin): Pin {
  if (!/^[\w.-]+\/[\w.-]+$/.test(p.repo)) throw new Error(`pin: bad repo "${p.repo}"`);
  if (!VERSION.test(p.version)) throw new Error(`pin: bad version "${p.version}"`);
  if (p.tag !== `v${p.version}`) throw new Error(`pin: tag "${p.tag}" does not match version ${p.version}`);
  if (!SHA.test(p.commit)) throw new Error(`pin: commit must be 40 hex, got "${p.commit}"`);
  if (!p.subpath || p.subpath.includes("..")) throw new Error(`pin: bad subpath "${p.subpath}"`);
  return p;
}

export function readPin(file: string): Pin {
  return validatePin(JSON.parse(readFileSync(file, "utf8")) as Pin);
}

export function writePin(file: string, p: Pin): void {
  writeFileSync(file, JSON.stringify(validatePin(p), null, 2) + "\n");
}

export function stamp(d = new Date()): string {
  const z = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}-${z(d.getHours())}_${z(d.getMinutes())}`;
}

/** Compare x.y.z versions: negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

async function gh(path: string, accept = "application/vnd.github+json"): Promise<Response> {
  const headers: Record<string, string> = { Accept: accept, "User-Agent": "lifeos-playbook" };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`https://api.github.com${path}`, { headers });
  if (!r.ok) throw new Error(`GitHub ${path}: HTTP ${r.status}`);
  return r;
}

/** The newest published release of `repo`, resolved to the commit its tag points at now. */
export async function resolveLatest(repo: string, subpath: string): Promise<Pin> {
  const rel = (await (await gh(`/repos/${repo}/releases/latest`)).json()) as { tag_name?: string; draft?: boolean; prerelease?: boolean };
  const tag = rel.tag_name ?? "";
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`latest release of ${repo} has unexpected tag "${tag}"`);
  const commit = (await (await gh(`/repos/${repo}/commits/${tag}`, "application/vnd.github.sha")).text()).trim();
  return validatePin({ repo, version: tag.slice(1), tag, commit, subpath, pinned: stamp() });
}

/**
 * Fetch exactly `commit` of `repo` into `dest` (shallow) and prove HEAD is that commit.
 * Content addressing is the integrity check: GitHub publishes no checksum for releases.
 */
export function fetchCommit(repo: string, commit: string, dest: string): void {
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const git = (...a: string[]) => run("git", ["-C", dest, ...a], { capture: true });
  git("init", "-q");
  git("fetch", "-q", "--depth", "1", `https://github.com/${repo}.git`, commit);
  git("-c", "advice.detachedHead=false", "checkout", "-q", "FETCH_HEAD");
  const head = git("rev-parse", "HEAD").stdout.trim();
  if (head !== commit) throw new Error(`fetched ${repo}: HEAD is ${head}, expected ${commit}`);
}

/** Verify a local checkout is at the pinned commit (offline conversions and tests). */
export function verifyLocalSource(src: string, commit: string): void {
  const r = run("git", ["-C", src, "rev-parse", "HEAD"], { capture: true, allowFail: true });
  const head = r.stdout.trim();
  if (r.code !== 0) throw new Error(`--src ${src} is not a git checkout; pass --unverified-src to use it anyway`);
  if (head !== commit) throw new Error(`--src ${src} is at ${head}, the pin says ${commit}`);
}
