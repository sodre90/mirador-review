import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { helpers, installThisPlugin, testHost } from "./mirador.ts";

const { addWorkspace, callCanvasTool, openCanvasHistory, openSettings, primaryModifier, signIn, startConversation, waitForTurnToEnd, workspaceCard, walkthroughView } = helpers;
const { bunProgramPath, programOnRegistryPath, TestHost, writeBunProgram } = testHost;

const host = new TestHost({ fakePrograms: true });
const fakeProgramsDir = host.fakeProgramsDir;
const ghLog = join(host.root, "gh.log");
const ghAuthLog = join(host.root, "gh-auth.log");
const ghLoggedOut = join(host.root, "gh-logged-out");
const ghUnreachable = join(host.root, "gh-unreachable");
const ghThreads = join(host.root, "gh-review-threads.json");
const ideaLog = join(host.root, "idea.log");
const PULL_REQUEST = "https://ghe.example.com/team/shop/pull/7";
/** A question asked before the conversation's agent has started shows in the timeline once it has, which takes a while on a loaded Windows runner. */
const AGENT_START_TIMEOUT_MS = 120_000;

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
const serviceAfter = serviceBefore
  .replace("const user = authenticate(request);", "const user = authenticate(request) ?? anonymous();")
  .replace("return { user, items: [] };", "return { user, items: fetchItems(user) };");

function git(...args: string[]) {
  return execFileSync("git", ["-C", host.projectDir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
}

/** A branch that changes service.ts and adds items.ts, like a pull request would. */
function createChange() {
  mkdirSync(host.projectDir, { recursive: true });
  git("init", "-q", "-b", "main");
  writeFileSync(join(host.projectDir, "service.ts"), serviceBefore);
  git("add", ".");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(host.projectDir, "service.ts"), serviceAfter);
  writeFileSync(join(host.projectDir, "items.ts"), "export function fetchItems(user) {\n  return [];\n}\n");
  git("add", ".");
  git("commit", "-q", "-m", "fetch items");
  return git("rev-parse", "HEAD");
}

const comment = (id: number, author: string, body: string) => ({
  databaseId: id,
  url: `${PULL_REQUEST}#discussion_r${id}`,
  body,
  createdAt: "2026-10-01T10:00:00Z",
  author: { login: author },
});

/** Two conversations on pull 7: one the user may resolve, and an outdated one they may not. */
const conversations = {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "PRRT_1",
              path: "service.ts",
              line: 2,
              originalLine: 2,
              isOutdated: false,
              isResolved: false,
              viewerCanResolve: true,
              comments: { nodes: [comment(11, "reviewer", "Why the anonymous fallback?"), comment(12, "author", "Product asked for it; guarded below.")] },
            },
            {
              id: "PRRT_2",
              path: "items.ts",
              line: null,
              originalLine: 2,
              isOutdated: true,
              isResolved: false,
              viewerCanResolve: false,
              comments: { nodes: [comment(21, "reviewer", "Typo in fetchItems")] },
            },
          ],
        },
      },
    },
  },
};

/** gh and idea stand-ins that log how they were called; gh answers like GitHub for pull 7 of team/shop, where the user has a pending review on pendingReviewCommit, if given. */
function writeFakePrograms(head: string, pendingReviewCommit = "") {
  writeFileSync(ghThreads, JSON.stringify(conversations));
  writeBunProgram(fakeProgramsDir, "gh", join(import.meta.dirname, "fake-gh.ts"), {
    FAKE_GH_LOG: ghLog,
    FAKE_GH_AUTH_LOG: ghAuthLog,
    FAKE_GH_LOGGED_OUT: ghLoggedOut,
    FAKE_GH_UNREACHABLE: ghUnreachable,
    FAKE_GH_HEAD: head,
    FAKE_GH_PENDING_REVIEW_COMMIT: pendingReviewCommit,
    FAKE_GH_THREADS: ghThreads,
    FAKE_GH_PULL_REQUEST: PULL_REQUEST,
  });
  writeBunProgram(fakeProgramsDir, "idea", join(import.meta.dirname, "fake-idea.ts"), { FAKE_IDEA_LOG: ideaLog });
}

const review = (change: Record<string, unknown> = {}) => ({
  title: "PR 7: fetch items for the user",
  repository: host.projectDir,
  base: "main",
  pullRequest: PULL_REQUEST,
  verdict: "Request changes: the anonymous fallback skips authentication.",
  summary: [
    "serve() now **falls back to an anonymous user** and loads the user's items through the new `fetchItems`.",
    "",
    "| Our comment | Verdict |",
    "| --- | --- |",
    "| Exception naming | fixed — renamed `OrchestratorMinionRestartRequiredExceptionThrownWhenTheSaltKeyOfAMinionWasDeletedAndItNeverComesBack` |",
  ].join("\n"),
  flow: [
    { title: "Request comes in", at: "service.ts:1-4", say: "serve() authenticates the request, then loads." },
    { title: "Items are fetched", at: "items.ts:1-3", say: "fetchItems() returns the user's items; empty for now." },
  ],
  findings: [
    { severity: "blocker", checked: "confirmed", at: "service.ts:2", title: "Anonymous fallback", body: "Is an anonymous user allowed here?", evidence: "Traced every caller of serve()." },
    { severity: "nit", checked: "plausible", at: "service.ts:7", title: "Unchanged helper", body: "Could this read the header instead?" },
    { severity: "question", checked: "plausible", at: "items.ts:2", title: "Empty items", body: "Should this call the API?" },
  ],
  ...change,
});

const canvasPane = (page: Page) => page.locator('[data-pane="canvas"]');
const logLines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : []);

test.beforeAll(async () => {
  writeFakePrograms(createChange());
  installThisPlugin(host);
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

test("a review opens full screen; the user tours the flow, moves through changes and findings, asks about lines, curates and posts the findings", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);

  await test.step("wrong anchors are all sent back to the agent, and nothing is shown", async () => {
    const result = await callCanvasTool(host, conversationId, "review", review({ flow: [{ title: "Nowhere", at: "service.ts:99", say: "?" }] }));
    expect(result).toContain("The review was not shown");
    expect(result).toContain('flow step 1 ("Nowhere"): service.ts:99 is outside the file, which has 12 lines.');
    await expect(walkthroughView(page).locator(".review")).toHaveCount(0);
  });

  writeFileSync(ghLoggedOut, "");
  const result = await callCanvasTool(host, conversationId, "review", review());
  expect(result).toContain("2 changed files, 2 flow steps and 3 findings");
  expect(result).toContain("cannot be posted as line comments: finding 2");
  const view = walkthroughView(page).locator(".review");
  await expect(view.locator(".verdict")).toHaveText("Request changes: the anonymous fallback skips authentication.");
  await expect(canvasPane(page)).toHaveClass(/fullscreen/);

  await test.step("while gh is not logged in to the pull request's host, Post says what to run and waits until gh is checked again", async () => {
    const hint = view.locator(".github-cli-problem");
    const post = view.getByRole("button", { name: "Post 2 findings to the pull request" });
    await expect(hint).toContainText("Posting needs gh logged in to ghe.example.com");
    await expect(hint).toContainText("Run gh auth login --hostname ghe.example.com");
    await expect(post).toBeDisabled();
    expect(logLines(ghAuthLog)).toEqual(["auth status --hostname ghe.example.com"]);
    rmSync(ghLoggedOut);
    await hint.getByRole("button", { name: "Check again" }).click();
    await expect(hint).toHaveCount(0);
    await expect(post).toBeEnabled();
  });

  await test.step("a wide table in the summary stays in its column, its long code wrapped", async () => {
    const table = view.locator(".overview-story table");
    const rightEdge = async (locator: Locator) => {
      const box = (await locator.boundingBox())!;
      return box.x + box.width;
    };
    for (const mode of ["Beside the chat", "Full screen"]) {
      await view.getByRole("button", { name: mode }).click();
      expect(await rightEdge(table)).toBeLessThanOrEqual(await rightEdge(view.locator(".overview-story")));
      expect(await table.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
  });

  await test.step("a long verdict in the canvas bar gives way to the title and the bar's buttons", async () => {
    await view.getByRole("button", { name: "Beside the chat" }).click();
    const bar = canvasPane(page).locator(".canvas-header");
    const fullyShown = (locator: Locator) =>
      locator.evaluate((element) => {
        const text = document.createRange();
        text.selectNodeContents(element);
        return text.getBoundingClientRect().width <= element.getBoundingClientRect().width;
      });
    const rightEdge = async (locator: Locator) => {
      const box = (await locator.boundingBox())!;
      return box.x + box.width;
    };
    expect(await fullyShown(bar.locator(".canvas-title"))).toBe(true);
    expect(await rightEdge(bar.getByRole("button", { name: "Hide" }))).toBeLessThanOrEqual(await rightEdge(bar));
    await expect(bar.locator(".canvas-outcome")).toHaveText("Request changes");
    await expect(bar.locator(".canvas-outcome")).toHaveCSS("font-weight", "400");
    await view.getByRole("button", { name: "Full screen" }).click();
  });

  await test.step("the bar's button puts the review beside the chat and back", async () => {
    await view.getByRole("button", { name: "Beside the chat" }).click();
    await expect(canvasPane(page)).not.toHaveClass(/fullscreen/);
    await view.getByRole("button", { name: "Full screen" }).click();
    await expect(canvasPane(page)).toHaveClass(/fullscreen/);
  });

  await test.step("the flow tour steps through the code with the anchored lines marked", async () => {
    await view.getByRole("tab", { name: /Flow/ }).click();
    await expect(view.locator(".flow-step h3")).toHaveText("Request comes in");
    await expect(view.locator(".code-row.anchored")).toHaveCount(4);
    await expect(view.locator(".code-row.removed")).toHaveText([/const user = authenticate\(request\);$/]);
    await page.keyboard.press("o");
    await expect.poll(() => logLines(ideaLog).at(-1)).toMatch(/^--line 1 .*[\\/]service\.ts$/);
    await page.keyboard.press("ArrowRight");
    await expect(view.locator(".flow-step h3")).toHaveText("Items are fetched");
  });

  await test.step("files come in tour order, and n jumps to the next finding on its line in the diff", async () => {
    await page.keyboard.press("3");
    await expect(view.locator(".review-list .file-name")).toHaveText(["service.ts", "items.ts"]);
    await page.keyboard.press("n");
    await expect(view.locator(".finding.selected .finding-title")).toHaveText("Unchanged helper");
    await expect(view.locator(".findings-elsewhere .finding")).toHaveCount(1);
    await page.keyboard.press("p");
    await expect(view.locator(".finding.selected .finding-title")).toHaveText("Anonymous fallback");
    await expect(view.locator(".code-block .finding.selected")).toHaveCount(1);
  });

  await test.step("the lines the diff leaves out between two changes can be shown, and the code is highlighted", async () => {
    const between = view.locator(".hunk").nth(1).locator(".hunk-header");
    await expect(view.getByRole("button", { name: "Show the rest of the file" })).toBeVisible();
    await between.getByRole("button", { name: "Show 2 lines" }).click();
    await expect(view.locator(".hunk").first().getByRole("button", { name: /^Line [67]$/ })).toHaveCount(2);
    await expect(between.getByRole("button")).toHaveCount(0);
    await expect(view.getByRole("button", { name: "Show the rest of the file" })).toHaveCount(0);
    await expect(view.locator(".code-row .token.keyword").first()).toHaveText("export");
    await expect(view.locator(".code-block .finding", { hasText: "Unchanged helper" })).toBeVisible();
    await expect(view.locator(".findings-elsewhere")).toHaveCount(0);
    await page.keyboard.press("2");
    await expect(view.locator(".flow-step h3")).toBeVisible();
    await page.keyboard.press("3");
    await expect(view.locator(".hunk").first().getByRole("button", { name: /^Line [67]$/ })).toHaveCount(2);
  });

  await test.step("selected lines go to the agent as a question, with their code, and the primary key with Enter asks it to update the review too", async () => {
    const firstHunk = view.locator(".hunk").first();
    await firstHunk.locator(".code-row.added .line-number").click();
    await firstHunk.getByRole("button", { name: "Line 4", exact: true }).click({ modifiers: ["Shift"] });
    await expect(view.locator(".selection-label")).toHaveText("service.ts:2-4");
    await page.keyboard.press("o");
    await expect.poll(() => logLines(ideaLog).at(-1)).toMatch(/^--line 2 .*[\\/]service\.ts$/);
    await page.keyboard.press("a");
    const question = walkthroughView(page).getByRole("dialog", { name: "Ask the agent about these lines" }).locator("textarea");
    await expect(walkthroughView(page).getByRole("button", { name: "Ask and update the review" })).toBeDisabled();
    await question.fill("Reply with just the word NOTED.");
    await question.press(`${await primaryModifier(page)}+Enter`);
    await expect(view.locator(".review-sent")).toContainText("Asked about service.ts:2-4");
    await expect(view.locator(".review-sent")).toContainText("the agent updates the parts of the review it changes");
    await view.getByRole("button", { name: "Show the chat" }).click();
    await expect(canvasPane(page)).not.toHaveClass(/fullscreen/);
    const asked = page.locator(".message.user").last();
    await expect(asked).toContainText('About service.ts:2-4 in the review "PR 7: fetch items for the user"', { timeout: AGENT_START_TIMEOUT_MS });
    await expect(asked).toContainText("+  const user = authenticate(request) ?? anonymous();");
    await expect(asked).toContainText("change just those parts with the update_review tool");
    await waitForTurnToEnd(page);
  });

  await test.step("kept and edited findings on the diff go to a pending review; the one outside the diff stays", async () => {
    await view.getByRole("tab", { name: /Findings/ }).click();
    const finding = (title: string) => view.locator(".finding", { hasText: title });
    await expect(finding("Unchanged helper")).toContainText("Outside the pull request's diff");
    const footer = finding("Unchanged helper").locator("footer");
    const rightEdge = async (locator: Locator) => {
      const box = (await locator.boundingBox())!;
      return box.x + box.width;
    };
    expect(await rightEdge(footer) - (await rightEdge(footer.locator("button").last()))).toBeLessThan(2);
    await finding("Unchanged helper").getByRole("button", { name: "Kept" }).click();
    await expect(finding("Unchanged helper").getByRole("button", { name: "Dropped" })).toBeVisible();
    await expect(view.getByRole("tab", { name: /Findings/ }).locator(".tab-count")).toHaveText("2");
    await finding("Empty items").getByRole("button", { name: "Edit" }).click();
    await finding("Empty items").locator("textarea").fill("Should this call the items API?");
    await finding("Empty items").getByRole("button", { name: "Save" }).click();
    await expect(finding("Empty items")).toContainText("Should this call the items API?");

    await view.getByRole("button", { name: "Post 2 findings to the pull request" }).click();
    await expect(view.locator(".posted-note").first()).toContainText("2 findings are on your pending review");
    await expect(finding("Anonymous fallback")).toContainText("On the pull request");
    await expect(finding("Anonymous fallback").getByRole("button", { name: "Edit" })).toBeDisabled();
    const calls = logLines(ghLog);
    expect(calls.every((line) => line.startsWith("api --hostname ghe.example.com "))).toBe(true);
    const bodies = calls.flatMap((line) => (line.split("\t")[1] ? [JSON.parse(line.split("\t")[1]!)] : []));
    expect(bodies.map(({ variables }) => variables.input ?? variables)).toEqual([
      { owner: "team", repo: "shop", number: 7 },
      { pullRequestId: "PR_7", commitOID: git("rev-parse", "HEAD") },
      { pullRequestReviewId: "PRR_1", path: "service.ts", line: 2, side: "RIGHT", body: "Is an anonymous user allowed here?" },
      { pullRequestReviewId: "PRR_1", path: "items.ts", line: 2, side: "RIGHT", body: "Should this call the items API?" },
    ]);
  });

  await test.step("published again with a comment reworded, the review keeps what the user dropped and posted", async () => {
    const [fallback, helper, emptyItems] = review().findings;
    const again = await callCanvasTool(
      host,
      conversationId,
      "review",
      review({
        findings: [
          fallback,
          { ...helper, body: "Could this read the request header instead?" },
          emptyItems,
          { severity: "nit", checked: "plausible", at: "items.ts:1", title: "Return type", body: "Worth typing the items?" },
        ],
      }),
    );
    expect(again).toContain("Dropped by the user: finding 2.");
    expect(again).toContain("Already on the pull request as posted, so change those there: finding 1, finding 3.");
    await view.getByRole("tab", { name: /Findings/ }).click();
    const finding = (title: string) => view.locator(".finding", { hasText: title });
    await expect(finding("Unchanged helper")).toContainText("Could this read the request header instead?");
    await expect(finding("Unchanged helper").getByRole("button", { name: "Dropped" })).toBeVisible();
    await expect(finding("Empty items")).toContainText("Should this call the items API?");
    await expect(finding("Empty items")).toContainText("On the pull request");
    await expect(finding("Anonymous fallback")).toContainText("On the pull request");
    await expect(view.getByRole("button", { name: "Post 1 finding to the pull request" })).toBeVisible();
  });

  await test.step("with the code review plugin set to open reviews beside the chat, the next review leaves the chat in view", async () => {
    const settings = await openSettings(page, "Plugins");
    const codeReview = settings.getByRole("list", { name: "Plugins" }).getByRole("listitem").filter({ hasText: "Code review" });
    await codeReview.getByLabel("Open reviews").selectOption({ label: "In the canvas pane, beside the chat" });
    await settings.getByRole("button", { name: "Close" }).click();
    await callCanvasTool(host, conversationId, "review", review({ title: "Second look", pullRequest: undefined, findings: [] }));
    await expect(page.locator(".canvas-title")).toHaveText("Second look");
    await expect(view.locator(".verdict")).toBeVisible();
    await expect(canvasPane(page)).not.toHaveClass(/fullscreen/);
  });

  await test.step("Mirador keeps the setting, so a reloaded page still has it", async () => {
    await page.reload();
    const settings = await openSettings(page, "Plugins");
    const codeReview = settings.getByRole("list", { name: "Plugins" }).getByRole("listitem").filter({ hasText: "Code review" });
    await expect(codeReview.getByLabel("Open reviews")).toHaveValue("beside");
    await settings.getByRole("button", { name: "Close" }).click();
  });
});

test("a re-review answers the pull request's conversations; the user resolves one, rewords the other, and posts both as replies", async ({ page }) => {
  await signIn(page, host);
  const addProject = page.getByRole("button", { name: "+ Add a project directory" });
  await expect(addProject.or(workspaceCard(page, host.projectDir))).toBeVisible();
  if (await addProject.isVisible()) await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);
  const view = walkthroughView(page).locator(".review");

  await test.step("an answer to a conversation that is not on the pull request is sent back to the agent, and nothing is shown", async () => {
    const result = await callCanvasTool(host, conversationId, "review", review({ findings: [], answers: [{ conversation: `${PULL_REQUEST}#discussion_r99`, body: "?" }] }));
    expect(result).toContain(`answer 1: "${PULL_REQUEST}#discussion_r99" is not a conversation on ${PULL_REQUEST}`);
    await expect(view).toHaveCount(0);
  });

  const answers = [
    { conversation: `${PULL_REQUEST}#discussion_r12`, body: "Thanks, the guard below covers it.", resolve: true },
    { conversation: "PRRT_2", body: "Still there." },
  ];
  expect(await callCanvasTool(host, conversationId, "review", review({ findings: [], answers }))).toContain("2 answers to conversations");
  const fallback = view.locator(".answer", { hasText: "Why the anonymous fallback?" });
  const typo = view.locator(".answer", { hasText: "Typo in fetchItems" });

  await test.step("the overview lists the conversations answered; each shows its comments as GitHub has them, and the draft answer", async () => {
    await view.getByRole("button", { name: "Why the anonymous fallback?" }).click();
    await expect(view.getByRole("tab", { name: /Conversations/ })).toHaveAttribute("aria-selected", "true");
    await expect(fallback.locator(".conversation-comments li")).toHaveText([/^reviewer\s*Why the anonymous fallback\?$/, /^author\s*Product asked for it; guarded below\.$/]);
    await expect(fallback.locator(".answer-body")).toContainText("Thanks, the guard below covers it.");
    await expect(fallback.getByLabel("Resolve when posted (the agent suggests it)")).not.toBeChecked();
    await expect(typo.locator(".conversation-state")).toHaveText("Outdated");
    await expect(typo.locator(".anchor")).toHaveText("items.ts:2");
    await expect(typo.getByLabel("Resolve when posted")).toBeDisabled();
  });

  await test.step("the user resolves one and rewords the other; posting replies on the pending review and resolves the one", async () => {
    const callsBefore = logLines(ghLog).length;
    await fallback.getByLabel(/Resolve when posted/).click();
    await expect(fallback.getByLabel(/Resolve when posted/)).toBeChecked();
    await expect(view.locator(".post-panel")).toContainText("1 conversation is resolved as you post");
    await typo.getByRole("button", { name: "Edit" }).click();
    await typo.locator("textarea").fill("Still there, in fetchItems.");
    await typo.getByRole("button", { name: "Save" }).click();
    await view.getByRole("button", { name: "Post 2 answers to the pull request" }).click();
    await expect(fallback).toContainText("On your pending review, conversation resolved");
    await expect(typo).toContainText("On your pending review");
    await expect(view.locator(".posted-note")).toContainText("2 answers are on your pending review");
    const bodies = logLines(ghLog)
      .slice(callsBefore)
      .flatMap((line) => (line.split("\t")[1] ? [JSON.parse(line.split("\t")[1]!)] : []));
    expect(bodies.map(({ variables }) => variables.input ?? variables)).toEqual([
      { owner: "team", repo: "shop", number: 7 },
      { pullRequestId: "PR_7", commitOID: git("rev-parse", "HEAD") },
      { pullRequestReviewId: "PRR_1", pullRequestReviewThreadId: "PRRT_1", body: "Thanks, the guard below covers it." },
      { threadId: "PRRT_1" },
      { pullRequestReviewId: "PRR_1", pullRequestReviewThreadId: "PRRT_2", body: "Still there, in fetchItems." },
    ]);
  });
});

test("the agent rewords one comment in place: the user stays on the finding they were reading, and their choices stay", async ({ page }) => {
  await signIn(page, host);
  const addProject = page.getByRole("button", { name: "+ Add a project directory" });
  await expect(addProject.or(workspaceCard(page, host.projectDir))).toBeVisible();
  if (await addProject.isVisible()) await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);
  const view = walkthroughView(page).locator(".review");
  const finding = (title: string) => view.locator(".finding", { hasText: title });

  const published = await callCanvasTool(host, conversationId, "review", review());
  expect(published).toContain('call update_review with these ids: finding-1 "Anonymous fallback" at service.ts:2; finding-2 "Unchanged helper"');
  await view.getByRole("tab", { name: /Findings/ }).click();
  await finding("Unchanged helper").getByRole("button", { name: "Kept" }).click();
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await expect(view.locator(".finding.selected .finding-title")).toHaveText("Empty items");

  await test.step("a wrong id is sent back to the agent, and nothing changes", async () => {
    const result = await callCanvasTool(host, conversationId, "update_review", { findings: [{ id: "finding-9", body: "?" }] });
    expect(result).toContain("finding-9 is not one of this review's findings (finding-1, finding-2, finding-3).");
    await expect(finding("Empty items")).toContainText("Should this call the API?");
  });

  await test.step("only the reworded comment changes and flashes; the tab, the selection and the user's drop stay, and no new page is added", async () => {
    const result = await callCanvasTool(host, conversationId, "update_review", { findings: [{ id: "finding 3", body: "Call the items API?" }] });
    expect(result).toContain("updated finding-3 in place");
    await expect(finding("Empty items")).toContainText("Call the items API?");
    await expect(finding("Empty items")).toHaveClass(/agent-edited/);
    await expect(finding("Anonymous fallback")).not.toHaveClass(/agent-edited/);
    await expect(view.getByRole("tab", { name: /Findings/ })).toHaveAttribute("aria-selected", "true");
    await expect(view.locator(".finding.selected .finding-title")).toHaveText("Empty items");
    await expect(finding("Unchanged helper").getByRole("button", { name: "Dropped" })).toBeVisible();
    await expect(finding("Empty items")).not.toHaveClass(/agent-edited/);
    await expect((await openCanvasHistory(page)).locator(".history-entry")).toHaveCount(1);
  });

  await test.step("a finding the agent adds flashes as it appears, and a verdict changed out of sight flashes once, when its tab opens", async () => {
    const result = await callCanvasTool(host, conversationId, "update_review", {
      verdict: "Approve once fetchItems calls the items API.",
      addFindings: [{ severity: "nit", checked: "plausible", at: "items.ts:1", title: "Return type", body: "Worth typing the items?" }],
    });
    expect(result).toContain("updated verdict, finding-4 in place");
    await expect(finding("Return type")).toHaveClass(/agent-edited/);
    const verdict = view.locator(".verdict");
    await view.getByRole("tab", { name: /Overview/ }).click();
    await expect(verdict).toHaveText("Approve once fetchItems calls the items API.");
    await expect(verdict).toHaveClass(/agent-edited/);
    await expect(verdict).not.toHaveClass(/agent-edited/);
    await view.getByRole("tab", { name: /Findings/ }).click();
    await view.getByRole("tab", { name: /Overview/ }).click();
    await expect(verdict).toBeVisible();
    await page.waitForTimeout(200);
    await expect(verdict).not.toHaveClass(/agent-edited/);
    await view.getByRole("tab", { name: /Findings/ }).click();
  });

  await test.step("an open edit box takes the agent's rewording until the user types; then it keeps their draft and shows the agent's under it", async () => {
    const rewordTo = (body: string) => callCanvasTool(host, conversationId, "update_review", { findings: [{ id: "finding-3", body }] });
    await finding("Empty items").getByRole("button", { name: "Edit" }).click();
    const box = finding("Empty items").locator("textarea");
    await expect(box).toHaveValue("Call the items API?");
    await rewordTo("Should fetchItems call the items API?");
    await expect(box).toHaveValue("Should fetchItems call the items API?");
    await box.fill("Call the API here.");
    await rewordTo("Call the items API in fetchItems.");
    const reworded = finding("Empty items").locator(".agent-reworded");
    await expect(reworded).toContainText("The agent reworded this while you were editing");
    await expect(reworded).toContainText("Call the items API in fetchItems.");
    await expect(box).toHaveValue("Call the API here.");
    await reworded.getByRole("button", { name: "Use its wording" }).click();
    await expect(box).toHaveValue("Call the items API in fetchItems.");
    await expect(reworded).toHaveCount(0);
    await finding("Empty items").getByRole("button", { name: "Save" }).click();
    await expect(finding("Empty items")).toContainText("Call the items API in fetchItems.");
  });

  await test.step("asked from a finding, the question names it and quotes its comment as it now reads", async () => {
    await finding("Empty items").getByRole("button", { name: "Ask" }).click();
    const dialog = walkthroughView(page).getByRole("dialog", { name: "Ask the agent about these lines" });
    await expect(dialog).toContainText('Ask the agent about the finding "Empty items" at items.ts:2');
    await dialog.locator("textarea").fill("Reply with just the word NOTED.");
    await dialog.locator("textarea").press(`${await primaryModifier(page)}+Enter`);
    await expect(view.locator(".review-sent")).toContainText('Asked about the finding "Empty items" at items.ts:2');
    const asked = page.locator(".message.user").last();
    await expect(asked).toContainText('About finding-3 ("Empty items") at items.ts:2 in the review "PR 7: fetch items for the user"');
    await expect(asked).toContainText("Its comment now reads:");
    await expect(asked).toContainText("Call the items API in fetchItems.");
    await waitForTurnToEnd(page);
  });
});

test("each finding shows the number the agent knows it by, with a gap where one was taken out", async ({ page }) => {
  await signIn(page, host);
  const addProject = page.getByRole("button", { name: "+ Add a project directory" });
  await expect(addProject.or(workspaceCard(page, host.projectDir))).toBeVisible();
  if (await addProject.isVisible()) await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);
  const view = walkthroughView(page).locator(".review");
  await callCanvasTool(host, conversationId, "review", review());
  await callCanvasTool(host, conversationId, "update_review", {
    removeFindings: ["finding-2"],
    addFindings: [{ severity: "nit", checked: "plausible", at: "items.ts:1", title: "Return type", body: "Worth typing the items?" }],
  });
  const numbered = { "Anonymous fallback": "#1", "Empty items": "#3", "Return type": "#4" };

  await test.step("in the Findings tab", async () => {
    await view.getByRole("tab", { name: /Findings/ }).click();
    await expect(view.locator(".finding")).toHaveCount(3);
    for (const [title, number] of Object.entries(numbered)) await expect(view.locator(".finding", { hasText: title }).locator(".finding-number")).toHaveText(number);
    await expect(view.locator(".finding-number").first()).toHaveAttribute("data-hint", /finding 5 or finding-5, it means #5/);
  });

  await test.step("in the Overview's list", async () => {
    await view.getByRole("tab", { name: /Overview/ }).click();
    for (const [title, number] of Object.entries(numbered)) await expect(view.locator(".overview-findings li", { hasText: title }).locator(".finding-number")).toHaveText(number);
  });

  await test.step("on the diff in the Files tab", async () => {
    await view.getByRole("tab", { name: /Files/ }).click();
    await expect(view.locator(".finding", { hasText: "Anonymous fallback" }).locator(".finding-number")).toHaveText("#1");
  });
});

test("coming back to a review's conversation shows the review as the user left it: the tab, the selected finding and how far they scrolled", async ({ page }) => {
  await signIn(page, host);
  const addProject = page.getByRole("button", { name: "+ Add a project directory" });
  await expect(addProject.or(workspaceCard(page, host.projectDir))).toBeVisible();
  if (await addProject.isVisible()) await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);
  const view = walkthroughView(page).locator(".review");
  const findingsTab = view.getByRole("tab", { name: /Findings/ });
  const manyFindings = Array.from({ length: 12 }, (_, index) => ({
    severity: "nit",
    checked: "plausible",
    at: "items.ts:2",
    title: `Finding ${index + 1}`,
    body: "A comment long enough to take a few lines of the findings list.\n\n".repeat(4),
  }));
  await callCanvasTool(host, conversationId, "review", review({ title: "Many findings", findings: manyFindings }));
  await expect(findingsTab).toBeVisible();
  const besideTheChat = view.getByRole("button", { name: "Beside the chat" });
  if (await besideTheChat.isVisible()) await besideTheChat.click();

  await findingsTab.click();
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await expect(view.locator(".finding.selected .finding-title")).toHaveText("Finding 4");
  const findingsList = view.locator(".findings-view");
  const scrolledTo = await findingsList.evaluate((list) => {
    list.scrollTop = list.scrollHeight;
    return list.scrollTop;
  });
  expect(scrolledTo, "the findings are long enough to scroll").toBeGreaterThan(0);

  await test.step("switching to another tab and back keeps the findings where they were scrolled", async () => {
    await view.getByRole("tab", { name: /Files/ }).click();
    await findingsTab.click();
    await expect.poll(() => findingsList.evaluate((list) => list.scrollTop)).toBe(scrolledTo);
  });

  await startConversation(page);
  await expect(view).toHaveCount(0);
  await page.locator(`li[data-reorder-id="${conversationId}"]`).click();

  await expect(findingsTab).toHaveAttribute("aria-selected", "true");
  await expect(view.locator(".finding.selected .finding-title")).toHaveText("Finding 4");
  await expect.poll(() => findingsList.evaluate((list) => list.scrollTop)).toBe(scrolledTo);

  await test.step("a finding picked on the overview is shown, wherever the findings were left scrolled", async () => {
    await view.getByRole("tab", { name: /Overview/ }).click();
    await view.locator(".review-overview").getByRole("button", { name: "Finding 1", exact: true }).click();
    await expect(findingsTab).toHaveAttribute("aria-selected", "true");
    await expect(view.locator(".finding.selected .finding-title")).toHaveText("Finding 1");
    await expect(view.locator(".finding.selected")).toBeInViewport();
  });
});

const ghInstalledHere = () =>
  process.platform === "win32"
    ? programOnRegistryPath("gh") !== ""
    : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].some((directory) => existsSync(join(directory, "gh")));

test("with no gh on the machine, the Post panel says to install it, and Post waits until a check finds gh", async ({ page }) => {
  test.skip(ghInstalledHere(), "A real gh is installed here; the Linux test container has none.");
  await signIn(page, host);
  const addProject = page.getByRole("button", { name: "+ Add a project directory" });
  await expect(addProject.or(workspaceCard(page, host.projectDir))).toBeVisible();
  if (await addProject.isVisible()) await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);
  const view = walkthroughView(page).locator(".review");
  const hint = view.locator(".github-cli-problem");
  const post = view.getByRole("button", { name: "Post 2 findings to the pull request" });
  const fakeGh = bunProgramPath(fakeProgramsDir, "gh");
  const putAway = join(host.root, "gh-put-away");

  renameSync(fakeGh, putAway);
  try {
    await callCanvasTool(host, conversationId, "review", review());
    await expect(hint).toContainText("Posting needs the GitHub CLI, and no gh was found. Install it, then run gh auth login --hostname ghe.example.com.");
    await expect(hint.getByRole("link", { name: "Install it" })).toHaveAttribute("href", "https://cli.github.com");
    await expect(post).toBeDisabled();
  } finally {
    renameSync(putAway, fakeGh);
  }

  await hint.getByRole("button", { name: "Check again" }).click();
  await expect(hint).toHaveCount(0);
  await expect(post).toBeEnabled();
});

test("once the pull request moved on, every page showing the review says so in place of Post, and Review again asks the agent once", async ({ page }) => {
  rmSync(ghLoggedOut, { force: true });
  await signIn(page, host);
  const addProject = page.getByRole("button", { name: "+ Add a project directory" });
  await expect(addProject.or(workspaceCard(page, host.projectDir))).toBeVisible();
  if (await addProject.isVisible()) await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);
  await callCanvasTool(host, conversationId, "review", review());
  const otherPage = await page.context().newPage();
  await otherPage.goto(page.url());
  const reviewed = git("rev-parse", "HEAD");
  const pushed = "5c14edd6b1a2b3c4d5e6f708192a3b4c5d6e7f80";
  const postPanel = (showing: Page) => walkthroughView(showing).locator(".review .post-panel");

  writeFakePrograms(pushed);
  try {
    await postPanel(page).getByRole("button", { name: "Post 2 findings to the pull request" }).click();
    for (const showing of [page, otherPage]) {
      await expect(postPanel(showing)).toContainText(`The pull request has changed since the review: its head is 5c14edd6b1, the review is of ${reviewed.slice(0, 10)}.`);
      await expect(postPanel(showing).getByRole("link", { name: "See what changed" })).toHaveAttribute("href", `https://ghe.example.com/team/shop/compare/${reviewed}...${pushed}`);
      await expect(postPanel(showing).getByRole("button", { name: /^Post / })).toHaveCount(0);
    }

    await postPanel(otherPage).getByRole("button", { name: "Review again" }).click();
    for (const showing of [page, otherPage]) {
      await expect(postPanel(showing)).toContainText("The agent is asked to review it again.");
      await expect(postPanel(showing).getByRole("button", { name: "Review again" })).toHaveCount(0);
    }
    await expect(page.locator(".message.user").last()).toContainText(
      `The pull request ${PULL_REQUEST} changed since your review: its head is ${pushed}, your review is of ${reviewed}.`,
      { timeout: AGENT_START_TIMEOUT_MS },
    );
  } finally {
    writeFakePrograms(reviewed);
    await otherPage.close();
  }
});

test("a pending review the user started on another commit is named above Post with a link to it, and nothing is added to it", async ({ page }) => {
  rmSync(ghLoggedOut, { force: true });
  await signIn(page, host);
  const addProject = page.getByRole("button", { name: "+ Add a project directory" });
  await expect(addProject.or(workspaceCard(page, host.projectDir))).toBeVisible();
  if (await addProject.isVisible()) await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);
  await callCanvasTool(host, conversationId, "review", review());
  const reviewed = git("rev-parse", "HEAD");
  const postPanel = walkthroughView(page).locator(".review .post-panel");
  const post = postPanel.getByRole("button", { name: "Post 2 findings to the pull request" });
  const note = `Your pending review on the pull request was started on 0a1b2c3d4e, not on ${reviewed.slice(0, 10)}, the commit this review is of. Submit or discard it on GitHub, then post again.`;

  writeFakePrograms(reviewed, "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567");
  try {
    const calledBefore = logLines(ghLog).length;
    await post.click();
    await expect(postPanel).toContainText(note);
    await expect(postPanel.getByRole("link", { name: "Open your pending review" })).toHaveAttribute("href", `${PULL_REQUEST}#pullrequestreview-0`);
    await expect(post).toBeEnabled();
    expect(logLines(ghLog).slice(calledBefore).filter((line) => line.includes("addPullRequestReview"))).toEqual([]);
  } finally {
    writeFakePrograms(reviewed);
  }

  await test.step("once the user submitted or discarded it on GitHub, Post goes through and the note goes away", async () => {
    await post.click();
    await expect(postPanel.locator(".posted-note")).toContainText("2 findings are on your pending review");
    await expect(postPanel).not.toContainText(note);
  });
});

test("a post that fails as a whole says why above Post on every page showing the review, until a post goes through", async ({ page }) => {
  rmSync(ghLoggedOut, { force: true });
  await signIn(page, host);
  const addProject = page.getByRole("button", { name: "+ Add a project directory" });
  await expect(addProject.or(workspaceCard(page, host.projectDir))).toBeVisible();
  if (await addProject.isVisible()) await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);
  await callCanvasTool(host, conversationId, "review", review());
  const otherPage = await page.context().newPage();
  await otherPage.goto(page.url());
  const postPanel = (showing: Page) => walkthroughView(showing).locator(".review .post-panel");
  const post = postPanel(page).getByRole("button", { name: "Post 2 findings to the pull request" });

  writeFileSync(ghUnreachable, "");
  try {
    await post.click();
    for (const showing of [page, otherPage]) {
      await expect(postPanel(showing).getByRole("alert")).toHaveText("The last post failed: error connecting to ghe.example.com");
      await expect(postPanel(showing).getByRole("button", { name: "Post 2 findings to the pull request" })).toBeEnabled();
    }
    await expect(page.locator(".notice")).toHaveCount(0);
  } finally {
    rmSync(ghUnreachable, { force: true });
  }

  await post.click();
  for (const showing of [page, otherPage]) {
    await expect(postPanel(showing).locator(".posted-note")).toContainText("2 findings are on your pending review");
    await expect(postPanel(showing).getByRole("alert")).toHaveCount(0);
  }
  await otherPage.close();
});

test("a review with nothing to comment on says so on its Findings tab, with no Post panel", async ({ page }) => {
  await signIn(page, host);
  const addProject = page.getByRole("button", { name: "+ Add a project directory" });
  await expect(addProject.or(workspaceCard(page, host.projectDir))).toBeVisible();
  if (await addProject.isVisible()) await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);
  await callCanvasTool(host, conversationId, "review", review({ verdict: "Approve: a small, correct fix.", findings: [] }));
  const view = walkthroughView(page);
  await expect(canvasPane(page).locator(".canvas-header .canvas-outcome")).toHaveText("Approve");
  await view.getByRole("tab", { name: /Findings/ }).click();
  await expect(view.locator(".findings-view")).toContainText("The agent found nothing to comment on.");
  await expect(view.locator(".post-panel")).toHaveCount(0);
  await view.getByRole("tab", { name: /Overview/ }).click();
  await expect(view.locator(".verdict")).toHaveText("Approve: a small, correct fix.");
  await expect(view.locator(".post-panel")).toHaveCount(0);
});
