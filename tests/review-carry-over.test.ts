import { describe, expect, test } from "bun:test";
import type { Review, ReviewFinding } from "../shared/review.ts";
import { carryOverChoices, isSameChange, reviewToCarryOverFrom } from "../host/review/carry-over.ts";

const finding = (id: number, path: string, line: number, title: string, change: Partial<ReviewFinding> = {}): ReviewFinding => ({
  id: `finding-${id}`,
  severity: "issue",
  checked: "plausible",
  at: { path, line, endLine: line },
  title,
  body: `About ${title}.`,
  excerpt: { startLine: line, lines: [] },
  decision: "keep",
  ...change,
});

const summary = ({ id, decision, body, agentBody, postedAs }: ReviewFinding) => ({ id, decision, body, agentBody, postedAs });

describe("carrying the user's choices over to a review published again", () => {
  test("a finding in the same file with the same title, or else the same lines, takes over the user's choice", () => {
    const earlier = [
      finding(1, "a.ts", 3, "Null check", { decision: "drop" }),
      finding(2, "a.ts", 9, "Naming", { decision: "drop" }),
      finding(3, "b.ts", 5, "Leak", { decision: "drop" }),
    ];
    const again = [finding(1, "a.ts", 4, "Null check"), finding(2, "a.ts", 9, "Name the flag"), finding(3, "c.ts", 5, "Leak"), finding(4, "a.ts", 20, "New")];
    expect(carryOverChoices(earlier, again).map(({ decision }) => decision)).toEqual(["drop", "drop", "keep", "keep"]);
  });

  test("each earlier finding is taken over once, a title match before a line match", () => {
    const earlier = [finding(1, "a.ts", 3, "First", { decision: "drop" }), finding(2, "a.ts", 3, "Second")];
    const again = [finding(1, "a.ts", 3, "Second"), finding(2, "a.ts", 3, "Third"), finding(3, "a.ts", 3, "Fourth")];
    expect(carryOverChoices(earlier, again).map(({ decision }) => decision)).toEqual(["keep", "drop", "keep"]);
  });

  test("a posted finding stays posted with the comment that is on the pull request, whatever the agent writes now", () => {
    const earlier = [finding(1, "a.ts", 3, "Leak", { body: "As posted.", postedAs: { threadId: "T1" } })];
    const [carried] = carryOverChoices(earlier, [finding(1, "a.ts", 3, "Leak", { body: "Reworded by the agent." })]);
    expect(summary(carried!)).toEqual({ id: "finding-1", decision: "keep", body: "As posted.", agentBody: undefined, postedAs: { threadId: "T1" } });
  });

  test("a finding posted to a pull request this review is not of carries the user's choice, but is not posted here", () => {
    const earlier = [finding(1, "a.ts", 3, "Leak", { decision: "drop", body: "As posted.", postedAs: { threadId: "T1" } })];
    const [carried] = carryOverChoices(earlier, [finding(1, "a.ts", 3, "Leak", { body: "About Leak." })], false);
    expect(summary(carried!)).toEqual({ id: "finding-1", decision: "drop", body: "About Leak.", agentBody: undefined, postedAs: undefined });
  });

  test("the user's wording stays while the agent writes what it wrote before, and gives way when the agent rewrites it", () => {
    const earlier = [finding(1, "a.ts", 3, "Leak", { body: "The user's words.", agentBody: "The agent's words." })];
    const [unchanged] = carryOverChoices(earlier, [finding(1, "a.ts", 3, "Leak", { body: "The agent's words." })]);
    expect(summary(unchanged!)).toMatchObject({ body: "The user's words.", agentBody: "The agent's words." });
    const [rewritten] = carryOverChoices(earlier, [finding(1, "a.ts", 3, "Leak", { body: "The agent's new words." })]);
    expect(summary(rewritten!)).toMatchObject({ body: "The agent's new words.", agentBody: undefined });
  });

  test("a review is of the same change when it is of the same pull request, or else of the same checkout and base", () => {
    const review = (repository: string, base: string, url?: string) =>
      ({ repository, base, pullRequest: url ? { url, host: "github.com", owner: "o", repo: "r", number: 1 } : null }) as Review;
    const pull = "https://github.com/o/r/pull/1";
    expect(isSameChange(review("/w1", "main", pull), review("/w2", "origin/main", pull))).toBe(true);
    expect(isSameChange(review("/w1", "main", pull), review("/w1", "main", "https://github.com/o/r/pull/2"))).toBe(false);
    expect(isSameChange(review("/w1", "main"), review("/w1", "main", pull))).toBe(true);
    expect(isSameChange(review("/w1", "main"), review("/w1", "develop"))).toBe(false);
  });

  test("a review of a pull request takes over from the latest review of that pull request, else from the latest of the same checkout and base", () => {
    const review = (title: string, url?: string) =>
      ({ title, repository: "/w1", base: "main", pullRequest: url ? { url, host: "github.com", owner: "o", repo: "r", number: 1 } : null }) as unknown as Review;
    const first = "https://github.com/o/r/pull/1";
    const second = "https://github.com/o/r/pull/2";
    const reviews = [review("pull 1", first), review("branch")];
    expect(reviewToCarryOverFrom(reviews, review("pull 1 again", first))).toBe(reviews[0]);
    expect(reviewToCarryOverFrom(reviews, review("pull 2", second))).toBe(reviews[1]);
    expect(reviewToCarryOverFrom(reviews, review("branch again"))).toBe(reviews[1]);
    expect(reviewToCarryOverFrom([], review("first review"))).toBeUndefined();
  });
});
