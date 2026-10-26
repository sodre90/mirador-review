import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { helpers, installThisPlugin, testHost } from "./mirador.ts";

const { addWorkspace, callCanvasTool, signIn, startConversation, walkthroughView } = helpers;
const { TestHost } = testHost;

const host = new TestHost({ fakePrograms: true });

function git(...args: string[]) {
  return execFileSync("git", ["-C", host.projectDir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
}

const lines = (name: string, count: number, changed: number | null) =>
  Array.from({ length: count }, (_, index) => (index + 1 === changed ? `export const ${name}${index + 1} = "changed";` : `export const ${name}${index + 1} = ${index + 1};`)).join("\n") + "\n";

test.beforeAll(async () => {
  mkdirSync(host.projectDir, { recursive: true });
  git("init", "-q", "-b", "main");
  writeFileSync(join(host.projectDir, "far.ts"), lines("far", 60, null));
  writeFileSync(join(host.projectDir, "deep.ts"), lines("deep", 60, null));
  git("add", ".");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(host.projectDir, "far.ts"), lines("far", 60, 30));
  writeFileSync(join(host.projectDir, "deep.ts"), lines("deep", 60, 40));
  git("commit", "-q", "-am", "change a line in each");
  installThisPlugin(host);
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

test("the lines above a file's first change can all be shown, a few at a time or at once", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);
  await callCanvasTool(host, conversationId, "review", { title: "Changed lines", repository: host.projectDir, base: "main", verdict: "Approve.", summary: "Changes a line in each file.", flow: [], findings: [] });
  const view = walkthroughView(page).locator(".review");
  await view.getByRole("tab", { name: /Files/ }).click();
  const firstHunk = view.locator(".hunk").first();
  /** The gap row above the change, first in the hunk; a file's last hunk also has one under it. */
  const topGap = firstHunk.locator(":scope > .hunk-header:first-child");
  const line = (number: number) => firstHunk.getByRole("button", { name: `Line ${number}`, exact: true });

  await test.step("far below the top: 20 lines over the change, then the rest", async () => {
    await view.locator(".review-list li", { hasText: "far.ts" }).getByRole("button").click();
    await expect(line(27)).toBeVisible();
    await expect(line(26)).toHaveCount(0);
    await topGap.getByRole("button", { name: "↑ 20 lines" }).click();
    await expect(line(7)).toBeVisible();
    await expect(line(6)).toHaveCount(0);
    await topGap.getByRole("button", { name: "Show 6 lines" }).click();
    await expect(line(1)).toBeVisible();
    await expect(firstHunk.locator(".code-row.context")).toHaveCount(26 + 3 + 3);
    await expect(topGap).toHaveCount(0);
  });

  await test.step("All N lines: all of them at once", async () => {
    await view.locator(".review-list li", { hasText: "deep.ts" }).getByRole("button").click();
    await expect(line(37)).toBeVisible();
    await topGap.getByRole("button", { name: "All 36 lines" }).click();
    await expect(line(1)).toBeVisible();
    await expect(firstHunk.locator(".code-row.context .code-text").first()).toHaveText("export const deep1 = 1;");
    await expect(topGap).toHaveCount(0);
  });
});
