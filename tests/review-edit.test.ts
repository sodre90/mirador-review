import { describe, expect, test } from "bun:test";
import { applyReviewEdit, readEditAnchors, type ReviewEdit } from "../host/review/edit.ts";
import { ReviewProblems, snapshotReview } from "../host/review/snapshot.ts";
import type { Review, ReviewAnswer } from "../shared/review.ts";
import { gitRepository, reviewRequest } from "./review-repository.ts";

async function publishedReview() {
  const { directory } = gitRepository();
  return snapshotReview(
    reviewRequest(directory, {
      findings: [
        { severity: "nit", checked: "confirmed", at: "service.ts:2", title: "Magic number", body: "Name the 1?" },
        { severity: "issue", checked: "plausible", at: "service.ts:5-7", title: "Unused", body: "Is load() still needed?" },
      ],
    }),
  );
}

const edited = async (review: Review, edit: ReviewEdit) => applyReviewEdit(review, edit, await readEditAnchors(review, edit));

const problemsOf = (attempt: Promise<unknown>) => attempt.then(() => [], (error: ReviewProblems) => error.problems);

const answer = (change: Partial<ReviewAnswer> = {}): ReviewAnswer => ({
  id: "answer-1",
  threadId: "PRRT_1",
  path: "service.ts",
  line: 2,
  outdated: false,
  resolved: false,
  canResolve: true,
  comments: [],
  body: "Fixed in the next commit.",
  suggestsResolving: false,
  resolve: false,
  decision: "keep",
  ...change,
});

describe("applyReviewEdit", () => {
  test("rewords a finding in place, named either way the review tool wrote it: the user's keep or drop stays, and the agent's new wording replaces the user's", async () => {
    const review = await publishedReview();
    const [first, second] = review.findings;
    const curated = { ...review, findings: [{ ...first!, decision: "drop" as const, body: "Why 1?", agentBody: "Name the 1?" }, second!] };

    const { review: after, changed } = await edited(curated, { findings: [{ id: "finding 1", body: "Name it." }] });

    expect(after.findings[0]).toEqual({ ...first!, decision: "drop", body: "Name it." });
    expect(after.findings[1]).toEqual(second!);
    expect(changed).toEqual(["finding-1"]);
  });

  test("a finding the agent does not reword keeps the user's rewording", async () => {
    const review = await publishedReview();
    const curated = { ...review, findings: [{ ...review.findings[0]!, body: "Why 1?", agentBody: "Name the 1?" }, review.findings[1]!] };

    const { review: after } = await edited(curated, { findings: [{ id: "finding-1", severity: "issue" }] });

    expect(after.findings[0]).toMatchObject({ severity: "issue", body: "Why 1?", agentBody: "Name the 1?" });
  });

  test("moves a finding to other lines with their code, takes one out, and adds new ones under the next free id", async () => {
    const review = await publishedReview();

    const { review: after, changed, removed } = await edited(review, {
      removeFindings: ["finding-1"],
      findings: [{ id: "finding-2", at: "service.ts:1-2" }],
      addFindings: [{ severity: "question", checked: "plausible", at: "service.ts:6", title: "Why 1", body: "Why one?" }],
    });

    expect(after.findings.map(({ id }) => id)).toEqual(["finding-2", "finding-3"]);
    expect(after.findings[0]).toMatchObject({ at: { path: "service.ts", line: 1, endLine: 2 }, excerpt: { startLine: 1 } });
    expect(after.findings[0]!.excerpt.lines[1]).toBe("  return load() + 1;");
    expect(after.findings[1]).toMatchObject({ id: "finding-3", decision: "keep", at: { line: 6, endLine: 6 }, title: "Why 1" });
    expect(changed).toEqual(["finding-2", "finding-3"]);
    expect(removed).toEqual(["finding-1"]);
  });

  test("lists every wrong id, posted finding and wrong line at once, and changes nothing", async () => {
    const review = await publishedReview();
    const posted = { ...review, findings: [{ ...review.findings[0]!, postedAs: { threadId: "PRRT_9" } }, review.findings[1]!] };

    const problems = await problemsOf(
      edited(posted, {
        findings: [
          { id: "finding-1", body: "Shorter." },
          { id: "finding-9", body: "?" },
          { id: "finding-2", at: "service.ts:99" },
        ],
        removeFindings: ["finding-1"],
        answers: [{ id: "answer-1", body: "?" }],
      }),
    );

    expect(problems).toEqual([
      "finding-2: service.ts:99 is outside the file, which has 7 lines.",
      "finding-1 is already on the pull request; change it there.",
      "finding-9 is not one of this review's findings (finding-1, finding-2).",
      "finding-1 is already on the pull request; change it there.",
      "answer-1 is not one of this review's answers (it has none).",
    ]);
  });

  test("a finding added after the last one was taken out gets a new id, so earlier mentions of the old one never name it", async () => {
    const { review: withoutLast } = await edited(await publishedReview(), { removeFindings: ["finding-2"] });

    const { review: after } = await edited(withoutLast, { addFindings: [{ severity: "nit", checked: "plausible", at: "service.ts:6", title: "Why 1", body: "Why one?" }] });

    expect(after.findings.map(({ id }) => id)).toEqual(["finding-1", "finding-3"]);
  });

  test("a finding both changed and taken out in one call is a problem, so neither happens", async () => {
    const review = await publishedReview();

    const problems = await problemsOf(edited(review, { findings: [{ id: "finding-2", body: "Shorter." }], removeFindings: ["finding 2"] }));

    expect(problems).toEqual(["finding-2 is both changed and taken out; pick one."]);
  });

  test("replaces the verdict, the summary and the whole tour", async () => {
    const review = await publishedReview();

    const { review: after, changed } = await edited(review, {
      verdict: "Request changes.",
      summary: "Adds one, unnamed.",
      flow: [{ title: "Loading", at: "service.ts:5-7", say: "load() returns 1." }],
    });

    expect(after).toMatchObject({ verdict: "Request changes.", summary: "Adds one, unnamed.", flow: [{ title: "Loading", at: { line: 5, endLine: 7 }, say: "load() returns 1." }] });
    expect(after.flow[0]!.excerpt.startLine).toBe(1);
    expect(changed).toEqual(["verdict", "summary", "flow"]);
  });

  test("rewords an answer and changes whether it suggests resolving, keeping the user's go-ahead", async () => {
    const review = { ...(await publishedReview()), answers: [answer({ resolve: true, body: "Done.", agentBody: "Fixed in the next commit." })] };

    const { review: after, changed } = await edited(review, { answers: [{ id: "answer-1", body: "Fixed in abc123.", resolve: true }] });

    expect(after.answers![0]).toEqual(answer({ resolve: true, body: "Fixed in abc123.", suggestsResolving: true }));
    expect(changed).toEqual(["answer-1"]);
  });

  test("an edit that changes nothing is a problem", async () => {
    expect(await problemsOf(edited(await publishedReview(), { findings: [] }))).toEqual([expect.stringContaining("Nothing to change")]);
  });
});
