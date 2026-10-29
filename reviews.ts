import * as z from "zod/v4";
import type { CanvasActionContext, CanvasPluginContext, CanvasTool, PluginItem, PluginItemType } from "./mirador/api.ts";
import { anchorLabel, answersOf, findingSeverities, isCommentable, verdictInBrief, type Review, type ReviewAnswer, type ReviewFinding } from "./shared/review.ts";
import type { WalkthroughAction } from "./shared/walkthrough-actions.ts";
import { answersToConversations } from "./host/review/answers.ts";
import { carryOverAnswerChoices, carryOverChoices, ofSamePullRequest, reviewToCarryOverFrom } from "./host/review/carry-over.ts";
import { applyReviewEdit, readEditAnchors, REVIEW_NOT_CHANGED, type ReviewEdit } from "./host/review/edit.ts";
import { gitHubCliProblemOn, PendingReviewOfOtherCommit, postPendingReview, PullRequestMovedOn, type GitHubCli } from "./host/review/github.ts";
import { allOrEveryProblem, ReviewProblems, snapshotReview, type ReviewRequest } from "./host/review/snapshot.ts";

const anchorSchema = (what: string) =>
  z.string().min(3).describe(`${what} Written "path:line" or "path:start-end": the path relative to the repository root, lines of the reviewed (new) version.`);

const flowStepSchema = z.object({
  title: z.string().min(1).describe('A few words, e.g. "Controller accepts the request".'),
  at: anchorSchema("Where this step happens; a range for a whole method. May be unchanged code the flow passes through."),
  say: z.string().min(1).describe("Markdown: what happens here and why it matters, in a few sentences."),
});

const findingSchema = z.object({
  severity: z
    .enum(findingSeverities)
    .describe("blocker: must change before merging; issue: should change; question: needs the author's answer; nit: optional polish."),
  checked: z.enum(["confirmed", "plausible"]).describe("confirmed: you verified it (ran, traced or tested it); plausible: suspected, not verified."),
  at: anchorSchema("The line(s) the comment is about. GitHub accepts comments only on changed lines and the 3 lines around them."),
  title: z.string().min(1).describe("A few words for the list of findings."),
  body: z
    .string()
    .min(1)
    .describe('Markdown: the comment as it would be posted on the pull request, addressed to the author. Write "finding 2", never a bare # and number.'),
  evidence: z.string().optional().describe("Markdown: how you checked it, for the user only; not posted."),
});

const reviewSchema = z.object({
  title: z.string().min(1).describe('What is reviewed, e.g. "PR 1234: retry stack creation" (never a bare # and number: GitHub links those to issues).'),
  repository: z.string().min(1).describe("Absolute path of the git checkout (e.g. a worktree) where the reviewed code is checked out."),
  base: z.string().min(1).describe("Git ref the change goes into, e.g. origin/master. The review covers base...head, like a pull request."),
  head: z.string().optional().describe("Git ref of the reviewed code; the checkout's HEAD by default. Only committed code is reviewed."),
  pullRequest: z
    .string()
    .optional()
    .describe("The pull request's URL, when reviewing one. The user can then post the findings they keep to it as a pending review."),
  verdict: z.string().min(1).describe("One sentence: approve, approve with nits, or request changes, and the main reason."),
  summary: z
    .string()
    .min(1)
    .describe("Markdown for the user (not the author): what the change does and how its code flows, in plain words, so they understand it fast."),
  flow: z
    .array(flowStepSchema)
    .describe("A guided tour of the change's code flow, in the order the code runs: the entry point first, then each place control or data goes."),
  findings: z.array(findingSchema),
  answers: z
    .array(
      z.object({
        conversation: z
          .string()
          .min(1)
          .describe("The conversation this answers: the URL of any of its comments (…/pull/123#discussion_r456, as gh shows them), or its thread id (PRRT_…)."),
        body: z.string().min(1).describe('Markdown: the reply as it would be posted in the conversation. Write "finding 2", never a bare # and number.'),
        resolve: z
          .boolean()
          .optional()
          .describe(
            "Suggest resolving the conversation with this answer, e.g. when the author fixed what it was about. The user decides; resolving shows on GitHub at once.",
          ),
      }),
    )
    .optional()
    .describe(
      "When reviewing a pull request again: your answers to conversations (review threads) already on it, such as the author's replies to earlier comments. They are shown with the conversation as GitHub has it; the user keeps, edits or drops each, and posts the kept ones as replies on their pending review.",
    ),
});

const reviewEditSchema = z.object({
  review: z.string().optional().describe("The review to change, by the id the review tool reported; the conversation's newest review by default."),
  verdict: z.string().min(1).optional().describe("A new verdict."),
  summary: z.string().min(1).optional().describe("A new summary."),
  flow: z.array(flowStepSchema).optional().describe("The whole tour again, in order, when any step of it changes: it replaces the tour."),
  findings: z
    .array(findingSchema.partial().extend({ id: z.string().min(1).describe('The finding to change, e.g. "finding-2".') }))
    .optional()
    .describe(
      "Changes to findings: only the fields you pass change, and the user's keep or drop stays. The body the user asked you about is the one they see now, their own rewording included; a body you pass replaces it. The author sees only the text as it stands, never an earlier version: write it whole, with no word of what it said before or what changed.",
    ),
  addFindings: z.array(findingSchema).optional().describe("New findings, added after the others."),
  removeFindings: z.array(z.string().min(1)).optional().describe('Findings to take out, by id, e.g. ["finding-3"].'),
  answers: z
    .array(
      z.object({
        id: z.string().min(1).describe('The answer to change, e.g. "answer-1".'),
        body: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Markdown: the reply as it would be posted in the conversation, replacing the earlier one. The author sees only the text as it stands, never an earlier version: write it whole, with no word of what it said before or what changed.",
          ),
        resolve: z.boolean().optional().describe("Whether you suggest resolving the conversation with this answer."),
      }),
    )
    .optional()
    .describe("Changes to answers to conversations, by id. To answer a conversation the review does not answer yet, publish the review again."),
});

type Curated = ReviewFinding | ReviewAnswer;

const findingName = ({ id }: Curated) => id.replace("-", " ");

/** A review published again for the same change took over the user's choices; what the agent should know of them. */
function describeCarriedChoices(curated: Curated[]) {
  const named = (matching: (each: Curated) => boolean) => curated.filter(matching).map(findingName).join(", ");
  const choices = [
    ["Dropped by the user", named((each) => each.decision === "drop")],
    ["Already on the pull request as posted, so change those there", named((each) => !!each.postedAs)],
    ["Reworded by the user, wording kept since you left these as before", named((each) => !each.postedAs && each.agentBody !== undefined)],
  ].filter(([, ids]) => ids);
  if (choices.length === 0) return "";
  return ` The user's choices on the earlier review of this change carry over to the matching findings and answers. ${choices.map(([choice, ids]) => `${choice}: ${ids}.`).join(" ")}`;
}

const notOnTheDiff = (review: Review, findings: ReviewFinding[]) =>
  findings
    .filter(
      (finding) =>
        !isCommentable(
          review.files.find((file) => file.path === finding.at.path),
          finding.at,
        ),
    )
    .map(findingName);

const cannotBePosted = (names: string[]) =>
  ` These are not on lines of the pull request's diff, so they cannot be posted as line comments: ${names.join(", ")}.`;

/** The ids update_review takes, with enough of each for the agent to tell them apart. */
function describeIds(review: Review) {
  const ids = [
    ...review.findings.map((finding) => `${finding.id} "${finding.title}" at ${anchorLabel(finding.at)}`),
    ...answersOf(review).map((answer) => `${answer.id} to the conversation on ${answer.path}${answer.line === null ? "" : `:${answer.line}`}`),
  ];
  return ids.length === 0 ? "" : ` To change parts of it later, call update_review with these ids: ${ids.join("; ")}.`;
}

function describeReview(itemId: string, review: Review) {
  const answers = answersOf(review);
  const answerCount = answers.length > 0 ? `, ${answers.length} answers to conversations` : "";
  const counts = `${review.files.length} changed files, ${review.flow.length} flow steps${answerCount} and ${review.findings.length} findings`;
  const outsideDiff = notOnTheDiff(review, review.findings);
  const posting = !review.pullRequest
    ? ""
    : outsideDiff.length === 0
      ? " Every finding is on a line the pull request's diff accepts comments on."
      : cannotBePosted(outsideDiff);
  return `Shown to the user as review ${itemId}: ${counts}.${posting}${describeCarriedChoices([...review.findings, ...answers])}${describeIds(review)}`;
}

function describeEdit(itemId: string, review: Review, changed: string[], removed: string[]) {
  const done = [changed.length > 0 && `updated ${changed.join(", ")}`, removed.length > 0 && `took out ${removed.join(", ")}`].filter(Boolean).join(" and ");
  const outsideDiff = review.pullRequest
    ? notOnTheDiff(
        review,
        review.findings.filter(({ id }) => changed.includes(id)),
      )
    : [];
  const posting = outsideDiff.length > 0 ? cannotBePosted(outsideDiff) : "";
  return `In review ${itemId}, ${done} in place; the user sees the change where they are in the review.${posting}`;
}

/** The pull request's url tells which review it is; the full head is what the agent fetches and reviews, as a stale checkout would make the same review again. */
export function reviewAgainRequest({ pullRequest, headCommit }: Review, newHead: string) {
  return [
    `The pull request ${pullRequest?.url} changed since your review: its head is ${newHead}, your review is of ${headCommit}.`,
    `Fetch the new head and review it again with ${newHead} as the review's head: keep the findings that still apply, drop the ones it fixed, and add new ones.`,
  ].join(" ");
}

type ReviewContext = CanvasPluginContext<Review>;

const reviewsIn = (context: ReviewContext) => context.items().filter(({ type }) => type === "review");

function reviewNamed(context: ReviewContext, itemId: string) {
  const item = reviewsIn(context).find(({ id }) => id === itemId);
  if (!item) throw new Error("Unknown review.");
  return item;
}

function reviewToEdit(context: ReviewContext, itemId: string | undefined) {
  const reviews = reviewsIn(context);
  const item = itemId === undefined ? reviews.at(-1) : reviews.find(({ id }) => id === itemId);
  if (item) return item;
  const problem =
    itemId === undefined
      ? "This conversation has no review to change; publish one with the review tool."
      : `review: ${itemId} is not a review in this conversation.`;
  throw new ReviewProblems([problem], REVIEW_NOT_CHANGED);
}

/** Changes the review as it is now, so a change made meanwhile stays. */
function changeReview(context: ReviewContext, itemId: string, change: Partial<Review>) {
  const { data } = reviewNamed(context, itemId);
  return context.change(itemId, { data: { ...data, ...change } });
}

export const reviewActionKinds = ["update-finding", "update-answer", "check-github-cli", "post", "review-again"] as const;

export type ReviewAction = Extract<WalkthroughAction, { kind: (typeof reviewActionKinds)[number] }>;

type FindingChange = Omit<Extract<WalkthroughAction, { kind: "update-finding" }>, "kind" | "findingId">;
type AnswerChange = Omit<Extract<WalkthroughAction, { kind: "update-answer" }>, "kind" | "answerId">;

function updateFinding(context: ReviewContext, { id, data: review }: PluginItem<Review>, findingId: string, change: FindingChange) {
  const finding = review.findings.find((each) => each.id === findingId);
  if (!finding) throw new Error("Unknown finding.");
  if (finding.postedAs) throw new Error("This finding is already on the pull request; change it there.");
  const body = change.body?.trim();
  const reworded = body && body !== finding.body && { body, agentBody: finding.agentBody ?? finding.body };
  const changed = { ...finding, ...(change.decision && { decision: change.decision }), ...reworded };
  changeReview(context, id, { findings: review.findings.map((each) => (each.id === findingId ? changed : each)) });
}

function updateAnswer(context: ReviewContext, { id, data: review }: PluginItem<Review>, answerId: string, change: AnswerChange) {
  const answer = answersOf(review).find((each) => each.id === answerId);
  if (!answer) throw new Error("Unknown answer.");
  if (answer.postedAs) throw new Error("This answer is already on the pull request; change it there.");
  if (change.resolve && !answer.canResolve) throw new Error("GitHub does not let you resolve this conversation.");
  const body = change.body?.trim();
  const reworded = body && body !== answer.body && { body, agentBody: answer.agentBody ?? answer.body };
  const changed = {
    ...answer,
    ...(change.decision && { decision: change.decision }),
    ...(change.resolve !== undefined && { resolve: change.resolve }),
    ...reworded,
  };
  changeReview(context, id, { answers: answersOf(review).map((each) => (each.id === answerId ? changed : each)) });
}

/** The review says so where Post was, for every page showing it; a head it already knew of keeps whether the agent was asked. */
function notePullRequestMovedOn(context: ReviewContext, itemId: string, headCommit: string) {
  if (reviewNamed(context, itemId).data.pullRequestMovedOn?.headCommit === headCommit) return;
  changeReview(context, itemId, { pullRequestMovedOn: { headCommit, askedToReviewAgain: false } });
}

/** Asks the agent, once its turn is over, to review the pull request again from the head it moved on to; once per head. */
async function reviewAgain(context: CanvasActionContext<Review>, { id, data: review }: PluginItem<Review>) {
  const movedOn = review.pullRequestMovedOn;
  if (!movedOn || movedOn.askedToReviewAgain) return;
  changeReview(context, id, { pullRequestMovedOn: { ...movedOn, askedToReviewAgain: true } });
  try {
    await context.prompt(reviewAgainRequest(review, movedOn.headCommit), { afterTurn: true });
  } catch (error) {
    changeReview(context, id, { pullRequestMovedOn: movedOn });
    throw error;
  }
}

/**
 * Mirador's code reviews: the agent's review of a change, which the user curates and posts to the pull request with gh.
 * What runs gh is given, so tests can stand in for it.
 */
export function codeReviews(gh: GitHubCli) {
  const beingPosted = new Set<string>();

  /** Adds the kept findings and answers to the user's pending review on the pull request; each records how that went. */
  async function post(context: ReviewContext, itemId: string) {
    beingPosted.add(itemId);
    try {
      const { data: review } = changeReview(context, itemId, { posting: true, postFailure: undefined });
      const outcome = await postPendingReview(review, gh);
      const latest = reviewNamed(context, itemId).data;
      const findings = latest.findings.map((finding) => {
        const threadId = outcome.threadIds.get(finding.id);
        if (threadId) return { ...finding, postedAs: { threadId }, postError: undefined };
        const postError = outcome.errors.get(finding.id);
        return postError ? { ...finding, postError } : finding;
      });
      const answers = answersOf(latest).map((answer) => {
        const url = outcome.answerUrls.get(answer.id);
        const postError = outcome.errors.get(answer.id);
        const resolved = answer.resolved || outcome.resolvedAnswerIds.has(answer.id);
        return url ? { ...answer, postedAs: { url }, resolved, postError } : postError ? { ...answer, postError } : answer;
      });
      changeReview(context, itemId, {
        findings,
        answers,
        pendingReviewUrl: outcome.pendingReviewUrl,
        pullRequestMovedOn: undefined,
        pendingReviewOfOtherCommit: undefined,
      });
    } catch (error) {
      if (error instanceof PullRequestMovedOn) notePullRequestMovedOn(context, itemId, error.headCommit);
      else if (error instanceof PendingReviewOfOtherCommit) changeReview(context, itemId, { pendingReviewOfOtherCommit: error.pendingReview });
      else changeReview(context, itemId, { postFailure: error instanceof Error ? error.message : String(error) });
    } finally {
      beingPosted.delete(itemId);
      changeReview(context, itemId, { posting: false });
    }
  }

  /**
   * Answers the view once posting starts, however long GitHub takes; every page showing the review follows the post
   * through the review's own changes, a failure included.
   */
  function startPosting(context: ReviewContext, itemId: string) {
    reviewNamed(context, itemId);
    if (beingPosted.has(itemId)) return;
    void post(context, itemId).catch((error) => console.error(`${new Date().toISOString()} posting review ${itemId} failed:`, error));
  }

  const reviewType: PluginItemType<Review> = {
    icon: "⇄",
    placement: "page",
    outcome: (review) => (review.verdict ? verdictInBrief(review.verdict) : undefined),
    opensWithRoom: { setting: "open-reviews" },
    /** A host that stopped while posting a review left it marked as posting; a client may still hold it so. */
    listed: ({ id, data: review }) => (review.posting && !beingPosted.has(id) ? { ...review, posting: false } : review),
  };

  const reviewTool: CanvasTool<Review> = {
    description:
      "Publish a code review to the user's canvas as an interactive review: a summary, a guided tour of the code flow, the diff (taken from git, so do not paste code), and your findings on the lines they are about. The user can ask you about any lines, keep or drop findings, and post the kept ones to the pull request. When reviewing a pull request again, also answer its existing conversations (answers). Publishing the same change again keeps the user's choices on findings with the same file and title or lines, and on answers to the same conversation. Anchors and conversations are checked; if any are wrong, nothing is shown and the result lists them all. To change parts of a review already shown, use update_review instead.",
    input: z.toJSONSchema(reviewSchema, { io: "input" }),
    onDemand: true,
    async run(input, context) {
      const request = input as ReviewRequest;
      const [snapshot, answers] = await allOrEveryProblem(snapshotReview(request), answersToConversations(request, gh));
      const earlier = reviewToCarryOverFrom(
        reviewsIn(context).map(({ data }) => data),
        snapshot,
      );
      const review = earlier
        ? {
            ...snapshot,
            findings: carryOverChoices(earlier.findings, snapshot.findings, ofSamePullRequest(earlier, snapshot)),
            answers: carryOverAnswerChoices(answersOf(earlier), answers),
          }
        : { ...snapshot, answers };
      const { id } = context.publish({ type: "review", title: request.title, data: review });
      return describeReview(id, review);
    },
  };

  const updateReviewTool: CanvasTool<Review> = {
    description:
      "Change parts of a review already on the canvas, in place: reword, move, add or take out findings, change answers, the tour, the summary or the verdict. Only what you pass changes; the user keeps their place in the review and their choices on everything else. Name findings and answers by the ids the review tool reported (finding-2, answer-1). Publish the whole review again with review only when the code under review changed. The author of the change never sees earlier versions of a finding or answer, so a new body stands on its own: never refer to what it said before, as in \"updated\", \"as noted earlier\" or \"on second look\".",
    input: z.toJSONSchema(reviewEditSchema, { io: "input" }),
    onDemand: true,
    /** The edit is applied to the review as it is once git has been read, so a choice the user made meanwhile stays. */
    async run(input, context) {
      const edit = input as ReviewEdit & { review?: string };
      const target = reviewToEdit(context, edit.review);
      const anchors = await readEditAnchors(target.data, edit);
      const { review, changed, removed } = applyReviewEdit(reviewNamed(context, target.id).data, edit, anchors);
      const item = context.change(target.id, { data: { ...review, agentEdit: { at: Date.now(), parts: changed } } });
      return describeEdit(item.id, item.data, changed, removed);
    },
  };

  /** The user's action in a review's view, of those only a review takes. */
  function act(item: PluginItem<Review>, action: ReviewAction, context: CanvasActionContext<Review>) {
    switch (action.kind) {
      case "update-finding": {
        const { kind: _, findingId, ...change } = action;
        return updateFinding(context, item, findingId, change);
      }
      case "update-answer": {
        const { kind: _, answerId, ...change } = action;
        return updateAnswer(context, item, answerId, change);
      }
      case "check-github-cli":
        return item.data.pullRequest ? gitHubCliProblemOn(item.data.pullRequest.host).catch(() => null) : null;
      case "post":
        return startPosting(context, item.id);
      case "review-again":
        return reviewAgain(context, item);
    }
  }

  return {
    type: reviewType,
    tools: { review: reviewTool, update_review: updateReviewTool },
    guidance:
      "- review: when you review code changes (a pull request or a branch), publish the review with this tool rather than show. The user reads it as a guided tour of the code flow, the diff with your findings on it, and posts the findings they keep to the pull request.\n- update_review: to change parts of a review already shown (reword a finding, add or take one out, a new verdict), change just those parts with this tool; the user keeps their place in the review. Publish the whole review again only when the code under review changed.",
    act,
  };
}
