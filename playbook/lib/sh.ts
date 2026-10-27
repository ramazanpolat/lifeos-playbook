import { spawnSync } from "node:child_process";

export interface RunOpts {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Capture stdout instead of streaming it. */
  capture?: boolean;
  /** Return the result instead of throwing on a non-zero exit. */
  allowFail?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command without a shell. Streams output unless `capture`; throws on failure unless `allowFail`. */
export function run(cmd: string, args: string[], o: RunOpts = {}): RunResult {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.env ?? process.env)) if (v !== undefined) env[k] = v;
  const r = spawnSync(cmd, args, {
    cwd: o.cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", o.capture ? "pipe" : "inherit", o.capture ? "pipe" : "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  const res = { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  if (res.code !== 0 && !o.allowFail) {
    const tail = (res.stderr || res.stdout).trim().split("\n").slice(-15).join("\n");
    throw new Error(`${cmd} ${args.join(" ")} exited ${res.code}${tail ? `\n${tail}` : ""}`);
  }
  return res;
}
