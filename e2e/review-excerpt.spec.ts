import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { helpers, installThisPlugin, testHost } from "./mirador.ts";

const { addWorkspace, callCanvasTool, primaryModifier, signIn, startConversation, workspaceCard, walkthroughView } = helpers;
const { TestHost } = testHost;

const host = new TestHost({ fakePrograms: true });

function git(...args: string[]) {
  return execFileSync("git", ["-C", host.projectDir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
}

const commentOpenedBeforeTheGapClosingInsideIt: Record<number, string> = { 78: "/**", 79: " * Documents the lines below.", 150: " */" };
const bigFile =
  Array.from({ length: 300 }, (_, index) => commentOpenedBeforeTheGapClosingInsideIt[index + 1] ?? `const line${index + 1} = ${index + 1};`).join("\n") + "\n";

test.beforeAll(async () => {
  mkdirSync(host.projectDir, { recursive: true });
  git("init", "-q", "-b", "main");
  writeFileSync(join(host.projectDir, "small.ts"), "export const small = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(host.projectDir, "big.ts"), bigFile);
  git("add", ".");
  git("commit", "-q", "-m", "add big.ts");
  installThisPlugin(host);
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

const longRange = { severity: "nit", checked: "plausible", at: "big.ts:1-300", title: "Whole file", body: "Was all of this meant to change?" };
const shortRange = { severity: "nit", checked: "plausible", at: "big.ts:10-12", title: "Three lines", body: "Why these three?" };

test("a finding anchored past the excerpt cap keeps both ends of its range and marks what was left out", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);
  const result = await callCanvasTool(host, conversationId, "review", {
    title: "Big file",
    repository: host.projectDir,
    base: "main",
    verdict: "Approve.",
    summary: "Adds big.ts.",
    flow: [],
    findings: [longRange, shortRange],
  });
  expect(result).toContain("2 findings");

  const view = walkthroughView(page).locator(".review");
  await view.getByRole("tab", { name: /Findings/ }).click();
  const wholeFile = view.locator(".finding", { hasText: "Whole file" });
  const block = wholeFile.locator(".code-block");

  await expect(block.locator(".code-row.elided")).toContainText("… 141 lines not shown …");
  await expect(block.locator(".code-row.elided .line-number")).toHaveCount(0);
  await expect(block.getByRole("button", { name: "Line 1", exact: true })).toBeVisible();
  await expect(block.getByRole("button", { name: "Line 300", exact: true })).toBeVisible();
  await expect(block.getByRole("button", { name: "Line 80", exact: true })).toHaveCount(0);

  await expect(block.locator(".code-row.elided")).toHaveClass(/\banchored\b/);
  await expect(block.locator(".code-row.anchored")).toHaveCount(160);

  const rowOf = (line: number) => block.locator(".code-row").filter({ has: page.getByRole("button", { name: `Line ${line}`, exact: true }) });
  await expect(rowOf(79).locator(".token.comment")).toHaveCount(1);
  await expect(rowOf(300).locator(".token.keyword")).toHaveText("const");
  await expect(rowOf(300).locator(".token.comment")).toHaveCount(0);
  await expect(rowOf(221).locator(".token.comment")).toHaveCount(0);

  const threeLines = view.locator(".finding", { hasText: "Three lines" }).locator(".code-block");
  await expect(threeLines.locator(".code-row.elided")).toHaveCount(0);
  await expect(threeLines.getByRole("button", { name: "Line 4", exact: true })).toBeVisible();
  await expect(threeLines.getByRole("button", { name: "Line 18", exact: true }).first()).toBeVisible();
});

test("a question about an anchor with a gap writes the gap as a hunk-style line, not as code", async ({ page }) => {
  await signIn(page, host);
  const addProject = page.getByRole("button", { name: "+ Add a project directory" });
  await expect(addProject.or(workspaceCard(page, host.projectDir))).toBeVisible();
  if (await addProject.isVisible()) await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);
  await callCanvasTool(host, conversationId, "review", {
    title: "Big file",
    repository: host.projectDir,
    base: "main",
    verdict: "Approve.",
    summary: "Adds big.ts.",
    flow: [],
    findings: [longRange],
  });

  const view = walkthroughView(page).locator(".review");
  await view.getByRole("tab", { name: /Findings/ }).click();
  await view.locator(".finding", { hasText: "Whole file" }).getByRole("button", { name: "Ask" }).click();
  const dialog = walkthroughView(page).getByRole("dialog", { name: "Ask the agent about these lines" });
  await dialog.locator("textarea").fill("Reply with just the word NOTED.");
  await dialog.locator("textarea").press(`${await primaryModifier(page)}+Enter`);

  const asked = page.locator(".message.user").last();
  await expect(asked).toContainText("@@ 141 lines not shown @@");
  await expect(asked).not.toContainText("… 141 lines not shown …");
});
