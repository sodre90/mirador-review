import { delimiter } from "node:path";
import { currentPath } from "../current-path.ts";
import { answersOf, isCommentable, pendingReviewOfOtherCommitNote, pullRequestMovedOnNote, type ConversationComment, type GitHubCliProblem, type PullRequestRef, type Review, type ReviewAnswer, type ReviewFinding } from "../../shared/review.ts";

const PULL_REQUEST_URL = /^https:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#]\S*)?$/;

export function parsePullRequestUrl(url: string): PullRequestRef {
  const match = PULL_REQUEST_URL.exec(url.trim());
  if (!match) throw new Error(`"${url}" is not a pull request URL like https://github.com/owner/repo/pull/123.`);
  const [, host, owner, repo, number] = match as unknown as [string, string, string, string, string];
  return { url: `https://${host}/${owner}/${repo}/pull/${number}`, host, owner, repo, number: Number(number) };
}

/** Runs `gh` with these arguments, the body (if any) as JSON on its stdin, and returns what it printed, parsed. */
export type GitHubCli = (args: string[], body?: unknown) => Promise<unknown>;

/** Where gh's installers put it, for hosts started without a login shell's PATH. */
const GH_INSTALL_DIRECTORIES = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
const GH_CHECK_TIMEOUT_MS = 10_000;

const ghSearchPath = () => [currentPath(), ...GH_INSTALL_DIRECTORIES].filter(Boolean).join(delimiter);

export const ghCli: GitHubCli = async (args, body) => {
  const executable = Bun.which("gh", { PATH: ghSearchPath() });
  if (!executable) throw new Error("The GitHub CLI (gh) is not installed: no gh on PATH or in its usual install directories.");
  const child = Bun.spawn([executable, ...args, ...(body === undefined ? [] : ["--input", "-"])], {
    stdin: body === undefined ? "ignore" : new Blob([JSON.stringify(body)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, errors, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) throw new Error(errors.trim() || output.trim() || `gh exited with ${exitCode}`);
  return output.trim() ? JSON.parse(output) : null;
};

/** What keeps gh from posting to this host, if anything; null too when gh takes too long to say. */
export async function gitHubCliProblemOn(host: string, searchPath = ghSearchPath()): Promise<GitHubCliProblem | null> {
  const executable = Bun.which("gh", { PATH: searchPath });
  if (!executable) return "missing";
  // No --active: gh before 2.40 refuses the flag, which would lock Post for people whose posting works.
  const check = Bun.spawn([executable, "auth", "status", "--hostname", host], { stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: GH_CHECK_TIMEOUT_MS });
  const exitCode = await check.exited;
  if (check.signalCode) return null;
  return exitCode === 0 ? null : "logged-out";
}

const ADD_REVIEW = `mutation($input: AddPullRequestReviewInput!) { addPullRequestReview(input: $input) { pullRequestReview { id url } } }`;
const ADD_THREAD = `mutation($input: AddPullRequestReviewThreadInput!) { addPullRequestReviewThread(input: $input) { thread { id } } }`;
const ADD_REPLY = `mutation($input: AddPullRequestReviewThreadReplyInput!) { addPullRequestReviewThreadReply(input: $input) { comment { url } } }`;
const RESOLVE_THREAD = `mutation($input: ResolveReviewThreadInput!) { resolveReviewThread(input: $input) { thread { isResolved } } }`;
const PENDING_REVIEW = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviews(states: PENDING, first: 1) { nodes { id url commit { oid } } } } }
}`;
const REVIEW_THREADS = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewThreads(first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id path line originalLine isOutdated isResolved viewerCanResolve
      comments(first: 100) { nodes { databaseId url body createdAt author { login } } } }
  } } }
}`;

interface PullRequestResponse {
  node_id: string;
  head: { sha: string };
}

interface PendingReviewResponse {
  repository: { pullRequest: { reviews: { nodes: { id: string; url: string; commit: { oid: string } | null }[] } } | null } | null;
}

interface GraphQlResponse {
  data?: Record<string, unknown>;
  errors?: { message: string }[];
}

interface ReviewThreadsResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          id: string;
          path: string;
          line: number | null;
          originalLine: number | null;
          isOutdated: boolean;
          isResolved: boolean;
          viewerCanResolve: boolean;
          comments: { nodes: { databaseId: number; url: string; body: string; createdAt: string; author: { login: string } | null }[] };
        }[];
      };
    } | null;
  } | null;
}

/** A conversation on the pull request, with the ids of its comments, which is how the agent may name it. */
export interface PullRequestConversation extends Pick<ReviewAnswer, "threadId" | "path" | "line" | "outdated" | "resolved" | "canResolve" | "comments"> {
  commentIds: number[];
}

export interface PostOutcome {
  pendingReviewUrl: string;
  threadIds: Map<string, string>;
  answerUrls: Map<string, string>;
  resolvedAnswerIds: Set<string>;
  errors: Map<string, string>;
}

function graphQlOn(host: string, gh: GitHubCli) {
  return async (query: string, variables: object) => {
    const response = (await gh(["api", "--hostname", host, "graphql"], { query, variables })) as GraphQlResponse;
    if (response.errors?.length) throw new Error(response.errors.map(({ message }) => message).join("; "));
    return response.data!;
  };
}

/** Every conversation (review thread) on the pull request, resolved ones too. */
export async function fetchConversations(pr: PullRequestRef, gh: GitHubCli): Promise<PullRequestConversation[]> {
  const graphql = graphQlOn(pr.host, gh);
  const conversations: PullRequestConversation[] = [];
  for (let after: string | null = null, more = true; more; ) {
    const data = (await graphql(REVIEW_THREADS, { owner: pr.owner, repo: pr.repo, number: pr.number, after })) as unknown as ReviewThreadsResponse;
    const threads = data.repository?.pullRequest?.reviewThreads;
    if (!threads) throw new Error(`${pr.url} is not a pull request GitHub knows.`);
    threads.nodes.forEach((thread) =>
      conversations.push({
        threadId: thread.id,
        path: thread.path,
        line: thread.line ?? thread.originalLine,
        outdated: thread.isOutdated,
        resolved: thread.isResolved,
        canResolve: thread.viewerCanResolve,
        comments: thread.comments.nodes.map(({ url, body, createdAt, author }): ConversationComment => ({ author: author?.login ?? "ghost", body, url, createdAt })),
        commentIds: thread.comments.nodes.map(({ databaseId }) => databaseId),
      }),
    );
    ({ hasNextPage: more, endCursor: after } = threads.pageInfo);
  }
  return conversations;
}

const COMMENT_ID = /(?:#discussion_r|\/comments\/|^)(\d+)$/;

/** The conversation the agent named by its thread id, or by the URL or id of one of its comments. */
export function conversationNamed(conversations: PullRequestConversation[], name: string) {
  const trimmed = name.trim();
  const commentId = COMMENT_ID.exec(trimmed)?.[1];
  return conversations.find(({ threadId, commentIds }) => threadId === trimmed || (commentId !== undefined && commentIds.includes(Number(commentId))));
}

const fileOf = (review: Review, path: string) => review.files.find((file) => file.path === path);

/** Kept findings not posted yet, on lines GitHub accepts comments on. */
export const findingsToPost = (review: Review) =>
  review.findings.filter((finding) => finding.decision === "keep" && !finding.postedAs && isCommentable(fileOf(review, finding.at.path), finding.at));

export const answersToPost = (review: Review) => answersOf(review).filter((answer) => answer.decision === "keep" && !answer.postedAs);

function threadInput(reviewId: string, { at, body }: ReviewFinding) {
  const range = at.endLine > at.line ? { startLine: at.line, startSide: "RIGHT" } : {};
  return { pullRequestReviewId: reviewId, path: at.path, line: at.endLine, side: "RIGHT", ...range, body };
}

/** Posting refuses a review of a commit the pull request has moved on from: its comments would land on the wrong lines. */
export class PullRequestMovedOn extends Error {
  constructor(
    review: Review,
    readonly headCommit: string,
  ) {
    super(pullRequestMovedOnNote(review, headCommit));
  }
}

/** Posting refuses to add to the user's pending review when it was started on another commit: its comments would land on that commit's lines. */
export class PendingReviewOfOtherCommit extends Error {
  constructor(
    review: Review,
    readonly pendingReview: { url: string; commit: string },
  ) {
    super(pendingReviewOfOtherCommitNote(review, pendingReview));
  }
}

/**
 * Adds the findings, and the answers as replies, to the user's pending review on the pull request, starting one if they
 * have none, and leaves it pending: the user reads it on GitHub and submits it. Conversations the user chose to resolve
 * are resolved right away, which everyone sees. Each comment goes on its own, so one GitHub refuses does not stop the
 * others.
 */
export async function postPendingReview(review: Review, gh: GitHubCli): Promise<PostOutcome> {
  const pr = review.pullRequest;
  if (!pr) throw new Error("This review is not of a pull request.");
  const rest = (path: string) => gh(["api", "--hostname", pr.host, `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}${path}`]);
  const graphQl = graphQlOn(pr.host, gh);
  const graphql = (query: string, input: object) => graphQl(query, { input });

  const pullRequest = (await rest("")) as PullRequestResponse;
  if (pullRequest.head.sha !== review.headCommit) throw new PullRequestMovedOn(review, pullRequest.head.sha);
  const pending = (await graphQl(PENDING_REVIEW, { owner: pr.owner, repo: pr.repo, number: pr.number })) as unknown as PendingReviewResponse;
  const usersPendingReview = pending.repository?.pullRequest?.reviews.nodes[0];
  if (usersPendingReview?.commit && usersPendingReview.commit.oid !== review.headCommit) {
    throw new PendingReviewOfOtherCommit(review, { url: usersPendingReview.url, commit: usersPendingReview.commit.oid });
  }
  const pendingReview =
    usersPendingReview ??
    ((await graphql(ADD_REVIEW, { pullRequestId: pullRequest.node_id, commitOID: review.headCommit })) as { addPullRequestReview: { pullRequestReview: { id: string; url: string } } })
        .addPullRequestReview.pullRequestReview;

  const outcome: PostOutcome = { pendingReviewUrl: pendingReview.url, threadIds: new Map(), answerUrls: new Map(), resolvedAnswerIds: new Set(), errors: new Map() };
  for (const finding of findingsToPost(review)) {
    try {
      const data = (await graphql(ADD_THREAD, threadInput(pendingReview.id, finding))) as { addPullRequestReviewThread: { thread: { id: string } } };
      outcome.threadIds.set(finding.id, data.addPullRequestReviewThread.thread.id);
    } catch (error) {
      outcome.errors.set(finding.id, errorText(error));
    }
  }
  for (const answer of answersToPost(review)) {
    try {
      const reply = { pullRequestReviewId: pendingReview.id, pullRequestReviewThreadId: answer.threadId, body: answer.body };
      const data = (await graphql(ADD_REPLY, reply)) as { addPullRequestReviewThreadReply: { comment: { url: string } } };
      outcome.answerUrls.set(answer.id, data.addPullRequestReviewThreadReply.comment.url);
    } catch (error) {
      outcome.errors.set(answer.id, errorText(error));
      continue;
    }
    if (!answer.resolve || answer.resolved) continue;
    try {
      await graphql(RESOLVE_THREAD, { threadId: answer.threadId });
      outcome.resolvedAnswerIds.add(answer.id);
    } catch (error) {
      outcome.errors.set(answer.id, `The answer is on your pending review, but the conversation was not resolved: ${errorText(error)}`);
    }
  }
  return outcome;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
