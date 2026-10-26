import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { helpers, installThisPlugin, testHost } from "./mirador.ts";

const { addWorkspace, callCanvasTool, signIn, startConversation, walkthroughView } = helpers;
const { TestHost, writeBunProgram } = testHost;

const host = new TestHost({ fakePrograms: true });
const ideaLog = join(host.root, "idea.log");

const serviceBefore = `export function serve(request) {
  const user = authenticate(request);
  return load(user);
}

function authenticate(request) {
  return request.user;
}

function load(user) {
  return { user, items: [] };
}
`;
const serviceAfter = serviceBefore.replace("const user = authenticate(request);", "const user = authenticate(request) ?? anonymous();");

function git(...args: string[]) {
  return execFileSync("git", ["-C", host.projectDir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
}

/** A checkout where the task changed service.ts, wrote items.ts and a gitignored build file, none of it committed yet. */
function createUncommittedWork() {
  mkdirSync(host.projectDir, { recursive: true });
  git("init", "-q", "-b", "main");
  writeFileSync(join(host.projectDir, ".gitignore"), "build/\n");
  writeFileSync(join(host.projectDir, "service.ts"), serviceBefore);
  git("add", ".");
  git("commit", "-q", "-m", "base");
  writeFileSync(join(host.projectDir, "service.ts"), serviceAfter);
  writeFileSync(join(host.projectDir, "items.ts"), "export function fetchItems(user) {\n  return [];\n}\n");
  mkdirSync(join(host.projectDir, "build"));
  writeFileSync(join(host.projectDir, "build", "routes.js"), "export const routes = ['/serve'];\n");
}

function writeFakeIdea() {
  writeBunProgram(host.fakeProgramsDir, "idea", join(import.meta.dirname, "fake-idea.ts"), { FAKE_IDEA_LOG: ideaLog });
}

const tour = (change: Record<string, unknown> = {}) => ({
  title: "How a request is served",
  folder: host.projectDir,
  summary: "serve() authenticates the request, then **loads the user's items**.",
  flow: [
    { title: "Request comes in", at: "service.ts:1-4", say: "serve() authenticates the request, then loads." },
    { title: "Routes are built", at: "build/routes.js:1", say: "The build lists the route." },
  ],
  ...change,
});

const canvasPane = (page: Page) => page.locator('[data-pane="canvas"]');

async function dragBy(page: Page, handle: Locator, deltaX: number, deltaY: number) {
  const box = (await handle.boundingBox())!;
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + deltaX, y + deltaY, { steps: 10 });
  await page.mouse.up();
}
const logLines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : []);

test.beforeAll(async () => {
  createUncommittedWork();
  writeFakeIdea();
  installThisPlugin(host);
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

test("a tour walks through the code as it is, or through what the task changed with the diff, and the user asks about its lines", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);
  const view = walkthroughView(page).locator(".review");

  await test.step("wrong anchors are all sent back to the agent, and nothing is shown", async () => {
    const result = await callCanvasTool(host, conversationId, "tour", tour({ flow: [{ title: "Nowhere", at: "service.ts:99", say: "?" }] }));
    expect(result).toContain("The tour was not shown");
    expect(result).toContain('flow step 1 ("Nowhere"): service.ts:99 is outside the file, which has 12 lines.');
    await expect(view).toHaveCount(0);
  });

  await test.step("a tour of the code as it is has no files, findings or verdict, and shows a file git ignores too", async () => {
    expect(await callCanvasTool(host, conversationId, "tour", tour())).toMatch(/^Shown to the user as tour .*: 2 flow steps\.$/);
    await expect(view.getByRole("tab")).toHaveText([/Overview/, /Flow/]);
    await expect(view.locator(".overview-story")).toContainText("loads the user's items");
    await expect(view.locator(".verdict")).toHaveCount(0);
    await view.getByRole("button", { name: "Routes are built" }).click();
    await expect(view.locator(".flow-step h3")).toHaveText("Routes are built");
    await expect(view.locator(".code-row.anchored")).toHaveText([/export const routes/]);
    await page.keyboard.press("ArrowLeft");
    await expect(view.locator(".flow-step h3")).toHaveText("Request comes in");
    await expect(view.locator(".code-row.anchored")).toHaveCount(4);
    await expect(view.locator(".code-row.added, .code-row.removed")).toHaveCount(0);
    await page.keyboard.press("o");
    await expect.poll(() => logLines(ideaLog).at(-1)).toMatch(/^--line 1 .*[\\/]service\.ts$/);
    await expect(view.locator(".review-keys")).not.toContainText("findings");
  });

  await test.step("in a wide view the steps and the explanation sit side by side, and the code takes the whole width below them", async () => {
    await page.keyboard.press("2");
    await view.getByRole("button", { name: "Full screen" }).click();
    await expect(canvasPane(page)).toHaveClass(/fullscreen/);
    const boxOf = async (locator: Locator) => (await locator.boundingBox())!;
    const [whole, steps, explanation, code] = await Promise.all([view, view.locator(".review-list"), view.locator(".flow-step-say"), view.locator(".flow-step .code-block")].map(boxOf));
    expect(whole.width).toBeGreaterThanOrEqual(900);
    expect(explanation.x, "the explanation is right of the steps").toBeGreaterThanOrEqual(steps.x + steps.width - 1);
    expect(code.y, "the code is below both").toBeGreaterThanOrEqual(Math.max(steps.y + steps.height, explanation.y + explanation.height) - 1);
    expect(code.x, "the code starts under the steps").toBeLessThan(steps.x + 20);
    expect(code.width).toBeGreaterThan(whole.width - 40);
    expect(code.height, "a short excerpt keeps its own height").toBeGreaterThan(100);
    const split = await boxOf(view.locator(".review-split"));
    expect(steps.height, "the steps take the top half, however short the explanation").toBeGreaterThan(split.height * 0.45);
  });

  await test.step("the dividers resize the steps' width and the height above the code, which stay after a reload, and a double click resets one", async () => {
    const steps = view.locator(".review-list");
    const before = (await steps.boundingBox())!;
    await dragBy(page, view.getByRole("separator", { name: "Resize the list" }), 150, 0);
    await dragBy(page, view.getByRole("separator", { name: "Resize the steps and the code" }), 0, 100);
    const dragged = (await steps.boundingBox())!;
    expect(dragged.width).toBeGreaterThan(before.width + 130);
    expect(dragged.height).toBeGreaterThan(before.height + 80);

    await page.reload();
    await view.getByRole("tab", { name: /Flow/ }).click();
    await expect.poll(async () => Math.abs((await steps.boundingBox())!.width - dragged.width)).toBeLessThan(3);
    await expect.poll(async () => Math.abs((await steps.boundingBox())!.height - dragged.height)).toBeLessThan(3);

    await view.getByRole("separator", { name: "Resize the steps and the code" }).dblclick();
    await expect.poll(async () => Math.abs((await steps.boundingBox())!.height - before.height)).toBeLessThan(3);
  });

  await test.step("a long list of steps scrolls within its half, and the code keeps its place below", async () => {
    const manySteps = Array.from({ length: 15 }, (_, index) => ({ title: `Step ${index + 1}`, at: "service.ts:1-4", say: "Short." }));
    await callCanvasTool(host, conversationId, "tour", tour({ flow: manySteps }));
    await view.getByRole("tab", { name: /Flow/ }).click();
    const steps = view.locator(".review-list");
    await expect(steps.getByRole("button")).toHaveCount(15);
    const [split, list, code] = await Promise.all([view.locator(".review-split"), steps, view.locator(".flow-step .code-block")].map(async (locator) => (await locator.boundingBox())!));
    expect(list.height / split.height).toBeGreaterThan(0.45);
    expect(list.height / split.height).toBeLessThan(0.55);
    expect(await steps.evaluate((element) => element.scrollHeight > element.clientHeight), "the steps scroll").toBe(true);
    expect((code.y - split.y) / split.height, "the code starts halfway down").toBeLessThan(0.56);
    await view.getByRole("button", { name: "Beside the chat" }).click();
  });

  await test.step("with since, the steps mark what changed and the Files tab shows the diff, in tour order, with the rest of a file as it was published, even after git gc", async () => {
    const result = await callCanvasTool(
      host,
      conversationId,
      "tour",
      tour({ since: "HEAD", flow: [{ title: "Request comes in", at: "service.ts:1-4", say: "Now falls back to anonymous." }, { title: "Items", at: "items.ts:1-3", say: "New." }] }),
    );
    expect(result).toMatch(/: 2 flow steps, 2 files changed since HEAD\.$/);
    writeFileSync(join(host.projectDir, "service.ts"), "rewritten after the tour\n");
    await expect(view.getByRole("tab")).toHaveText([/Overview/, /Flow/, /Files/]);
    await expect(view.locator(".review-stats")).toContainText("2 files changed");
    await expect(view.locator(".review-stats")).toContainText("since HEAD");
    await page.keyboard.press("2");
    await expect(view.locator(".code-row.added")).toHaveText([/authenticate\(request\) \?\? anonymous\(\);$/]);
    await expect(view.locator(".code-row.removed")).toHaveText([/const user = authenticate\(request\);$/]);
    await page.keyboard.press("3");
    await expect(view.locator(".review-list .file-name")).toHaveText(["service.ts", "items.ts"]);
    git("gc", "--quiet", "--prune=now");
    await view.getByRole("button", { name: "Show the rest of the file" }).click();
    await expect(view.locator(".code-block")).toContainText("return { user, items: [] };");
    await expect(view.locator(".code-block")).not.toContainText("rewritten after the tour");
  });

  await test.step("in a wide view the Files tab's list has the same divider, and the width the Flow tab's list was given", async () => {
    await view.getByRole("button", { name: "Full screen" }).click();
    await expect(view.getByRole("separator", { name: "Resize the list" })).toBeVisible();
    const files = (await view.locator(".review-list").boundingBox())!;
    await view.getByRole("tab", { name: /Flow/ }).click();
    const steps = (await view.locator(".review-list").boundingBox())!;
    expect(Math.abs(files.width - steps.width)).toBeLessThan(2);
    await view.getByRole("button", { name: "Beside the chat" }).click();
  });

  await test.step("selected lines go to the agent as a question about the tour, with no review to update", async () => {
    await page.keyboard.press("2");
    await view.locator(".code-row.added .line-number").click();
    await page.keyboard.press("a");
    const dialog = walkthroughView(page).getByRole("dialog", { name: "Ask the agent about these lines" });
    await expect(dialog.getByRole("button", { name: "Ask and update the review" })).toHaveCount(0);
    await dialog.locator("textarea").fill("Reply with just the word NOTED.");
    await dialog.locator("textarea").press("Enter");
    await expect(view.locator(".review-sent")).toContainText("Asked about service.ts:2");
    const asked = page.locator(".message.user").last();
    await expect(asked).toContainText('About service.ts:2 in the tour "How a request is served"');
    await expect(asked).toContainText("+  const user = authenticate(request) ?? anonymous();");
    await expect(asked).not.toContainText("update_review");
  });

  await test.step("with since, a checkout where core.safecrlf=true refuses to store a file with other line endings still gets its tour", async () => {
    git("config", "core.safecrlf", "true");
    writeFileSync(join(host.projectDir, ".gitattributes"), "* text=auto\n");
    writeFileSync(join(host.projectDir, "windows.ts"), "export const crlf = true;\r\n");

    const result = await callCanvasTool(host, conversationId, "tour", tour({ since: "HEAD", flow: [{ title: "Windows file", at: "windows.ts:1", say: "New, with CRLF." }] }));

    expect(result).toMatch(/, 4 files changed since HEAD\.$/);
    await expect(view.locator(".review-stats")).toContainText("4 files changed");
    await page.keyboard.press("3");
    await expect(view.locator(".review-list .file-name")).toContainText(["windows.ts"]);
  });
});
