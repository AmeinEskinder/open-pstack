import { expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claude } from "./providers/claude.ts";
import { resolveLane } from "./registry/index.ts";
import { runLane } from "./run.ts";

it("passes complete Claude writer settings through a command file from paths with spaces", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "pstack claude settings "));
  const bin = mkdtempSync(join(tmpdir(), "pstack-claude-shim-"));
  try {
    const shared = join(scratch, "shared repo");
    const checkout = join(scratch, "writer checkout");
    const git = (...args: string[]): void => {
      const result = Bun.spawnSync(["git", ...args], { stdout: "ignore", stderr: "pipe" });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
    };
    git("init", "-q", shared);
    git("-C", shared, "-c", "user.name=Runner Test", "-c", "user.email=runner@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "fixture");
    git("-C", shared, "worktree", "add", "-q", "-b", "writer", checkout);

    const child = join(scratch, "fake claude.ts");
    writeFileSync(child, `#!/usr/bin/env bun
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "auth") {
  console.log(JSON.stringify({ loggedIn: true }));
} else {
  const settingsPath = args[args.indexOf("--settings") + 1];
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  console.log(JSON.stringify({
    result: JSON.stringify({ settingsPath, settings }),
    modelUsage: { "claude-opus-9": {} },
  }));
}
`);
    const executable = process.platform === "win32" ? join(bin, "claude.cmd") : child;
    if (process.platform === "win32") {
      writeFileSync(executable, `@echo off\r\n"${process.execPath}" "${child}" %*\r\n`);
    } else {
      chmodSync(executable, 0o755);
    }
    const promptPath = join(scratch, "prompt.md");
    writeFileSync(promptPath, "Return the settings you received.");
    const resolved = resolveLane({
      parent: "codex", provider: "claude", model: "opus", effort: "max", mode: "isolated-write",
      promptPath, cwd: checkout, outputPath: join(scratch, "result.md"),
      receiptPath: join(scratch, "receipt.json"), timeoutMs: null,
    });
    const lane = { ...resolved, adapter: { ...claude, executable } };
    const result = await runLane(lane);
    expect(result.receipt.error).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(result.receipt).toMatchObject({ status: "complete", writerSandbox: "bounded", modelVerified: true });
    const observed = JSON.parse(readFileSync(lane.outputPath, "utf8"));
    expect(observed.settings).toEqual({
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        failIfUnavailable: true,
        filesystem: { denyWrite: [realpathSync(join(shared, ".git"))] },
      },
    });
    expect(JSON.parse(readFileSync(observed.settingsPath, "utf8"))).toEqual(observed.settings);
    expect(result.receipt.argv[result.receipt.argv.indexOf("--settings") + 1]).toBe(observed.settingsPath);
    if (process.platform !== "win32") expect(statSync(observed.settingsPath).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});
