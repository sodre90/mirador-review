import type { ReviewAnswer } from "../../shared/review.ts";
import { conversationNamed, fetchConversations, parsePullRequestUrl, type GitHubCli } from "./github.ts";
import { ReviewProblems, type ReviewRequest } from "./snapshot.ts";

/**
 * The agent's answers to conversations already on the pull request, each shown with the conversation as GitHub has it
 * now rather than as the agent retold it. Lists every answer whose conversation is not on the pull request at once.
 */
export async function answersToConversations(request: ReviewRequest, gh: GitHubCli): Promise<ReviewAnswer[]> {
  const requested = request.answers ?? [];
  if (requested.length === 0) return [];
  if (!request.pullRequest) throw new ReviewProblems(["answers: only a review of a pull request can answer its conversations; pass pullRequest."]);
  const pr = pullRequestOrNothing(request.pullRequest);
  if (!pr) return [];
  const conversations = await fetchConversations(pr, gh).catch((error) => {
    throw new ReviewProblems([`answers: the pull request's conversations could not be read from GitHub: ${error instanceof Error ? error.message : String(error)}`]);
  });

  const problems: string[] = [];
  const answeredThreads = new Set<string>();
  const answers = requested.map((answer, index): ReviewAnswer | null => {
    const conversation = conversationNamed(conversations, answer.conversation);
    if (!conversation) {
      problems.push(
        `answer ${index + 1}: "${answer.conversation}" is not a conversation on ${pr.url}; name one by the URL of any of its comments (…#discussion_r<id>) or by its thread id (PRRT_…).`,
      );
      return null;
    }
    if (answeredThreads.has(conversation.threadId)) {
      problems.push(`answer ${index + 1}: an earlier answer is already for this conversation; write one answer per conversation.`);
      return null;
    }
    answeredThreads.add(conversation.threadId);
    const { commentIds, ...shown } = conversation;
    return { ...shown, id: `answer-${index + 1}`, body: answer.body, suggestsResolving: answer.resolve === true, resolve: false, decision: "keep" };
  });
  if (problems.length > 0) throw new ReviewProblems(problems);
  return answers.filter((answer) => answer !== null);
}

/** A URL that is no pull request's is one of the problems the snapshot reports. */
function pullRequestOrNothing(url: string) {
  try {
    return parsePullRequestUrl(url);
  } catch {
    return null;
  }
}
