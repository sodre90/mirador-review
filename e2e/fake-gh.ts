/** Stands in for gh in review.spec.ts: it logs how it was called, and answers like GitHub for pull 7 of team/shop. */
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const { FAKE_GH_LOG, FAKE_GH_AUTH_LOG, FAKE_GH_LOGGED_OUT, FAKE_GH_UNREACHABLE, FAKE_GH_HEAD, FAKE_GH_PENDING_REVIEW_COMMIT, FAKE_GH_THREADS, FAKE_GH_PULL_REQUEST } = process.env;
const args = process.argv.slice(2);
const called = args.join(" ");

if (args[0] === "auth" && args[1] === "status") {
  appendFileSync(FAKE_GH_AUTH_LOG!, `${called}\n`);
  process.exit(existsSync(FAKE_GH_LOGGED_OUT!) ? 1 : 0);
}

const input = ` ${called} `.includes(" --input - ") ? (await Bun.stdin.text()).replace(/\n+$/, "") : "";
appendFileSync(FAKE_GH_LOG!, `${called}\t${input}\n`);

if (existsSync(FAKE_GH_UNREACHABLE!)) {
  process.stderr.write("error connecting to ghe.example.com\n");
  process.exit(1);
}

function graphqlAnswer() {
  if (input.includes("states: PENDING")) {
    const nodes = FAKE_GH_PENDING_REVIEW_COMMIT ? [{ id: "PRR_0", url: `${FAKE_GH_PULL_REQUEST}#pullrequestreview-0`, commit: { oid: FAKE_GH_PENDING_REVIEW_COMMIT } }] : [];
    return { data: { repository: { pullRequest: { reviews: { nodes } } } } };
  }
  if (input.includes("reviewThreads(")) return JSON.parse(readFileSync(FAKE_GH_THREADS!, "utf8"));
  if (input.includes("addPullRequestReviewThreadReply(")) return { data: { addPullRequestReviewThreadReply: { comment: { url: `${FAKE_GH_PULL_REQUEST}#discussion_r90` } } } };
  if (input.includes("resolveReviewThread(")) return { data: { resolveReviewThread: { thread: { isResolved: true } } } };
  if (input.includes("addPullRequestReview(")) return { data: { addPullRequestReview: { pullRequestReview: { id: "PRR_1", url: `${FAKE_GH_PULL_REQUEST}#pullrequestreview-1` } } } };
  return { data: { addPullRequestReviewThread: { thread: { id: "THREAD" } } } };
}

if (called.includes("pulls/7")) console.log(JSON.stringify({ node_id: "PR_7", head: { sha: FAKE_GH_HEAD } }));
else if (called.includes("graphql")) console.log(JSON.stringify(graphqlAnswer()));
