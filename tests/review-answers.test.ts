import { describe, expect, test } from "bun:test";
import type { Review, ReviewAnswer } from "../shared/review.ts";
import { answersToConversations } from "../host/review/answers.ts";
import { carryOverAnswerChoices } from "../host/review/carry-over.ts";
import { conversationNamed, fetchConversations, parsePullRequestUrl, postPendingReview, type GitHubCli } from "../host/review/github.ts";
import { allOrEveryProblem, ReviewProblems, type ReviewRequest } from "../host/review/snapshot.ts";

const PULL_REQUEST = "https://ghe.example.com/team/repo/pull/5";

const thread = (id: string, commentIds: number[], change: object = {}) => ({
  id,
  path: "src/app.ts",
  line: 4,
  originalLine: 3,
  isOutdated: false,
  isResolved: false,
  viewerCanResolve: true,
  comments: {
    nodes: commentIds.map((commentId, index) => ({
      databaseId: commentId,
      url: `${PULL_REQUEST}#discussion_r${commentId}`,
      body: `Comment ${commentId}`,
      createdAt: "2026-10-01T10:00:00Z",
      author: index === 0 ? { login: "reviewer" } : null,
    })),
  },
  ...change,
});

/** GitHub with two pages of conversations on pull 5. */
function gitHubWithConversations() {
  const queries: any[] = [];
  const pages: Record<string, object> = {
    first: { pageInfo: { hasNextPage: true, endCursor: "page-2" }, nodes: [thread("PRRT_a", [101, 102])] },
    "page-2": { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [thread("PRRT_b", [201], { line: null, isOutdated: true, isResolved: true, viewerCanResolve: false })] },
  };
  const gh: GitHubCli = async (args, body: any) => {
    queries.push({ args, variables: body.variables });
    return { data: { repository: { pullRequest: { reviewThreads: pages[body.variables.after ?? "first"] } } } };
  };
  return { gh, queries };
}

const request = (answers: ReviewRequest["answers"]): ReviewRequest => ({
  title: "PR",
  repository: "/repo",
  base: "main",
  pullRequest: PULL_REQUEST,
  verdict: "",
  summary: "",
  flow: [],
  findings: [],
  answers,
});

describe("the pull request's conversations", () => {
  test("are read page by page, each with its comments, and an outdated one at the line it was on", async () => {
    const { gh, queries } = gitHubWithConversations();
    const conversations = await fetchConversations(parsePullRequestUrl(PULL_REQUEST), gh);
    expect(queries.map(({ args, variables }) => [args.join(" "), variables.after])).toEqual([
      ["api --hostname ghe.example.com graphql", null],
      ["api --hostname ghe.example.com graphql", "page-2"],
    ]);
    expect(conversations.map(({ threadId, line, outdated, resolved, canResolve, commentIds }) => ({ threadId, line, outdated, resolved, canResolve, commentIds }))).toEqual([
      { threadId: "PRRT_a", line: 4, outdated: false, resolved: false, canResolve: true, commentIds: [101, 102] },
      { threadId: "PRRT_b", line: 3, outdated: true, resolved: true, canResolve: false, commentIds: [201] },
    ]);
    expect(conversations[0]!.comments.map(({ author, body }) => [author, body])).toEqual([
      ["reviewer", "Comment 101"],
      ["ghost", "Comment 102"],
    ]);
  });

  test("are named by the URL or id of any of their comments, or by their thread id", async () => {
    const conversations = await fetchConversations(parsePullRequestUrl(PULL_REQUEST), gitHubWithConversations().gh);
    const named = (name: string) => conversationNamed(conversations, name)?.threadId;
    expect(named(`${PULL_REQUEST}#discussion_r102`)).toBe("PRRT_a");
    expect(named("https://ghe.example.com/api/v3/repos/team/repo/pulls/comments/201")).toBe("PRRT_b");
    expect(named(" 101 ")).toBe("PRRT_a");
    expect(named("PRRT_b")).toBe("PRRT_b");
    expect(named(`${PULL_REQUEST}#discussion_r999`)).toBeUndefined();
  });
});

describe("answers to conversations", () => {
  test("are shown with their conversation as GitHub has it, kept, and not resolved until the user says so", async () => {
    const answers = await answersToConversations(request([{ conversation: `${PULL_REQUEST}#discussion_r102`, body: "Fixed, thanks.", resolve: true }]), gitHubWithConversations().gh);
    expect(answers).toEqual([
      expect.objectContaining({ id: "answer-1", threadId: "PRRT_a", body: "Fixed, thanks.", suggestsResolving: true, resolve: false, decision: "keep" }),
    ]);
    expect(answers[0]!.comments).toHaveLength(2);
    expect(answers[0]).not.toHaveProperty("commentIds");
  });

  test("list every conversation that is not on the pull request, and a second answer to the same one, at once", async () => {
    const answering = request([
      { conversation: "PRRT_a", body: "One." },
      { conversation: "https://ghe.example.com/team/repo/pull/5#discussion_r999", body: "Two." },
      { conversation: "101", body: "Three." },
    ]);
    const problems = await answersToConversations(answering, gitHubWithConversations().gh).catch((error) => error.problems);
    expect(problems).toEqual([expect.stringMatching(/^answer 2: .* is not a conversation on/), expect.stringMatching(/^answer 3: an earlier answer is already for this conversation/)]);
  });

  test("come back with the review's other problems in one go", async () => {
    const failing = (problem: string) => Promise.reject(new ReviewProblems([problem]));
    expect(await allOrEveryProblem(failing("a wrong anchor"), failing("a wrong conversation")).catch((error) => error.problems)).toEqual([
      "a wrong anchor",
      "a wrong conversation",
    ]);
    expect(await allOrEveryProblem(Promise.resolve(1), Promise.resolve(2))).toEqual([1, 2]);
  });

  test("need a pull request, and none means no question to GitHub", async () => {
    const { gh, queries } = gitHubWithConversations();
    expect(await answersToConversations(request([]), gh)).toEqual([]);
    const withoutPullRequest = { ...request([{ conversation: "PRRT_a", body: "x" }]), pullRequest: undefined };
    const problems = await answersToConversations(withoutPullRequest, gh).catch((error) => error.problems);
    expect(problems).toEqual([expect.stringContaining("only a review of a pull request can answer")]);
    expect(queries).toHaveLength(0);
  });
});

describe("posting answers", () => {
  const answer = (id: string, change: Partial<ReviewAnswer> = {}): ReviewAnswer => ({
    id,
    threadId: `PRRT_${id}`,
    path: "src/app.ts",
    line: 4,
    outdated: false,
    resolved: false,
    canResolve: true,
    comments: [],
    body: `Reply ${id}`,
    suggestsResolving: false,
    resolve: false,
    decision: "keep",
    ...change,
  });

  const reviewWith = (answers: ReviewAnswer[]) =>
    ({ headCommit: "abc", pullRequest: parsePullRequestUrl(PULL_REQUEST), findings: [], answers, files: [] }) as unknown as Review;

  function fakeGitHub(refuse: { reply?: string; resolve?: string } = {}) {
    const mutations: { name: string; input: any }[] = [];
    const gh: GitHubCli = async (args, body: any) => {
      const endpoint = args[3]!;
      if (endpoint === "repos/team/repo/pulls/5") return { node_id: "PR_node", head: { sha: "abc" } };
      if (body.query.includes("states: PENDING")) return { data: { repository: { pullRequest: { reviews: { nodes: [{ id: "PRR_mine", url: "https://ghe.example.com/review/mine" }] } } } } };
      const name = /\{ (\w+)\(input/.exec(body.query)![1]!;
      const input = body.variables.input;
      mutations.push({ name, input });
      const threadId = input.pullRequestReviewThreadId ?? input.threadId;
      if (name === "addPullRequestReviewThreadReply" && threadId === refuse.reply) return { errors: [{ message: "Thread is locked" }] };
      if (name === "resolveReviewThread" && threadId === refuse.resolve) return { errors: [{ message: "Not allowed" }] };
      if (name === "resolveReviewThread") return { data: { resolveReviewThread: { thread: { isResolved: true } } } };
      return { data: { addPullRequestReviewThreadReply: { comment: { url: `${PULL_REQUEST}#discussion_r-${threadId}` } } } };
    };
    return { gh, mutations };
  }

  test("adds each kept answer as a reply on the pending review, then resolves the conversations the user chose to", async () => {
    const { gh, mutations } = fakeGitHub();
    const review = reviewWith([
      answer("one", { resolve: true }),
      answer("two", { decision: "drop" }),
      answer("three", { postedAs: { url: "posted" } }),
      answer("four", { resolve: true, resolved: true }),
    ]);
    const outcome = await postPendingReview(review, gh);
    expect(mutations).toEqual([
      { name: "addPullRequestReviewThreadReply", input: { pullRequestReviewId: "PRR_mine", pullRequestReviewThreadId: "PRRT_one", body: "Reply one" } },
      { name: "resolveReviewThread", input: { threadId: "PRRT_one" } },
      { name: "addPullRequestReviewThreadReply", input: { pullRequestReviewId: "PRR_mine", pullRequestReviewThreadId: "PRRT_four", body: "Reply four" } },
    ]);
    expect([...outcome.answerUrls.keys()]).toEqual(["one", "four"]);
    expect([...outcome.resolvedAnswerIds]).toEqual(["one"]);
  });

  test("leaves a conversation open when GitHub refuses its reply, and says so when only the resolving failed", async () => {
    const { gh, mutations } = fakeGitHub({ reply: "PRRT_one", resolve: "PRRT_two" });
    const outcome = await postPendingReview(reviewWith([answer("one", { resolve: true }), answer("two", { resolve: true })]), gh);
    expect(mutations.map(({ name }) => name)).toEqual(["addPullRequestReviewThreadReply", "addPullRequestReviewThreadReply", "resolveReviewThread"]);
    expect(outcome.errors.get("one")).toBe("Thread is locked");
    expect(outcome.answerUrls.has("two")).toBe(true);
    expect(outcome.errors.get("two")).toBe("The answer is on your pending review, but the conversation was not resolved: Not allowed");
  });

  test("published again, an answer to the same conversation keeps what the user did with it", () => {
    const earlier = [
      answer("1", { threadId: "PRRT_x", decision: "drop", resolve: true }),
      answer("2", { threadId: "PRRT_y", body: "As posted.", postedAs: { url: "u" } }),
      answer("3", { threadId: "PRRT_z", body: "The user's words.", agentBody: "Reply 1" }),
    ];
    const again = [answer("1", { threadId: "PRRT_y" }), answer("2", { threadId: "PRRT_x" }), answer("3", { threadId: "PRRT_z", body: "Reply 1" }), answer("4", { threadId: "PRRT_new" })];
    expect(carryOverAnswerChoices(earlier, again).map(({ id, decision, resolve, body, postedAs }) => ({ id, decision, resolve, body, posted: !!postedAs }))).toEqual([
      { id: "1", decision: "keep", resolve: false, body: "As posted.", posted: true },
      { id: "2", decision: "drop", resolve: true, body: "Reply 2", posted: false },
      { id: "3", decision: "keep", resolve: false, body: "The user's words.", posted: false },
      { id: "4", decision: "keep", resolve: false, body: "Reply 4", posted: false },
    ]);
  });
});
