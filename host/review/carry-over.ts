import type { CodeAnchor, FindingDecision, Review, ReviewAnswer, ReviewFinding } from "../../shared/review.ts";

/** What the user can do to a finding or an answer before it is posted. */
interface Curated {
  decision: FindingDecision;
  body: string;
  agentBody?: string;
  postedAs?: object;
}

export function isSameChange(a: Review, b: Review) {
  if (a.pullRequest && b.pullRequest) return a.pullRequest.url === b.pullRequest.url;
  return a.repository === b.repository && a.base === b.base;
}

export const ofSamePullRequest = (a: Review, b: Review) => a.pullRequest !== null && a.pullRequest.url === b.pullRequest?.url;

/** The review the user's choices carry over from: the latest of the same pull request, else the latest of the same change. */
export function reviewToCarryOverFrom(reviews: Review[], change: Review) {
  return reviews.findLast((review) => ofSamePullRequest(review, change)) ?? reviews.findLast((review) => isSameChange(review, change));
}

const sameLines = (a: CodeAnchor, b: CodeAnchor) => a.line === b.line && a.endLine === b.endLine;

function indexOfMatch(candidates: ReviewFinding[], finding: ReviewFinding) {
  const inSameFile = (each: ReviewFinding) => each.at.path === finding.at.path;
  const byTitle = candidates.findIndex((each) => inSameFile(each) && each.title === finding.title);
  return byTitle >= 0 ? byTitle : candidates.findIndex((each) => inSameFile(each) && sameLines(each.at, finding.at));
}

function withChoicesOf<T extends Curated>(earlier: T, later: T, postedHere = true): T {
  if (earlier.postedAs && postedHere) return { ...later, decision: earlier.decision, body: earlier.body, postedAs: earlier.postedAs };
  const agentLeftUserWording = earlier.agentBody !== undefined && later.body === earlier.agentBody;
  return { ...later, decision: earlier.decision, ...(agentLeftUserWording && { body: earlier.body, agentBody: earlier.agentBody }) };
}

/**
 * A review the agent publishes again starts with every finding kept; each one that matches a finding of the earlier
 * review (same file, and same title or lines) takes over what the user did with it there.
 */
export function carryOverChoices(earlier: ReviewFinding[], findings: ReviewFinding[], postedHere = true): ReviewFinding[] {
  const unmatched = [...earlier];
  return findings.map((finding) => {
    const index = indexOfMatch(unmatched, finding);
    if (index < 0) return finding;
    const [match] = unmatched.splice(index, 1);
    return withChoicesOf(match!, finding, postedHere);
  });
}

/** An answer to the same conversation as one of the earlier review takes over what the user did with that one. */
export function carryOverAnswerChoices(earlier: ReviewAnswer[], answers: ReviewAnswer[]): ReviewAnswer[] {
  return answers.map((answer) => {
    const match = earlier.find(({ threadId }) => threadId === answer.threadId);
    return match ? { ...withChoicesOf(match, answer), resolve: match.resolve } : answer;
  });
}
