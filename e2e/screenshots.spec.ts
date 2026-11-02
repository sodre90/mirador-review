import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { helpers, installThisPlugin, testHost } from "./mirador.ts";

const { addWorkspace, callCanvasTool, signIn, startConversation, walkthroughView } = helpers;
const { TestHost } = testHost;

test.skip(process.env.MIRADOR_SCREENSHOTS !== "1", "set MIRADOR_SCREENSHOTS=1 to take the plugin's gallery screenshots");

const screenshots = process.env.SCREENSHOTS_DIR ?? join(import.meta.dirname, "..", "screenshots");
const host = new TestHost({ fakePrograms: true });

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "light", locale: "en-US" });

const checkoutBefore = `import { inventory, mail, orders, payments } from "./services";
import type { Card, Cart } from "./types";

export async function checkout(cart: Cart, card: Card) {
  const reservation = await inventory.reserve(cart.items);
  const payment = await payments.capture(card, cart.total);
  const order = await orders.create(cart, reservation, payment);
  await mail.sendConfirmation(order);
  return order;
}
`;

const checkoutAfter = `import { inventory, mail, orders, payments } from "./services";
import { withRetries } from "./retry";
import type { Card, Cart } from "./types";

export async function checkout(cart: Cart, card: Card) {
  const reservation = await inventory.reserve(cart.items);
  try {
    const payment = await withRetries(() => payments.capture(card, cart.total), { attempts: 3 });
    const order = await orders.create(cart, reservation, payment);
    await mail.sendConfirmation(order);
    return order;
  } catch (error) {
    await inventory.release(reservation);
    throw error;
  }
}
`;

const retry = `export async function withRetries<T>(run: () => Promise<T>, { attempts }: { attempts: number }): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
    }
  }
}
`;

function git(...args: string[]) {
  execFileSync("git", ["-C", host.projectDir, "-c", "user.name=Ada", "-c", "user.email=ada@example.com", "-c", "commit.gpgsign=false", ...args]);
}

function createBranchWithRetries() {
  mkdirSync(host.projectDir, { recursive: true });
  git("init", "-q", "-b", "main");
  writeFileSync(join(host.projectDir, "checkout.ts"), checkoutBefore);
  git("add", ".");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "retry-payments");
  writeFileSync(join(host.projectDir, "checkout.ts"), checkoutAfter);
  writeFileSync(join(host.projectDir, "retry.ts"), retry);
  git("add", ".");
  git("commit", "-q", "-m", "Retry payment capture");
}

const review = {
  title: "Retry payment capture",
  repository: "",
  base: "main",
  verdict: "Request changes: a retried capture can charge the card twice.",
  summary: [
    "`checkout()` now **retries `payments.capture` up to three times** with a growing pause, through the new `withRetries` helper. If anything fails, the inventory reservation is released.",
    "",
    "The retry is the risk: a capture that succeeded but timed out is charged again on the next attempt.",
  ].join("\n"),
  flow: [
    { title: "Checkout reserves stock, then captures payment", at: "checkout.ts:6-8", say: "The reservation is made first, and the capture now goes through `withRetries`." },
    { title: "The retry helper", at: "retry.ts:1-10", say: "Runs the call up to `attempts` times and waits 200, 400 ms between tries." },
    { title: "A failure gives the stock back", at: "checkout.ts:13-15", say: "Any error releases the reservation before it is rethrown." },
  ],
  findings: [
    {
      severity: "blocker",
      checked: "confirmed",
      at: "checkout.ts:8",
      title: "A timed-out capture can be charged twice",
      body: "`withRetries` repeats the call after any error, including a timeout where the payment provider did capture the card. Pass an idempotency key so a repeated capture returns the first result.",
      evidence: "payments.capture takes no idempotency key, and its timeouts are thrown as plain errors.",
    },
    {
      severity: "question",
      checked: "plausible",
      at: "retry.ts:7",
      title: "Every error is retried",
      body: "A declined card will be tried three times. Retry only network errors and 5xx responses.",
    },
    {
      severity: "nit",
      checked: "confirmed",
      at: "retry.ts:8",
      title: "Pause grows from 200 ms",
      body: "`100 * 2 ** attempt` starts at 200 ms because attempts begin at 1. Start from `attempt - 1` if 100 ms was meant.",
    },
  ],
};

const tour = {
  title: "How a checkout is paid",
  folder: "",
  since: "main",
  summary: "A checkout **reserves stock**, **captures the payment with retries**, then creates the order. Steps marked as changed are what this branch added.",
  flow: [
    { title: "Reserve the stock", at: "checkout.ts:6", say: "Nothing is charged until the items are reserved." },
    { title: "Capture the payment, retrying", at: "checkout.ts:8", say: "`withRetries` calls `payments.capture` up to three times." },
    { title: "Back off between tries", at: "retry.ts:1-10", say: "A failed attempt waits twice as long as the one before." },
    { title: "Release the stock on failure", at: "checkout.ts:13-15", say: "If anything above throws, the reservation is given back." },
  ],
};

async function showCanvas(page: Page, tool: string, args: Record<string, unknown>, conversationId: string) {
  await callCanvasTool(host, conversationId, tool, { ...args, ...(tool === "review" ? { repository: host.projectDir } : { folder: host.projectDir }) });
  const view = walkthroughView(page).locator(".review");
  await expect(view).toBeVisible();
  await page.mouse.move(0, 0);
  return view;
}

test.beforeAll(async () => {
  createBranchWithRetries();
  installThisPlugin(host);
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

test("the plugin's gallery screenshots", async ({ page }) => {
  mkdirSync(screenshots, { recursive: true });
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);
  const pane = page.locator('[data-pane="canvas"]');
  const save = (name: string) => pane.screenshot({ path: join(screenshots, `${name}.png`) });

  const reviewView = await showCanvas(page, "review", review, conversationId);

  await reviewView.getByRole("tab", { name: /Findings/ }).click();
  await expect(reviewView.locator(".code-row").first()).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1250 });
  await expect(reviewView.locator(".code-row").first()).toBeVisible();
  await page.mouse.move(0, 0);
  await save("review-findings");
  await page.setViewportSize({ width: 1440, height: 900 });

  const tourView = await showCanvas(page, "tour", tour, conversationId);
  await tourView.getByRole("button", { name: "Capture the payment, retrying" }).click();
  await expect(tourView.locator(".code-row.anchored").first()).toBeVisible();
  await save("tour-steps");
});
