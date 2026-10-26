import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { helpers, installThisPlugin, testHost } from "./mirador.ts";

const { addWorkspace, callCanvasTool, primaryModifier, signIn, startConversation, walkthroughView } = helpers;
const { TestHost } = testHost;

const host = new TestHost({ fakePrograms: true });

function git(...args: string[]) {
  return execFileSync("git", ["-C", host.projectDir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
}

const numbered = (count: number, line: (n: number) => string) => Array.from({ length: count }, (_, index) => line(index + 1));
const HIDDEN_LINE = "// a needle hidden below the change";
const alphaBefore = numbered(40, (n) => (n === 39 ? HIDDEN_LINE : `export const a${n} = ${n};`));
/** Two lines with needles far apart in one hunk, so stepping from one to the other scrolls. */
const alphaAfter = [
  ...alphaBefore.slice(0, 29),
  'export const needle = "Needle";',
  ...numbered(80, (n) => `export const filler${n} = ${n};`),
  "export const needles = [needle];",
  ...alphaBefore.slice(31),
];

test.beforeAll(async () => {
  mkdirSync(host.projectDir, { recursive: true });
  git("init", "-q", "-b", "main");
  writeFileSync(join(host.projectDir, "alpha.ts"), alphaBefore.join("\n") + "\n");
  writeFileSync(join(host.projectDir, "beta.ts"), "export const b = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(host.projectDir, "alpha.ts"), alphaAfter.join("\n") + "\n");
  writeFileSync(join(host.projectDir, "beta.ts"), 'export const b = 1;\nexport const needle1 = "needle";\n');
  git("commit", "-q", "-am", "add needles");
  installThisPlugin(host);
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

/** The current match as highlighted: its text, the file and row it is in, and whether it is in view. */
const currentMatch = (page: Page) =>
  walkthroughView(page)
    .locator("body")
    .evaluate(() => {
      const range = [...(CSS.highlights.get("review-find-current") ?? [])][0] as Range | undefined;
      if (!range) return null;
      const diff = range.startContainer.parentElement!.closest(".file-diff")!;
      const box = range.getBoundingClientRect();
      const view = diff.getBoundingClientRect();
      return {
        text: range.toString(),
        file: diff.querySelector("h3")!.textContent,
        row: range.startContainer.parentElement!.closest(".code-row")!.querySelector(".code-text")!.textContent,
        connected: range.startContainer.isConnected && range.endContainer.isConnected,
        acrossElements: range.startContainer !== range.endContainer,
        inView: box.top >= view.top && box.bottom <= view.bottom,
      };
    });
const highlightedCount = (page: Page) => walkthroughView(page).locator("body").evaluate(() => CSS.highlights.get("review-find-match")?.size ?? 0);

test("Cmd+F in a review finds in the code of every changed file, stepping on from file to file", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);
  await callCanvasTool(host, conversationId, "review", { title: "Needles", repository: host.projectDir, base: "main", verdict: "Approve.", summary: "Adds needles.", flow: [], findings: [] });
  const view = walkthroughView(page).locator(".review");
  const bar = view.getByRole("search");
  const query = bar.getByRole("textbox", { name: "Find in the changed files" });
  const tally = bar.locator(".find-tally");
  const matchCount = (file: string) => view.locator(".review-list li", { hasText: file }).locator(".match-count");
  const mod = await primaryModifier(page);

  await test.step("Cmd+F on another tab of the review opens its Files tab with the find bar", async () => {
    await expect(view.getByRole("tab", { name: /Overview/ })).toHaveAttribute("aria-selected", "true");
    await view.locator(".review-body").click({ position: { x: 4, y: 4 } });
    await page.keyboard.press(`${mod}+KeyF`);
    await expect(view.getByRole("tab", { name: /Files/ })).toHaveAttribute("aria-selected", "true");
    await expect(query).toBeFocused();
  });

  await test.step("the count covers every file, each file shows its own, and the open file's matches are highlighted", async () => {
    await query.fill("needle");
    await expect(tally).toHaveText("1 of 6");
    await expect(matchCount("alpha.ts")).toHaveText("4");
    await expect(matchCount("beta.ts")).toHaveText("2");
    await expect.poll(() => highlightedCount(page)).toBe(4);
    await expect.poll(() => currentMatch(page)).toMatchObject({ text: "needle", file: "alpha.ts", row: 'export const needle = "Needle";', inView: true });
  });

  await test.step("Enter steps down, scrolling to a match far below, and past the file's last match into the next file", async () => {
    await query.press("Enter");
    await query.press("Enter");
    await expect(tally).toHaveText("3 of 6");
    await expect.poll(() => currentMatch(page)).toMatchObject({ text: "needle", file: "alpha.ts", row: "export const needles = [needle];", inView: true });
    await query.press("Enter");
    await query.press("Enter");
    await expect(tally).toHaveText("5 of 6");
    await expect(view.locator(".file-diff h3")).toHaveText("beta.ts");
    await expect.poll(() => currentMatch(page)).toMatchObject({ text: "needle", file: "beta.ts", inView: true });
    await expect(bar).toBeInViewport();
  });

  await test.step("Shift+Enter steps back up into the file before, and Enter goes round from the last match to the first", async () => {
    await query.press("Shift+Enter");
    await expect(tally).toHaveText("4 of 6");
    await expect.poll(() => currentMatch(page)).toMatchObject({ file: "alpha.ts", row: "export const needles = [needle];", inView: true });
    await query.press("Enter");
    await query.press("Enter");
    await query.press("Enter");
    await expect(tally).toHaveText("1 of 6");
    await expect.poll(() => currentMatch(page)).toMatchObject({ file: "alpha.ts", row: 'export const needle = "Needle";', inView: true });
  });

  await test.step("match case, whole word and regular expression narrow the matches, and a broken pattern says so", async () => {
    await bar.getByRole("button", { name: "Match case" }).click();
    await query.fill("Needle");
    await expect(tally).toHaveText("1 of 1");
    await expect(matchCount("beta.ts")).toHaveCount(0);
    await bar.getByRole("button", { name: "Match case" }).click();
    await bar.getByRole("button", { name: "Match whole word" }).click();
    await query.fill("needle");
    await expect(tally).toHaveText("1 of 4");
    await bar.getByRole("button", { name: "Match whole word" }).click();
    await bar.getByRole("button", { name: "Use regular expression" }).click();
    await query.fill("needle\\d");
    await expect(tally, "the open file has no match, so there is no current one yet").toHaveText("1 match");
    await query.press("Enter");
    await expect(tally).toHaveText("1 of 1");
    await expect.poll(() => currentMatch(page)).toMatchObject({ text: "needle1", file: "beta.ts" });
    await query.fill("needle(");
    await expect(tally).toHaveText("Invalid pattern");
    await expect.poll(() => highlightedCount(page)).toBe(0);
    await bar.getByRole("button", { name: "Use regular expression" }).click();
  });

  await test.step("a match across the parts syntax highlighting splits a line into is highlighted whole", async () => {
    await query.fill('= "needle');
    await expect(tally).toHaveText("2 of 2");
    await expect.poll(() => currentMatch(page)).toMatchObject({ text: '= "needle', file: "beta.ts", acrossElements: true });
  });

  await test.step("lines revealed around a hunk are searched too", async () => {
    await view.locator(".review-list li", { hasText: "alpha.ts" }).getByRole("button").click();
    await query.fill("needle");
    await expect(tally).toHaveText("1 of 6");
    await view.locator(".file-diff").getByRole("button", { name: "Show the rest of the file" }).click();
    await expect(tally).toHaveText("1 of 7");
    await expect(matchCount("alpha.ts")).toHaveText("5");
    await expect.poll(() => highlightedCount(page)).toBe(5);
    await expect.poll(() => currentMatch(page)).toMatchObject({ text: "needle", row: 'export const needle = "Needle";', connected: true });
    await query.click();
    for (const _ of [1, 2, 3, 4]) await query.press("Enter");
    await expect(tally).toHaveText("5 of 7");
    await expect.poll(() => currentMatch(page)).toMatchObject({ text: "needle", file: "alpha.ts", row: HIDDEN_LINE, connected: true, inView: true });
  });

  await test.step("Esc closes the bar and its highlights, and the review's keys work again", async () => {
    await query.press("Escape");
    await expect(bar).toHaveCount(0);
    await expect.poll(() => highlightedCount(page)).toBe(0);
    await expect.poll(() => currentMatch(page)).toBeNull();
    await expect(view).toBeFocused();
    await page.keyboard.press("1");
    await expect(view.getByRole("tab", { name: /Overview/ })).toHaveAttribute("aria-selected", "true");
  });

  await test.step("Cmd+F outside the review still finds in the conversation", async () => {
    await view.getByRole("button", { name: "Beside the chat" }).click();
    await page.locator(".composer:visible textarea").click();
    await page.keyboard.press(`${mod}+KeyF`);
    await expect(page.getByRole("textbox", { name: "Find in this conversation" })).toBeFocused();
    await expect(bar).toHaveCount(0);
  });
});
