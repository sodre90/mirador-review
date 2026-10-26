import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewRequest } from "../host/review/snapshot.ts";

/** A checkout whose feature branch changes one line of service.ts on top of main. */
export function gitRepository() {
  const directory = mkdtempSync(join(tmpdir(), "mirador-review-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", directory, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(directory, "service.ts"), ["export function serve() {", "  return load();", "}", "", "function load() {", "  return 1;", "}"].join("\n") + "\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(directory, "service.ts"), ["export function serve() {", "  return load() + 1;", "}", "", "function load() {", "  return 1;", "}"].join("\n") + "\n");
  git("commit", "-q", "-am", "change");
  return { directory, head: git("rev-parse", "HEAD").trim() };
}

export const reviewRequest = (repository: string, change: Partial<ReviewRequest> = {}): ReviewRequest => ({
  title: "Serve one more",
  repository,
  base: "main",
  verdict: "Approve.",
  summary: "Adds one.",
  flow: [{ title: "Entry", at: "service.ts:1-3", say: "serve() calls load()." }],
  findings: [{ severity: "nit", checked: "confirmed", at: "service.ts:2", title: "Magic number", body: "Name the 1?" }],
  ...change,
});
