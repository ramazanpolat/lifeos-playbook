#!/usr/bin/env bun
/**
 * hook-smoke -- fire every command hook a converted playbook registers, the way Claude Code
 * would: a synthetic event payload on stdin, CLAUDE_CONFIG_DIR set to the playbook, cwd a
 * project directory. Catches hooks that crash, hang, block an ordinary action, or resolve a
 * path outside the playbook -- without a model login.
 *
 *   bun playbook/tests/hook-smoke.ts --root <playbook root>
 *
 * Exit: 0 every hook exited 0, 1 a hook crashed, timed out or blocked, 2 usage.
 * HTTP hooks are listed and skipped: upstream designs them to fail open.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const i = args.indexOf("--root");
if (i < 0 || !args[i + 1]) {
  console.error("usage: bun playbook/tests/hook-smoke.ts --root <playbook root>");
  process.exit(2);
}
const root = resolve(args[i + 1]);
const settings = JSON.parse(readFileSync(join(root, "settings.json"), "utf8")) as { hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<Record<string, unknown>> }>> };
const project = join(root, ".lifeos-playbook", "smoke-project");
mkdirSync(project, { recursive: true });
const sessionId = "00000000-0000-4000-8000-000000000000";
const transcript = join(project, "transcript.jsonl");

/** A plausible tool call for a PreToolUse/PostToolUse matcher such as "Bash" or "Edit|Write". */
function toolFor(matcher: string | undefined): { tool_name: string; tool_input: Record<string, unknown> } {
  const name = (matcher ?? "Bash").split("|")[0].replace(/[\^$()*.]/g, "") || "Bash";
  const file = join(project, "notes.md");
  const inputs: Record<string, Record<string, unknown>> = {
    Bash: { command: "ls", description: "List files" },
    Read: { file_path: file },
    Write: { file_path: file, content: "hello\n" },
    Edit: { file_path: file, old_string: "hello", new_string: "hi" },
    MultiEdit: { file_path: file, edits: [{ old_string: "hello", new_string: "hi" }] },
    Glob: { pattern: "*.md" },
    Grep: { pattern: "hello" },
    WebFetch: { url: "https://example.com", prompt: "summarize" },
    WebSearch: { query: "example" },
    Task: { description: "explore", prompt: "list files", subagent_type: "general-purpose" },
    Agent: { description: "explore", prompt: "list files", subagent_type: "general-purpose" },
    Skill: { skill: "LifeOS" },
  };
  return { tool_name: name, tool_input: inputs[name] ?? {} };
}

function payload(event: string, matcher: string | undefined): Record<string, unknown> {
  const base = { session_id: sessionId, transcript_path: transcript, cwd: project, hook_event_name: event, permission_mode: "default" };
  switch (event) {
    case "SessionStart":
      return { ...base, source: "startup" };
    case "SessionEnd":
      return { ...base, reason: "exit" };
    case "UserPromptSubmit":
      return { ...base, prompt: "What should I work on today?" };
    case "PreToolUse":
      return { ...base, ...toolFor(matcher) };
    case "PostToolUse":
      return { ...base, ...toolFor(matcher), tool_response: { stdout: "notes.md\n", stderr: "", interrupted: false } };
    case "Stop":
    case "SubagentStop":
      return { ...base, stop_hook_active: false };
    case "Notification":
      return { ...base, message: "Claude needs your permission to use Bash" };
    case "PreCompact":
      return { ...base, trigger: "manual", custom_instructions: "" };
    default:
      return base;
  }
}

const CRASH = /TypeError|ReferenceError|SyntaxError|Cannot find module|ENOENT|Unhandled|panic:|Traceback/;
let failed = 0;
let ran = 0;
const rows: string[] = [];
for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
  for (const g of groups ?? []) {
    for (const h of g.hooks ?? []) {
      const label = `${event}${g.matcher ? `[${g.matcher}]` : ""}`;
      const command = String(h.command ?? h.url ?? "");
      const short = command.replace(root, "<root>").slice(0, 90);
      if (h.type !== "command") {
        rows.push(`  skip   ${label.padEnd(28)} ${String(h.type)} hook (fails open by design): ${short}`);
        continue;
      }
      ran++;
      const timeoutS = Math.min(Number(h.timeout ?? 60), 90);
      const t0 = Date.now();
      const r = spawnSync("sh", ["-c", command], {
        cwd: project,
        input: JSON.stringify(payload(event, g.matcher)),
        env: { ...process.env, CLAUDE_CONFIG_DIR: root, CLAUDE_PROJECT_DIR: project },
        encoding: "utf8",
        timeout: timeoutS * 1000,
        maxBuffer: 16 * 1024 * 1024,
      });
      const ms = Date.now() - t0;
      const err = (r.stderr ?? "").trim();
      const timedOut = r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
      let status = "ok";
      if (timedOut) status = "TIMEOUT";
      else if (r.status === 2) status = "BLOCKED";
      else if (r.status !== 0) status = `EXIT ${r.status}`;
      else if (CRASH.test(err)) status = "STDERR";
      if (status !== "ok") failed++;
      rows.push(`  ${status.padEnd(7)}${label.padEnd(28)} ${String(ms).padStart(6)} ms  ${short}`);
      if (status !== "ok" && err) for (const line of err.split("\n").slice(-4)) rows.push(`           | ${line.replace(root, "<root>").slice(0, 160)}`);
    }
  }
}
console.log(`hook-smoke: ${ran} command hook(s) in ${root}`);
for (const r of rows) console.log(r);
console.log(`hook-smoke: ${ran - failed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
