import { createContext, Fragment, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";
import { fenced } from "../shared/fenced.ts";
import type { ReviewItem, TourItem } from "../shared/walkthrough-items.ts";
import { cutWithEllipsis } from "../shared/text-cut.ts";
import {
  anchorLabel,
  answersOf,
  ASKED_TO_REVIEW_AGAIN,
  compareUrl,
  excerptRows,
  findingNumber,
  findingSeverities,
  isCommentable,
  pendingReviewOfOtherCommitNote,
  pullRequestMovedOnNote,
  severityLabels,
  type CodeAnchor,
  type DiffRow,
  type FindingDecision,
  type GitHubCliProblem,
  type PullRequestMovedOn,
  type PullRequestRef,
  type Review,
  type ReviewAnswer,
  type ReviewFile,
  type ReviewFinding,
  type Tour,
  type Walkthrough,
} from "../shared/review.ts";
import { highlightRows, type CodeSpan } from "./highlight.ts";
import { hints } from "./hints.ts";
import { MarkdownText } from "./Markdown.tsx";
import {
  CONTEXT_STEP,
  gapsOf,
  hiddenCount,
  hunkRowsShown,
  nothingRevealed,
  revealAll,
  revealOverNext,
  revealUnderPrevious,
  type Gap,
  type GapPlace,
  type RevealChange,
  type ShownContext,
} from "./review-context.ts";
import { DEFAULT_FLOW_BAND_SHARE, DEFAULT_REVIEW_LIST_SHARE } from "./pane-shares.ts";
import { ReviewFindBar, useReviewFind } from "./ReviewFind.tsx";
import { isMac, keyLabels, shortcutKeys } from "./shortcuts.ts";
import { Splitter, type SplitAxis } from "./Splitter.tsx";
import type { PlaceInWalkthrough, WalkthroughTab } from "../shared/walkthrough-actions.ts";
import { useWalkthroughHost, WalkthroughHostContext, type WalkthroughHost, type WalkthroughPaneShares } from "./walkthrough-host.ts";

type WalkthroughItem = ReviewItem | TourItem;

const isReviewItem = (item: WalkthroughItem) => item.kind === "review";

type Tab = WalkthroughTab;

const tabs: { id: Tab; label: string; key: string }[] = [
  { id: "overview", label: "Overview", key: "1" },
  { id: "flow", label: "Flow", key: "2" },
  { id: "files", label: "Files", key: "3" },
  { id: "findings", label: "Findings", key: "4" },
  { id: "conversations", label: "Conversations", key: "5" },
];

const countOf = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** "2 findings and 1 answer", leaving out what there is none of. */
const findingsAndAnswers = (findings: number, answers: number) =>
  [findings > 0 && countOf(findings, "finding"), answers > 0 && countOf(answers, "answer")].filter(Boolean).join(" and ");

const conversationPlace = ({ path, line }: ReviewAnswer) => (line === null ? path : `${path}:${line}`);

const MAX_TOPIC_LENGTH = 90;

/** The conversation's first comment, cut to a line, to name it in lists. */
function conversationTopic({ comments }: ReviewAnswer) {
  const firstLine = comments[0]?.body.split("\n").find((line) => line.trim())?.trim() ?? "";
  return cutWithEllipsis(firstLine, MAX_TOPIC_LENGTH - 1, MAX_TOPIC_LENGTH);
}

/** Lines picked in one block of code: rows `from` to `to` (in either order) of the block's rows. */
interface LineSelection {
  blockId: string;
  path: string;
  from: number;
  to: number;
  rows: DiffRow[];
}

const changeLetters: Record<ReviewFile["change"], string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };

const fileOf = (walk: Walkthrough, path: string) => walk.files.find((file) => file.path === path);

const isWithin = (newLine: number | null, { line, endLine }: CodeAnchor) => newLine !== null && newLine >= line && newLine <= endLine;

const marker = (row: DiffRow) => (row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " ");

const diffLine = (row: DiffRow) => (row.kind === "elided" ? row.text.replaceAll("…", "@@") : `${marker(row)}${row.text}`);

/** The files the tour walks through first, in its order, then the rest as git lists them. */
function filesInReadingOrder(walk: Walkthrough) {
  const tourPaths = [...new Set(walk.flow.map((step) => step.at.path))];
  const inTour = tourPaths.flatMap((path) => walk.files.filter((file) => file.path === path));
  return [...inTour, ...walk.files.filter((file) => !tourPaths.includes(file.path))];
}

function selectionLabel({ path, rows }: Pick<LineSelection, "path" | "rows">) {
  const newLines = rows.flatMap((row) => (row.newLine === null ? [] : [row.newLine]));
  if (newLines.length > 0) return anchorLabel({ path, line: Math.min(...newLines), endLine: Math.max(...newLines) });
  const oldLines = rows.flatMap((row) => (row.oldLine === null ? [] : [row.oldLine]));
  return `${path} (removed lines ${Math.min(...oldLines)}-${Math.max(...oldLines)})`;
}

const lineToOpen = (rows: DiffRow[]) => rows.find((row) => row.newLine !== null)?.newLine ?? rows[0]?.oldLine ?? 1;

const UPDATE_THE_REVIEW =
  "If your answer changes anything in the review (a finding, the tour, the summary or the verdict), change just those parts with the update_review tool; publish the whole review again only if the code under review changed.";

/** What a question is about: lines, and the finding they belong to when it was asked from one. */
type AskingAbout = Pick<LineSelection, "path" | "rows"> & { findingId?: string };

const quoted = (text: string) => text.split("\n").map((line) => `> ${line}`).join("\n");

/** A question from a finding names it and carries its comment as the user sees it, their own rewording included. */
function questionAbout(item: WalkthroughItem, place: AskingAbout, finding: ReviewFinding | undefined, question: string, updatesReview: boolean) {
  const code = place.rows.map(diffLine).join("\n");
  const subject = finding ? `${finding.id} ("${finding.title}") at ${selectionLabel(place)}` : selectionLabel(place);
  const comment = finding ? `\n\nIts comment now reads:\n\n${quoted(finding.body)}` : "";
  const asked = `About ${subject} in the ${item.kind} "${item.title}":${comment}\n\n${fenced(code, "diff")}\n\n${question.trim()}`;
  return updatesReview ? `${asked}\n\n${UPDATE_THE_REVIEW}` : asked;
}

const AGENT_EDIT_FLASH_MS = 2000;

/** For the review on screen: the agent's edit it opened with, and the edit each part last flashed for. */
const ShownAgentEdits = createContext({ openedWith: undefined as number | undefined, flashed: new Map<string, number>() });

/**
 * Whether to draw the eye to this part for a moment because the agent changed it since the review opened. Each change
 * flashes once, when the part is first on screen: a finding the agent adds as it appears, a verdict changed while
 * another tab was open when that tab opens.
 */
function useAgentEdited(edit: Review["agentEdit"], part: string) {
  const shown = useContext(ShownAgentEdits);
  const [flashing, setFlashing] = useState(false);
  useEffect(() => {
    if (!edit || edit.at === shown.openedWith || !edit.parts.includes(part) || shown.flashed.get(part) === edit.at) return;
    shown.flashed.set(part, edit.at);
    setFlashing(true);
    const timer = setTimeout(() => setFlashing(false), AGENT_EDIT_FLASH_MS);
    return () => {
      clearTimeout(timer);
      setFlashing(false);
    };
  }, [edit?.at]);
  return flashing;
}

export function CodeText({ text, spans }: { text: string; spans: CodeSpan[] | undefined }) {
  if (!spans) return <code className="code-text">{text || " "}</code>;
  return (
    <code className="code-text">
      {spans.length === 0 ? " " : spans.map(({ text: piece, type }, index) => (type ? <span key={index} className={`token ${type}`}>{piece}</span> : piece))}
    </code>
  );
}

function CodeBlock({
  blockId,
  path,
  rows,
  anchored,
  selection,
  onSelect,
  after,
}: {
  blockId: string;
  path: string;
  rows: DiffRow[];
  anchored?: CodeAnchor;
  selection: LineSelection | null;
  onSelect: (selection: LineSelection) => void;
  after?: (row: DiffRow) => ReactNode;
}) {
  const highlighted = useMemo(() => highlightRows(path, rows), [path, rows]);
  const ownSelection = selection?.blockId === blockId ? selection : null;
  const [first, last] = ownSelection ? [Math.min(ownSelection.from, ownSelection.to), Math.max(ownSelection.from, ownSelection.to)] : [-1, -1];
  const pick = (index: number, extend: boolean) => {
    const from = extend && ownSelection ? ownSelection.from : index;
    onSelect({ blockId, path, from, to: index, rows: rows.slice(Math.min(from, index), Math.max(from, index) + 1) });
  };
  return (
    <div className="code-block">
      {rows.map((row, index) => (
        <Fragment key={index}>
          {row.kind === "elided" ? (
            <div className={["code-row", "elided", anchored && isWithin(rows[index - 1]?.newLine ?? null, anchored) && "anchored"].filter(Boolean).join(" ")}>
              <span className="elision">{row.text}</span>
            </div>
          ) : (
            <div
              className={["code-row", row.kind, anchored && isWithin(row.newLine, anchored) && "anchored", index >= first && index <= last && "selected"]
                .filter(Boolean)
                .join(" ")}
            >
              <button
                type="button"
                className="line-number"
                data-hint={hints.reviewLineNumber}
                aria-label={`Line ${row.newLine ?? row.oldLine}`}
                onClick={(event) => pick(index, event.shiftKey)}
              >
                {row.newLine ?? row.oldLine}
              </button>
              <span className="diff-marker">{marker(row)}</span>
              <CodeText text={row.text} spans={highlighted?.[index]} />
            </div>
          )}
          {after?.(row)}
        </Fragment>
      ))}
    </div>
  );
}

/** The number the agent names the finding by, so "finding 5" in chat points at #5 here. */
function FindingNumber({ findingId }: { findingId: string }) {
  const number = findingNumber(findingId);
  return number > 0 ? (
    <span className="finding-number" data-hint={hints.findingNumber}>
      #{number}
    </span>
  ) : null;
}

function FindingCard({
  item,
  finding,
  selected,
  showsCode,
  selection,
  onSelect,
  onGoToCode,
  onAsk,
}: {
  item: ReviewItem;
  finding: ReviewFinding;
  selected: boolean;
  showsCode: boolean;
  selection: LineSelection | null;
  onSelect: (selection: LineSelection) => void;
  onGoToCode?: () => void;
  onAsk: () => void;
}) {
  const { review } = item;
  const [editing, setEditing] = useState(false);
  const agentEdited = useAgentEdited(review.agentEdit, finding.id);
  const host = useWalkthroughHost();
  const file = fileOf(review, finding.at.path);
  const update = (change: { decision?: FindingDecision; body?: string }) => host.updateFinding(finding.id, change);
  const posted = Boolean(finding.postedAs);
  const save = (body: string) => {
    update({ body });
    setEditing(false);
  };
  return (
    <article
      className={["finding", `severity-${finding.severity}`, finding.decision === "drop" && "dropped", selected && "selected", agentEdited && "agent-edited"]
        .filter(Boolean)
        .join(" ")}
      data-finding-id={finding.id}
    >
      <header>
        <span className="severity">{severityLabels[finding.severity]}</span>
        <span className={`checked ${finding.checked}`} data-hint={hints.findingChecked}>
          {finding.checked === "confirmed" ? "✓ confirmed" : "? plausible"}
        </span>
        <FindingNumber findingId={finding.id} />
        <span className="finding-title">{finding.title}</span>
        {onGoToCode ? (
          <button type="button" className="link anchor" onClick={onGoToCode}>
            {anchorLabel(finding.at)}
          </button>
        ) : (
          <span className="anchor">{anchorLabel(finding.at)}</span>
        )}
      </header>
      {editing ? <BodyEditor body={finding.body} onSave={save} onCancel={() => setEditing(false)} /> : <MarkdownText text={finding.body} />}
      {finding.evidence && (
        <details className="evidence">
          <summary>How it was checked</summary>
          <MarkdownText text={finding.evidence} />
        </details>
      )}
      {showsCode && (
        <CodeBlock
          blockId={`finding-${finding.id}`}
          path={finding.at.path}
          rows={excerptRows(file, finding.excerpt)}
          anchored={finding.at}
          selection={selection}
          onSelect={onSelect}
        />
      )}
      <footer>
        <FindingStatus review={review} finding={finding} file={file} />
        <span className="spacer" />
        <button
          type="button"
          className={`decision ${finding.decision}`}
          aria-pressed={finding.decision === "keep"}
          data-hint={hints.findingDecision}
          disabled={posted}
          onClick={() => update({ decision: finding.decision === "keep" ? "drop" : "keep" })}
        >
          {finding.decision === "keep" ? "Kept" : "Dropped"}
        </button>
        <button type="button" className="link" disabled={posted || editing} onClick={() => setEditing(true)}>
          Edit
        </button>
        <button type="button" className="link" onClick={onAsk}>
          Ask
        </button>
        <button type="button" className="link" onClick={() => host.openInEditor(finding.at.path, finding.at.line)}>
          Open in IDEA
        </button>
      </footer>
    </article>
  );
}

/** Follows the agent's rewording until the user types; from then on their draft stays, with the agent's new wording shown under it. */
function BodyEditor({ body, onSave, onCancel }: { body: string; onSave: (body: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(body);
  const [startedFrom, setStartedFrom] = useState(body);
  const typingAidAttributes = useWalkthroughHost().typingAidAttributes;
  const startFrom = (text: string) => {
    setDraft(text);
    setStartedFrom(text);
  };
  const agentReworded = body !== startedFrom;
  if (agentReworded && draft === startedFrom) startFrom(body);
  return (
    <div className="finding-edit">
      <textarea {...typingAidAttributes} value={draft} rows={Math.max(3, draft.split("\n").length)} onChange={(event) => setDraft(event.target.value)} autoFocus />
      {agentReworded && (
        <div className="agent-reworded" role="status">
          <p>The agent reworded this while you were editing:</p>
          <MarkdownText text={body} />
          <button type="button" className="link" onClick={() => startFrom(body)}>
            Use its wording
          </button>
        </div>
      )}
      <div className="finding-edit-actions">
        <button type="button" className="primary" onClick={() => onSave(draft)} disabled={!draft.trim()}>
          Save
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function AnswerCard({ item, answer, selected }: { item: ReviewItem; answer: ReviewAnswer; selected: boolean }) {
  const [editing, setEditing] = useState(false);
  const agentEdited = useAgentEdited(item.review.agentEdit, answer.id);
  const host = useWalkthroughHost();
  const update = (change: { decision?: FindingDecision; body?: string; resolve?: boolean }) => host.updateAnswer(answer.id, change);
  const posted = Boolean(answer.postedAs);
  const save = (body: string) => {
    update({ body });
    setEditing(false);
  };
  return (
    <article
      className={["finding", "answer", answer.decision === "drop" && "dropped", selected && "selected", agentEdited && "agent-edited"].filter(Boolean).join(" ")}
      data-answer-id={answer.id}
    >
      <header>
        <span className="anchor">{conversationPlace(answer)}</span>
        {answer.outdated && <span className="conversation-state">Outdated</span>}
        {answer.resolved && <span className="conversation-state resolved">Resolved</span>}
        {answer.comments[0] && (
          <a href={answer.comments[0].url} target="_blank" rel="noreferrer">
            View on GitHub
          </a>
        )}
      </header>
      <ol className="conversation-comments" aria-label="Conversation">
        {answer.comments.map((comment) => (
          <li key={comment.url}>
            <span className="comment-author">{comment.author}</span>
            <MarkdownText text={comment.body} />
          </li>
        ))}
      </ol>
      <div className="answer-body">
        <span className="comment-author">Answer</span>
        {editing ? <BodyEditor body={answer.body} onSave={save} onCancel={() => setEditing(false)} /> : <MarkdownText text={answer.body} />}
      </div>
      <footer>
        <AnswerStatus answer={answer} />
        {!answer.resolved && !posted && (
          <label className="resolve-choice" data-hint={answer.canResolve ? hints.answerResolve : hints.answerCannotResolve}>
            <input type="checkbox" checked={answer.resolve} disabled={!answer.canResolve} onChange={(event) => update({ resolve: event.target.checked })} />
            Resolve when posted{answer.suggestsResolving && " (the agent suggests it)"}
          </label>
        )}
        <button
          type="button"
          className={`decision ${answer.decision}`}
          aria-pressed={answer.decision === "keep"}
          data-hint={hints.answerDecision}
          disabled={posted}
          onClick={() => update({ decision: answer.decision === "keep" ? "drop" : "keep" })}
        >
          {answer.decision === "keep" ? "Kept" : "Dropped"}
        </button>
        <button type="button" className="link" disabled={posted || editing} onClick={() => setEditing(true)}>
          Edit
        </button>
      </footer>
    </article>
  );
}

function AnswerStatus({ answer }: { answer: ReviewAnswer }) {
  if (answer.postError) return <span className="finding-status failed">{answer.postedAs ? answer.postError : `GitHub refused it: ${answer.postError}`}</span>;
  if (answer.postedAs) return <span className="finding-status posted">On your pending review{answer.resolved && ", conversation resolved"}</span>;
  return null;
}

function FindingStatus({ review, finding, file }: { review: Review; finding: ReviewFinding; file: ReviewFile | undefined }) {
  if (finding.postedAs) return <span className="finding-status posted">On the pull request</span>;
  if (finding.postError) return <span className="finding-status failed">GitHub refused it: {finding.postError}</span>;
  if (review.pullRequest && !isCommentable(file, finding.at)) {
    return (
      <span className="finding-status outside" data-hint={hints.findingOutsideDiff}>
        Outside the pull request's diff
      </span>
    );
  }
  return null;
}

const gitHubCliChecks = new Map<string, Promise<GitHubCliProblem | null>>();

/** Whether gh can post this review, asked of the host once per review until the user checks again. */
function gitHubCliCheck(itemId: string, host: WalkthroughHost) {
  if (!gitHubCliChecks.has(itemId)) {
    const check = host.checkGitHubCli();
    check.catch(() => gitHubCliChecks.delete(itemId));
    gitHubCliChecks.set(itemId, check);
  }
  return gitHubCliChecks.get(itemId)!;
}

function useGitHubCliProblem(itemId: string, postsToGitHub: boolean) {
  const host = useWalkthroughHost();
  const [problem, setProblem] = useState<GitHubCliProblem | null>(null);
  const [checking, setChecking] = useState(false);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!postsToGitHub) return;
    let current = true;
    setChecking(true);
    gitHubCliCheck(itemId, host)
      .then((found) => current && setProblem(found))
      .catch(() => {})
      .finally(() => current && setChecking(false));
    return () => {
      current = false;
    };
  }, [itemId, postsToGitHub, round]);
  const checkAgain = () => {
    gitHubCliChecks.delete(itemId);
    setRound((count) => count + 1);
  };
  return { problem, checking, checkAgain };
}

function GitHubCliHint({ problem, host, checking, onCheckAgain }: { problem: GitHubCliProblem; host: string; checking: boolean; onCheckAgain: () => void }) {
  const login = <code>gh auth login --hostname {host}</code>;
  return (
    <p className="hint github-cli-problem">
      {problem === "missing" ? (
        <>
          Posting needs the GitHub CLI, and no <code>gh</code> was found.{" "}
          <a href="https://cli.github.com" target="_blank" rel="noreferrer">
            Install it
          </a>
          , then run {login}.
        </>
      ) : (
        <>
          Posting needs <code>gh</code> logged in to {host}, and gh could not confirm that. Run {login}, or{" "}
          <code>gh auth status --hostname {host}</code> to see why.
        </>
      )}{" "}
      <button type="button" className="link" disabled={checking} onClick={onCheckAgain}>
        {checking ? "Checking…" : "Check again"}
      </button>
    </p>
  );
}

/** No finding or answer to post, now or later, and nothing posted yet to point to. */
const hasNothingToPost = (review: Review) => review.findings.length === 0 && answersOf(review).length === 0 && !review.pendingReviewUrl;

function PostPanel({ item }: { item: ReviewItem }) {
  const { review } = item;
  const gitHubCli = useGitHubCliProblem(item.id, review.pullRequest !== null);
  const host = useWalkthroughHost();
  if (!review.pullRequest || hasNothingToPost(review)) return null;
  const kept = review.findings.filter((finding) => finding.decision === "keep" && !finding.postedAs);
  const toPost = kept.filter((finding) => isCommentable(fileOf(review, finding.at.path), finding.at));
  const posted = review.findings.filter((finding) => finding.postedAs).length;
  const outside = kept.length - toPost.length;
  const answers = answersOf(review);
  const answersToPost = answers.filter((answer) => answer.decision === "keep" && !answer.postedAs);
  const postedAnswers = answers.filter((answer) => answer.postedAs).length;
  const resolving = answersToPost.filter((answer) => answer.resolve && !answer.resolved).length;
  return (
    <section className="post-panel">
      <h3>
        Pull request{" "}
        <a href={review.pullRequest.url} target="_blank" rel="noreferrer">
          {review.pullRequest.owner}/{review.pullRequest.repo} pull {review.pullRequest.number}
        </a>
      </h3>
      <p>
        Kept findings go to the pull request as comments on a pending review{answers.length > 0 && ", and kept answers as replies in their conversations"},
        which only you see until you submit it on GitHub. Dropped ones stay here.
      </p>
      {outside > 0 && (
        <p className="hint">
          {outside === 1 ? "1 kept finding is" : `${outside} kept findings are`} on lines outside the pull request's diff; GitHub takes no
          line comments there.
        </p>
      )}
      {resolving > 0 && (
        <p className="hint">
          {resolving === 1 ? "1 conversation is" : `${resolving} conversations are`} resolved as you post, which everyone sees at once, before you submit the
          review.
        </p>
      )}
      {gitHubCli.problem && (
        <GitHubCliHint problem={gitHubCli.problem} host={review.pullRequest.host} checking={gitHubCli.checking} onCheckAgain={gitHubCli.checkAgain} />
      )}
      {review.pendingReviewOfOtherCommit && !review.pullRequestMovedOn && (
        <p className="hint">
          {pendingReviewOfOtherCommitNote(review, review.pendingReviewOfOtherCommit)}{" "}
          <a href={review.pendingReviewOfOtherCommit.url} target="_blank" rel="noreferrer">
            Open your pending review
          </a>
        </p>
      )}
      {review.postFailure && (
        <p className="post-failure" role="alert">
          The last post failed: {review.postFailure}
        </p>
      )}
      {review.pullRequestMovedOn ? (
        <PullRequestMovedOnNote item={item} pullRequest={review.pullRequest} movedOn={review.pullRequestMovedOn} />
      ) : toPost.length + answersToPost.length > 0 || review.posting ? (
        <button type="button" className="primary" disabled={review.posting || gitHubCli.problem !== null} onClick={() => host.post()}>
          {review.posting ? "Posting…" : `Post ${findingsAndAnswers(toPost.length, answersToPost.length)} to the pull request`}
        </button>
      ) : (
        <p className="hint">Nothing new to post: no kept finding{answers.length > 0 && " or answer"} is waiting for it.</p>
      )}
      {review.pendingReviewUrl && (
        <p className="posted-note">
          {findingsAndAnswers(posted, postedAnswers) || "0 findings"} {posted + postedAnswers === 1 ? "is" : "are"} on your pending review.{" "}
          <a href={review.pendingReviewUrl} target="_blank" rel="noreferrer">
            Open it on GitHub
          </a>{" "}
          to read it over and submit it.
        </p>
      )}
    </section>
  );
}

/** In place of Post, which GitHub would refuse: the agent can review the head the pull request moved on to. */
function PullRequestMovedOnNote({ item, pullRequest, movedOn }: { item: ReviewItem; pullRequest: PullRequestRef; movedOn: PullRequestMovedOn }) {
  const host = useWalkthroughHost();
  return (
    <>
      <p className="hint">
        {pullRequestMovedOnNote(item.review, movedOn.headCommit)}{" "}
        <a href={compareUrl(pullRequest, item.review.headCommit, movedOn.headCommit)} target="_blank" rel="noreferrer">
          See what changed
        </a>
      </p>
      {movedOn.askedToReviewAgain ? (
        <p className="posted-note">{ASKED_TO_REVIEW_AGAIN}</p>
      ) : (
        <button type="button" className="primary" onClick={() => host.reviewAgain()}>
          Review again
        </button>
      )}
    </>
  );
}

function FlowOutline({ walk, onStep }: { walk: Walkthrough; onStep: (index: number) => void }) {
  if (walk.flow.length === 0) return null;
  return (
    <>
      <h3>How the code flows</h3>
      <ol className="overview-flow">
        {walk.flow.map((step, index) => (
          <li key={index}>
            <button type="button" className="link" onClick={() => onStep(index)}>
              {step.title}
            </button>{" "}
            <span className="anchor">{anchorLabel(step.at)}</span>
          </li>
        ))}
      </ol>
    </>
  );
}

const changeCounts = (walk: Walkthrough) => {
  const added = walk.files.reduce((sum, file) => sum + file.added, 0);
  const removed = walk.files.reduce((sum, file) => sum + file.removed, 0);
  return (
    <>
      {walk.files.length} files changed · <span className="added-count">+{added}</span> <span className="removed-count">−{removed}</span>
    </>
  );
};

function TourOverview({ tour, onStep }: { tour: Tour; onStep: (index: number) => void }) {
  return (
    <div className="review-overview tour-overview">
      <section className="overview-story">
        {tour.changes && (
          <p className="review-stats">
            {changeCounts(tour)} · since {tour.changes.since} ({tour.changes.sinceCommit.slice(0, 8)})
          </p>
        )}
        <MarkdownText text={tour.summary} />
        <FlowOutline walk={tour} onStep={onStep} />
      </section>
    </div>
  );
}

function Overview({
  item,
  onStep,
  onFinding,
  onAnswer,
}: {
  item: ReviewItem;
  onStep: (index: number) => void;
  onFinding: (id: string) => void;
  onAnswer: (id: string) => void;
}) {
  const { review } = item;
  const answers = answersOf(review);
  const verdictEdited = useAgentEdited(review.agentEdit, "verdict");
  const summaryEdited = useAgentEdited(review.agentEdit, "summary");
  return (
    <div className="review-overview">
      <section className="overview-story">
        <p className={`verdict ${verdictEdited ? "agent-edited" : ""}`}>{review.verdict}</p>
        <p className="review-stats">
          {changeCounts(review)} · {review.base} ({review.baseCommit.slice(0, 8)}) → {review.headCommit.slice(0, 8)}
        </p>
        <div className={summaryEdited ? "agent-edited" : ""}>
          <MarkdownText text={review.summary} />
        </div>
        <FlowOutline walk={review} onStep={onStep} />
      </section>
      <section className="overview-findings">
        <h3>Findings</h3>
        {review.findings.length === 0 && <p className="hint">None.</p>}
        {findingSeverities.map((severity) => {
          const findings = review.findings.filter((finding) => finding.severity === severity);
          if (findings.length === 0) return null;
          return (
            <ul key={severity} className={`overview-finding-group severity-${severity}`}>
              {findings.map((finding) => (
                <li key={finding.id} className={finding.decision === "drop" ? "dropped" : ""}>
                  <span className="severity">{severityLabels[severity]}</span>
                  <FindingNumber findingId={finding.id} />
                  <button type="button" className="link" onClick={() => onFinding(finding.id)}>
                    {finding.title}
                  </button>
                  <span className="anchor">{anchorLabel(finding.at)}</span>
                </li>
              ))}
            </ul>
          );
        })}
        {answers.length > 0 && (
          <>
            <h3>Conversations answered</h3>
            <ul className="overview-finding-group">
              {answers.map((answer) => (
                <li key={answer.id} className={answer.decision === "drop" ? "dropped" : ""}>
                  <button type="button" className="link" onClick={() => onAnswer(answer.id)}>
                    {conversationTopic(answer)}
                  </button>
                  <span className="anchor">{conversationPlace(answer)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <PostPanel item={item} />
      </section>
    </div>
  );
}

const MIN_LIST_WIDTH = 160;
const MIN_MAIN_WIDTH = 320;
const MIN_BAND_HEIGHT = 100;
const MIN_CODE_HEIGHT = 120;

const paneSharesStyle = (listShare: number, bandShare: number): Record<string, string> => ({
  "--review-list-share": String(listShare),
  "--flow-band": `${bandShare}fr`,
  "--flow-code": `${1 - bandShare}fr`,
});

/**
 * A tab's list and its main pane, with a divider that resizes the list and, in the Flow tab, one that resizes the
 * steps and explanation above the code. A drag only restyles the split, and the shares are kept once it ends.
 */
function ReviewSplit({
  className,
  shares,
  resizesBand = false,
  children: [list, main],
}: {
  className: string;
  shares: WalkthroughPaneShares;
  resizesBand?: boolean;
  children: [ReactNode, ReactNode];
}) {
  const split = useRef<HTMLDivElement>(null);
  const areaAlong = (axis: SplitAxis) => () => {
    const rect = split.current!.getBoundingClientRect();
    return axis === "columns" ? { start: rect.left, size: rect.width } : { start: rect.top, size: rect.height };
  };
  const showShares = (listShare: number, bandShare: number) =>
    Object.entries(paneSharesStyle(listShare, bandShare)).forEach(([name, value]) => split.current?.style.setProperty(name, value));
  return (
    <div ref={split} className={`review-split ${className}`} style={paneSharesStyle(shares.listShare, shares.bandShare) as CSSProperties}>
      {list}
      <Splitter
        label="Resize the list"
        share={shares.listShare}
        resetShare={DEFAULT_REVIEW_LIST_SHARE}
        minimumSize={MIN_LIST_WIDTH}
        secondMinimumSize={MIN_MAIN_WIDTH}
        area={areaAlong("columns")}
        onDrag={(listShare) => showShares(listShare, shares.bandShare)}
        onChange={shares.setListShare}
      />
      {main}
      {resizesBand && (
        <Splitter
          axis="rows"
          label="Resize the steps and the code"
          share={shares.bandShare}
          resetShare={DEFAULT_FLOW_BAND_SHARE}
          minimumSize={MIN_BAND_HEIGHT}
          secondMinimumSize={MIN_CODE_HEIGHT}
          area={areaAlong("rows")}
          onDrag={(bandShare) => showShares(shares.listShare, bandShare)}
          onChange={shares.setBandShare}
        />
      )}
    </div>
  );
}

function FlowTour({
  itemId,
  walk,
  shares,
  agentEdit,
  stepIndex,
  onStep,
  selection,
  onSelect,
  onGoToCode,
}: {
  itemId: string;
  walk: Walkthrough;
  shares: WalkthroughPaneShares;
  agentEdit: Review["agentEdit"];
  stepIndex: number;
  onStep: (index: number) => void;
  selection: LineSelection | null;
  onSelect: (selection: LineSelection) => void;
  onGoToCode: (anchor: CodeAnchor) => void;
}) {
  const step = walk.flow[stepIndex];
  const tourEdited = useAgentEdited(agentEdit, "flow");
  const host = useWalkthroughHost();
  if (!step) return <p className="review-empty">The agent described no code flow.</p>;
  return (
    <ReviewSplit className={`flow-tour ${tourEdited ? "agent-edited" : ""}`} shares={shares} resizesBand>
      <nav className="review-list" aria-label="Flow steps">
        <ol>
          {walk.flow.map((each, index) => (
            <li key={index}>
              <button type="button" className={index === stepIndex ? "selected" : ""} onClick={() => onStep(index)}>
                <span className="step-number">{index + 1}</span>
                <span className="step-title">{each.title}</span>
                <span className="anchor">{anchorLabel(each.at)}</span>
              </button>
            </li>
          ))}
        </ol>
      </nav>
      <section className="review-main flow-step">
        <div className="flow-step-text">
          <header className="flow-step-header">
            <span className="step-count">
              Step {stepIndex + 1} of {walk.flow.length}
            </span>
            <h3>{step.title}</h3>
            <button type="button" className="link anchor" onClick={() => onGoToCode(step.at)}>
              {anchorLabel(step.at)}
            </button>
            <button type="button" className="link" onClick={() => host.openInEditor(step.at.path, step.at.line)}>
              Open in IDEA
            </button>
          </header>
          <div className="flow-step-say">
            <MarkdownText text={step.say} />
            <div className="flow-step-nav">
              <button type="button" disabled={stepIndex === 0} onClick={() => onStep(stepIndex - 1)}>
                ← Previous
              </button>
              <button type="button" disabled={stepIndex === walk.flow.length - 1} onClick={() => onStep(stepIndex + 1)}>
                Next →
              </button>
            </div>
          </div>
        </div>
        <CodeBlock
          blockId={`flow-${stepIndex}`}
          path={step.at.path}
          rows={excerptRows(fileOf(walk, step.at.path), step.excerpt)}
          anchored={step.at}
          selection={selection}
          onSelect={onSelect}
        />
      </section>
    </ReviewSplit>
  );
}

function FileList({
  files,
  walk,
  findings,
  path,
  onPath,
  filterField,
  matchCounts,
}: {
  files: ReviewFile[];
  walk: Walkthrough;
  findings: ReviewFinding[];
  path: string | null;
  onPath: (path: string) => void;
  filterField: RefObject<HTMLInputElement | null>;
  /** How often each file holds the text the find bar finds. */
  matchCounts: Map<string, number>;
}) {
  const [filter, setFilter] = useState("");
  const typingAidAttributes = useWalkthroughHost().typingAidAttributes;
  const tourPaths = new Set(walk.flow.map((step) => step.at.path));
  const shown = files.filter((file) => file.path.toLowerCase().includes(filter.trim().toLowerCase()));
  const openFirstOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && shown[0]) onPath(shown[0].path);
    if (event.key === "Escape" && filter) {
      event.preventDefault();
      setFilter("");
    }
  };
  return (
    <nav className="review-list" aria-label="Changed files">
      <input
        {...typingAidAttributes}
        ref={filterField}
        className="file-filter"
        value={filter}
        placeholder="Filter files (f)"
        aria-label="Filter files"
        spellCheck={false}
        onChange={(event) => setFilter(event.target.value)}
        onKeyDown={openFirstOnEnter}
      />
      <ol>
        {shown.map((file) => {
          const findingCount = findings.filter((finding) => finding.at.path === file.path).length;
          const slash = file.path.lastIndexOf("/");
          return (
            <li key={file.path}>
              <button type="button" className={file.path === path ? "selected" : ""} title={file.path} onClick={() => onPath(file.path)}>
                <span className={`change change-${file.change}`}>{changeLetters[file.change]}</span>
                <span className="file-name">
                  <span className="file-directory">{file.path.slice(0, slash + 1)}</span>
                  {file.path.slice(slash + 1)}
                </span>
                {tourPaths.has(file.path) && (
                  <span className="in-tour" data-hint={hints.fileInTour}>
                    tour
                  </span>
                )}
                {(matchCounts.get(file.path) ?? 0) > 0 && (
                  <span className="match-count" data-hint={hints.reviewFileMatches}>
                    {matchCounts.get(file.path)}
                  </span>
                )}
                {findingCount > 0 && <span className="finding-count">{findingCount}</span>}
                <span className="added-count">+{file.added}</span>
                <span className="removed-count">−{file.removed}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export const reviewedFiles = new Map<string, Promise<string[]>>();

/** The reviewed version of a changed file, asked of the host once per review and file. */
export function reviewedFile(itemId: string, path: string, read: (path: string) => Promise<string[]>) {
  const key = `${itemId}:${path}`;
  if (!reviewedFiles.has(key)) {
    const request = read(path);
    request.catch(() => reviewedFiles.delete(key));
    reviewedFiles.set(key, request);
  }
  return reviewedFiles.get(key)!;
}

const linesLabel = (count: number) => (count === 1 ? "1 line" : `${count} lines`);

/** The row between two hunks (or at the file's top or end) that shows more of the file around them; it carries the hunk's header. */
function GapRow({
  place,
  hidden,
  wasRevealed,
  header,
  error,
  onReveal,
}: {
  place: GapPlace;
  hidden: number | null;
  wasRevealed: boolean;
  header: string | null;
  error: string | null;
  onReveal: (change: RevealChange) => void;
}) {
  const revealKeepingKeys = (change: RevealChange) => (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.currentTarget.closest<HTMLElement>(".review")?.focus({ preventScroll: true });
    onReveal(change);
  };
  if (hidden === 0 && (wasRevealed || !header)) return null;
  const fewLeft = hidden !== null && hidden <= CONTEXT_STEP;
  const down = place !== "top" && !fewLeft;
  const up = place !== "end" && !fewLeft;
  return (
    <div className="hunk-header">
      {hidden !== 0 && (
        <span className="gap-buttons">
          {down && (
            <button type="button" className="link" data-hint={hints.revealUnderPrevious} onClick={revealKeepingKeys(revealUnderPrevious)}>
              ↓ {CONTEXT_STEP} lines
            </button>
          )}
          {up && (
            <button type="button" className="link" data-hint={hints.revealOverNext} onClick={revealKeepingKeys(revealOverNext)}>
              ↑ {CONTEXT_STEP} lines
            </button>
          )}
          <button type="button" className="link" data-hint={hints.revealAll} onClick={revealKeepingKeys(revealAll(place))}>
            {hidden === null ? "Show the rest of the file" : fewLeft ? `Show ${linesLabel(hidden)}` : `All ${hidden} lines`}
          </button>
        </span>
      )}
      {header && <span className="hunk-header-text">{header}</span>}
      {error && <span className="gap-error">{error}</span>}
    </div>
  );
}

/** What was shown around each file's hunks, so it is still shown after a look at another tab or file. */
export const shownContexts = new Map<string, ShownContext>();

/** Drops cached file lines and revealed hunks from previous review items. */
export function evictStaleReviewCaches(currentItemId: string) {
  for (const key of shownContexts.keys()) {
    if (!key.startsWith(`${currentItemId}:`)) shownContexts.delete(key);
  }
  for (const key of reviewedFiles.keys()) {
    if (!key.startsWith(`${currentItemId}:`)) reviewedFiles.delete(key);
  }
}

function useRevealedContext(itemId: string, file: ReviewFile, onRevealed: () => void) {
  const host = useWalkthroughHost();
  const key = `${itemId}:${file.path}`;
  const gaps = useMemo(() => gapsOf(file), [file]);
  const [shown, setShown] = useState<ShownContext | null>(() => shownContexts.get(key) ?? null);
  const [error, setError] = useState<string | null>(null);
  const fileLines = shown?.fileLines ?? null;
  const revealed = shown?.revealed ?? gaps.map(() => nothingRevealed);

  const reveal = async (gapIndex: number, change: RevealChange) => {
    try {
      const lines = await reviewedFile(itemId, file.path, host.readFile);
      const next = {
        fileLines: lines,
        revealed: revealed.map((current, index) => (index === gapIndex ? change(current, hiddenCount(gaps[index]!, current, lines.length) ?? 0) : current)),
      };
      shownContexts.set(key, next);
      setShown(next);
      setError(null);
      onRevealed();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  const hunkRows = useMemo(() => hunkRowsShown(file, shown), [file, shown]);

  const gapRow = (gapIndex: number, header: string | null) => {
    const gap: Gap | undefined = gaps[gapIndex];
    if (!gap) return null;
    const current = revealed[gapIndex]!;
    return (
      <GapRow
        place={gapIndex === 0 ? "top" : gapIndex === gaps.length - 1 ? "end" : "between"}
        hidden={hiddenCount(gap, current, fileLines?.length ?? null)}
        wasRevealed={current.top + current.bottom > 0}
        header={header}
        error={error}
        onReveal={(change) => void reveal(gapIndex, change)}
      />
    );
  };

  return { hunkRows, gapRow, lastGap: gaps.length - 1 };
}

function FileDiff({
  itemId,
  walk,
  findings: allFindings,
  findingCard: card,
  file,
  hunkIndex,
  selection,
  onSelect,
  onRevealed,
}: {
  itemId: string;
  walk: Walkthrough;
  findings: ReviewFinding[];
  findingCard: (finding: ReviewFinding) => ReactNode;
  file: ReviewFile;
  hunkIndex: number;
  selection: LineSelection | null;
  onSelect: (selection: LineSelection) => void;
  onRevealed: () => void;
}) {
  const host = useWalkthroughHost();
  const { hunkRows, gapRow, lastGap } = useRevealedContext(itemId, file, onRevealed);
  const findings = allFindings.filter((finding) => finding.at.path === file.path);
  const shownLines = new Set(hunkRows.flat().map((row) => row.newLine));
  const onDiff = findings.filter((finding) => shownLines.has(finding.at.endLine));
  const elsewhere = findings.filter((finding) => !onDiff.includes(finding));
  const steps = walk.flow.map((step, index) => ({ step, index })).filter(({ step }) => step.at.path === file.path);
  const afterRow = (row: DiffRow) => (
    <>
      {steps
        .filter(({ step }) => row.newLine === step.at.line)
        .map(({ step, index }) => (
          <div key={`step-${index}`} className="flow-marker">
            Flow step {index + 1}: {step.title}
          </div>
        ))}
      {onDiff.filter((finding) => row.newLine === finding.at.endLine).map(card)}
    </>
  );
  return (
    <section className="review-main file-diff">
      <header className="file-header">
        <span className={`change change-${file.change}`}>{changeLetters[file.change]}</span>
        <h3>{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</h3>
        <span className="added-count">+{file.added}</span>
        <span className="removed-count">−{file.removed}</span>
        <span className="spacer" />
        {file.change !== "deleted" && (
          <button type="button" className="link" onClick={() => host.openInEditor(file.path, lineToOpen(file.hunks[hunkIndex]?.rows ?? []))}>
            Open in IDEA
          </button>
        )}
      </header>
      {elsewhere.length > 0 && (
        <div className="findings-elsewhere">
          <p className="hint">On lines this diff doesn't show:</p>
          {elsewhere.map(card)}
        </div>
      )}
      {file.hiddenBecause && <p className="review-empty">Not shown: {file.hiddenBecause}.</p>}
      {!file.hiddenBecause && file.hunks.length === 0 && <p className="review-empty">No changes to its lines{file.change === "renamed" ? "; only renamed" : ""}.</p>}
      {file.hunks.map((hunk, index) => (
        <div key={index} className={`hunk ${index === hunkIndex ? "current" : ""}`} data-hunk={index}>
          {gapRow(index, hunk.header || `line ${hunk.newStart}`)}
          <CodeBlock blockId={`file-${file.path}-${index}`} path={file.path} rows={hunkRows[index]!} selection={selection} onSelect={onSelect} after={afterRow} />
          {index === file.hunks.length - 1 && gapRow(lastGap, null)}
        </div>
      ))}
    </section>
  );
}

function AskAboutLines({
  label,
  canUpdateReview,
  onSend,
  onClose,
}: {
  label: string;
  canUpdateReview: boolean;
  onSend: (question: string, updatesReview: boolean) => void;
  onClose: () => void;
}) {
  const [question, setQuestion] = useState("");
  const typingAidAttributes = useWalkthroughHost().typingAidAttributes;
  const { primary } = keyLabels();
  const sendOnEnter = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (question.trim()) onSend(question, canUpdateReview && (isMac ? event.metaKey : event.ctrlKey));
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };
  return (
    <div className="ask-about-lines" role="dialog" aria-label="Ask the agent about these lines">
      <div className="ask-about-label">Ask the agent about {label}</div>
      <textarea
        {...typingAidAttributes}
        autoFocus
        value={question}
        rows={2}
        placeholder={`Your question (Enter asks, ${canUpdateReview ? `${primary}Enter asks and updates the review, ` : ""}Shift+Enter for a new line, Esc cancels)`}
        onChange={(event) => setQuestion(event.target.value)}
        onKeyDown={sendOnEnter}
      />
      <div className="ask-about-actions">
        <button type="button" className="primary" disabled={!question.trim()} onClick={() => onSend(question, false)}>
          Ask
        </button>
        {canUpdateReview && (
          <button type="button" disabled={!question.trim()} onClick={() => onSend(question, true)} data-hint={hints.askAndUpdateReview}>
            Ask and update the review
          </button>
        )}
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

const isTextField = (target: EventTarget) => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;

function useScrollIntoView(
  root: RefObject<HTMLElement | null>,
  selector: string | null,
  when: unknown = selector,
  {
    exceptOnOpening = false,
    justRestored,
    scrolledByFind,
  }: { exceptOnOpening?: boolean; justRestored?: RefObject<boolean>; scrolledByFind?: RefObject<boolean> } = {},
) {
  const opened = useRef(false);
  useEffect(() => {
    const opening = !opened.current;
    opened.current = true;
    if (scrolledByFind?.current) {
      scrolledByFind.current = false;
      return;
    }
    if (selector && !(opening && exceptOnOpening) && !justRestored?.current) root.current?.querySelector(selector)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [when]);
}


/**
 * A review or a tour as a guided read: the agent's summary, a tour of the code flow and the diff; a review adds the
 * findings on their lines, to keep, drop, edit and post. Keys: 1-5 tabs, ←/→ tour steps, j/k changes, n/p findings,
 * f files, o open in IDEA, a ask the agent about the selected lines.
 */
export function WalkthroughView({ item, host }: { item: WalkthroughItem; host: WalkthroughHost }) {
  return (
    <WalkthroughHostContext.Provider value={host}>
      <Walkthrough item={item} />
    </WalkthroughHostContext.Provider>
  );
}

function Walkthrough({ item }: { item: WalkthroughItem }) {
  const host = useWalkthroughHost();
  const reviewItem = isReviewItem(item) ? item : null;
  const review = reviewItem?.review ?? null;
  const walk: Walkthrough = isReviewItem(item) ? item.review : item.tour;
  const showsChanges = isReviewItem(item) || item.tour.changes !== null;
  const findings = review?.findings ?? [];
  const root = useRef<HTMLDivElement>(null);
  const filterField = useRef<HTMLInputElement>(null);
  const files = useMemo(() => filesInReadingOrder(walk), [walk.files, walk.flow]);
  const [placeLeft] = useState(host.placeLeft);
  const [scrolled] = useState(() => placeLeft?.scrolled ?? {});
  const [tab, setTab] = useState<Tab>(placeLeft?.tab ?? "overview");
  const [chosenStep, setStepIndex] = useState(placeLeft?.stepIndex ?? 0);
  const paneShares = host.paneShares;
  const stepIndex = Math.min(chosenStep, Math.max(walk.flow.length - 1, 0));
  const [path, setPath] = useState<string | null>(placeLeft?.path ?? files[0]?.path ?? null);
  const [hunkIndex, setHunkIndex] = useState(placeLeft?.hunkIndex ?? 0);
  const [findingId, setFindingId] = useState<string | null>(placeLeft?.findingId ?? findings[0]?.id ?? null);
  const answers = review ? answersOf(review) : [];
  const [answerId, setAnswerId] = useState<string | null>(placeLeft?.answerId ?? null);
  const tabShown: Record<Tab, boolean> = { overview: true, flow: true, files: showsChanges, findings: review !== null, conversations: answers.length > 0 };
  const shownTabs = tabs.filter(({ id }) => tabShown[id]);
  const [selection, setSelection] = useState<LineSelection | null>(null);
  const [asking, setAsking] = useState<AskingAbout | null>(null);
  const [sentNote, setSentNote] = useState<string | null>(null);
  const [shownAgentEdits] = useState(() => ({ openedWith: review?.agentEdit?.at, flashed: new Map<string, number>() }));
  const fullscreen = host.fullscreen;
  const file = files.find((each) => each.path === path) ?? files[0];
  const finding = findings.find(({ id }) => id === findingId);

  useEffect(() => {
    evictStaleReviewCaches(item.id);
  }, [item.id]);

  useEffect(() => {
    const typingElsewhere = isTextField(document.activeElement ?? document.body) && !document.activeElement?.closest("[inert]");
    if (!typingElsewhere) root.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    host.leavePlace({ tab, stepIndex: chosenStep, path, hunkIndex, findingId, answerId, scrolled });
  }, [tab, chosenStep, path, hunkIndex, findingId, answerId]);
  useEffect(() => {
    const view = root.current;
    const rememberScroll = ({ target }: Event) => {
      if (target instanceof HTMLElement && target !== view) (scrolled[tab] ??= {})[target.className] = target.scrollTop;
    };
    view?.addEventListener("scroll", rememberScroll, { capture: true, passive: true });
    return () => view?.removeEventListener("scroll", rememberScroll, { capture: true });
  }, [tab]);
  // A tab the user switches back to shows where they left it; a jump to a place in a tab shows that place.
  const reopening = useRef(true);
  const justRestored = useRef(false);
  useLayoutEffect(() => {
    const saved = reopening.current ? scrolled[tab] : undefined;
    reopening.current = false;
    justRestored.current = saved !== undefined && Object.keys(saved).length > 0;
    Object.entries(saved ?? {}).forEach(([className, top]) => {
      const part = root.current?.querySelector(`[class="${className}"]`);
      if (part) part.scrollTop = top;
    });
  }, [tab]);
  const keepsPlaceLeft = { exceptOnOpening: placeLeft !== undefined, justRestored };
  const scrolledByFind = useRef(false);
  useScrollIntoView(root, tab === "files" ? `[data-hunk="${hunkIndex}"]` : null, `${tab} ${file?.path} ${hunkIndex}`, { ...keepsPlaceLeft, scrolledByFind });
  useScrollIntoView(root, findingId && (tab === "files" || tab === "findings") ? `[data-finding-id="${findingId}"]` : null, undefined, keepsPlaceLeft);
  useScrollIntoView(root, answerId && tab === "conversations" ? `[data-answer-id="${answerId}"]` : null, undefined, keepsPlaceLeft);
  useEffect(() => {
    justRestored.current = false;
  }, [tab]);

  const reopenTab = (id: Tab) => {
    reopening.current = id !== tab;
    setTab(id);
  };
  const showFile = (nextPath: string, nextHunk = 0) => {
    setTab("files");
    setPath(nextPath);
    setHunkIndex(nextHunk);
  };
  const goToCode = (anchor: CodeAnchor) => {
    const target = fileOf(walk, anchor.path);
    if (!target) return host.openInEditor(anchor.path, anchor.line);
    const hunk = target.hunks.findIndex((each) => each.rows.some((row) => isWithin(row.newLine, anchor)));
    showFile(anchor.path, Math.max(0, hunk));
  };
  const showFinding = (id: string, where: "files" | "findings") => {
    setFindingId(id);
    const target = findings.find((each) => each.id === id);
    if (where === "files" && target && fileOf(walk, target.at.path)) goToCode(target.at);
    else setTab("findings");
  };
  const stepFinding = (step: 1 | -1) => {
    if (findings.length === 0) return;
    const index = findings.findIndex(({ id }) => id === findingId);
    const next = findings[(index + step + findings.length) % findings.length]!;
    showFinding(next.id, tab === "files" ? "files" : "findings");
  };
  const stepHunk = (step: 1 | -1) => {
    const fileIndex = files.findIndex((each) => each.path === file?.path);
    const nextHunk = hunkIndex + step;
    if (file && nextHunk >= 0 && nextHunk < file.hunks.length) return setHunkIndex(nextHunk);
    const following = step === 1 ? files.slice(fileIndex + 1) : files.slice(0, Math.max(0, fileIndex)).reverse();
    const nextFile = following.find((each) => each.hunks.length > 0);
    if (nextFile) showFile(nextFile.path, step === 1 ? 0 : nextFile.hunks.length - 1);
  };
  const showStep = (index: number) => {
    setStepIndex(index);
    setTab("flow");
    root.current?.focus({ preventScroll: true });
  };
  const stepTour = (step: 1 | -1) => setStepIndex((index) => Math.min(Math.max(index + step, 0), Math.max(walk.flow.length - 1, 0)));
  const [linesRevealed, noteLinesRevealed] = useReducer((count: number) => count + 1, 0);
  const find = useReviewFind({
    files,
    rowsShownOf: (shownFile) => hunkRowsShown(shownFile, shownContexts.get(`${item.id}:${shownFile.path}`) ?? null),
    openPath: file?.path ?? null,
    linesRevealed,
    showing: tab === "files",
    root,
    onOpen: (nextPath, nextHunk) => {
      if (tab === "files" && nextPath === file?.path && nextHunk === hunkIndex) return;
      scrolledByFind.current = true;
      showFile(nextPath, nextHunk);
    },
  });
  const openFind = () => {
    reopenTab("files");
    find.open();
  };

  const currentPlace = (): AskingAbout | null => {
    if (selection) return selection;
    if (tab === "flow" && walk.flow[stepIndex]) {
      const step = walk.flow[stepIndex]!;
      return { path: step.at.path, rows: excerptRows(fileOf(walk, step.at.path), step.excerpt).filter((row) => row.kind === "elided" || isWithin(row.newLine, step.at)) };
    }
    if (tab === "files" && file?.hunks[hunkIndex]) return { path: file.path, rows: file.hunks[hunkIndex]!.rows };
    if (tab === "findings" && finding) return placeOfFinding(finding);
    return null;
  };
  const placeOfFinding = (target: ReviewFinding): AskingAbout => ({
    findingId: target.id,
    path: target.at.path,
    rows: excerptRows(fileOf(walk, target.at.path), target.excerpt).filter((row) => row.kind === "elided" || isWithin(row.newLine, target.at)),
  });
  const askingLabel = (place: AskingAbout) => {
    const askedFinding = findings.find(({ id }) => id === place.findingId);
    return askedFinding ? `the finding "${askedFinding.title}" at ${selectionLabel(place)}` : selectionLabel(place);
  };
  const askAboutCurrentPlace = () => {
    const place = currentPlace();
    if (place && place.rows.length > 0) setAsking(place);
  };
  const openCurrentPlace = () => {
    const place = currentPlace();
    if (place) host.openInEditor(place.path, lineToOpen(place.rows));
  };
  const send = async (question: string, updatesReview: boolean) => {
    if (!asking) return;
    const askedFinding = findings.find(({ id }) => id === asking.findingId);
    const text = questionAbout(item, asking, askedFinding, question, updatesReview);
    if (!(await host.ask(text))) return;
    const updating = updatesReview ? ", and the agent updates the parts of the review it changes" : "";
    setSentNote(`Asked about ${askingLabel(asking)}. The answer comes in the chat${updating}.`);
    setAsking(null);
    setSelection(null);
    root.current?.focus();
  };

  const keyActions: Record<string, () => void> = {
    ArrowLeft: () => tab === "flow" && stepTour(-1),
    ArrowRight: () => tab === "flow" && stepTour(1),
    j: () => (tab === "findings" ? stepFinding(1) : stepHunk(1)),
    k: () => (tab === "findings" ? stepFinding(-1) : stepHunk(-1)),
    n: () => stepFinding(1),
    p: () => stepFinding(-1),
    f: () => {
      if (!showsChanges) return;
      reopenTab("files");
      requestAnimationFrame(() => filterField.current?.focus());
    },
    o: openCurrentPlace,
    a: askAboutCurrentPlace,
    ...Object.fromEntries(shownTabs.map(({ id, key }) => [key, () => reopenTab(id)])),
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || isTextField(event.target)) return;
    if (event.key === "Escape" && (selection || sentNote)) {
      event.preventDefault();
      setSelection(null);
      setSentNote(null);
      return;
    }
    const action = keyActions[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  };
  const select = (next: LineSelection) => {
    setSelection(next);
    setSentNote(null);
  };

  return (
    <ShownAgentEdits.Provider value={shownAgentEdits}>
      <div className="review" ref={root} tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="review-bar">
          <div className="review-tabs" role="tablist" aria-label={reviewItem ? "Review" : "Tour"}>
            {shownTabs.map(({ id, label, key }) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "selected" : ""} data-shortcut={key} onClick={() => reopenTab(id)}>
                {label}
                {id === "flow" && <span className="tab-count">{walk.flow.length}</span>}
                {id === "files" && <span className="tab-count">{walk.files.length}</span>}
                {id === "findings" && <span className="tab-count">{findings.filter((each) => each.decision === "keep").length}</span>}
                {id === "conversations" && <span className="tab-count">{answers.filter((each) => each.decision === "keep").length}</span>}
              </button>
            ))}
          </div>
          <span className="spacer" />
          {selection && (
            <span className="selection-actions">
              <span className="selection-label">{selectionLabel(selection)}</span>
              <button type="button" onClick={() => setAsking(selection)}>
                Ask (a)
              </button>
              <button type="button" onClick={() => host.openInEditor(selection.path, lineToOpen(selection.rows))}>
                Open in IDEA (o)
              </button>
            </span>
          )}
          {tabShown.files && (
            <button type="button" className="review-find-trigger" data-hint={hints.reviewFind} data-shortcut={shortcutKeys().find} onClick={openFind}>
              Find
            </button>
          )}
          {fullscreen && (
            <button
              type="button"
              className="placement-toggle"
              data-hint={reviewItem ? hints.reviewPlacement : hints.tourPlacement}
              onClick={() => fullscreen.setFullscreen(!fullscreen.isFullscreen)}
            >
              {fullscreen.isFullscreen ? "Beside the chat" : "Full screen"}
            </button>
          )}
        </div>
        {tab === "files" && find.query !== null && <ReviewFindBar find={find} />}
        <div className="review-body">
          {tab === "overview" && reviewItem && (
            <Overview
              item={reviewItem}
              onStep={showStep}
              onFinding={(id) => showFinding(id, "findings")}
              onAnswer={(id) => {
                setAnswerId(id);
                setTab("conversations");
              }}
            />
          )}
          {tab === "overview" && !isReviewItem(item) && <TourOverview tour={item.tour} onStep={showStep} />}
          {tab === "flow" && (
            <FlowTour
              itemId={item.id}
              walk={walk}
              shares={paneShares}
              agentEdit={review?.agentEdit}
              stepIndex={stepIndex}
              onStep={setStepIndex}
              selection={selection}
              onSelect={select}
              onGoToCode={goToCode}
            />
          )}
          {tab === "files" && (
            <ReviewSplit className="files-view" shares={paneShares}>
              <FileList
                files={files}
                walk={walk}
                findings={findings}
                path={file?.path ?? null}
                onPath={(next) => showFile(next)}
                filterField={filterField}
                matchCounts={find.matchCounts}
              />
              {file ? (
                <FileDiff
                  key={file.path}
                  itemId={item.id}
                  walk={walk}
                  findings={findings}
                  findingCard={(target) =>
                    reviewItem && (
                      <FindingCard
                        key={target.id}
                        item={reviewItem}
                        finding={target}
                        selected={target.id === findingId}
                        showsCode={false}
                        selection={selection}
                        onSelect={select}
                        onAsk={() => setAsking(placeOfFinding(target))}
                      />
                    )
                  }
                  file={file}
                  hunkIndex={hunkIndex}
                  selection={selection}
                  onSelect={select}
                  onRevealed={noteLinesRevealed}
                />
              ) : (
                <p className="review-empty">No files changed.</p>
              )}
            </ReviewSplit>
          )}
          {tab === "findings" && reviewItem && (
            <div className="findings-view">
              {findings.length === 0 && <p className="review-empty">The agent found nothing to comment on.</p>}
              {findings.map((each) => (
                <FindingCard
                  key={each.id}
                  item={reviewItem}
                  finding={each}
                  selected={each.id === findingId}
                  showsCode
                  selection={selection}
                  onSelect={select}
                  onGoToCode={() => goToCode(each.at)}
                  onAsk={() => setAsking(placeOfFinding(each))}
                />
              ))}
              <PostPanel item={reviewItem} />
            </div>
          )}
          {tab === "conversations" && reviewItem && (
            <div className="findings-view">
              {answers.map((each) => (
                <AnswerCard key={each.id} item={reviewItem} answer={each} selected={each.id === answerId} />
              ))}
              <PostPanel item={reviewItem} />
            </div>
          )}
        </div>
        {asking && (
          <AskAboutLines
            label={askingLabel(asking)}
            canUpdateReview={reviewItem !== null}
            onSend={send}
            onClose={() => {
              setAsking(null);
              root.current?.focus();
            }}
          />
        )}
        {sentNote && (
          <div className="review-sent" role="status">
            {sentNote}
            {fullscreen?.isFullscreen && (
              <button type="button" className="link" onClick={() => fullscreen.setFullscreen(false)}>
                Show the chat
              </button>
            )}
          </div>
        )}
        <footer className="review-keys" aria-hidden="true">
          <kbd>1</kbd>–<kbd>{shownTabs.length}</kbd> tabs · <kbd>←</kbd>/<kbd>→</kbd> tour ·{" "}
          {showsChanges && (
            <>
              <kbd>j</kbd>/<kbd>k</kbd> changes ·{" "}
            </>
          )}
          {reviewItem && (
            <>
              <kbd>n</kbd>/<kbd>p</kbd> findings ·{" "}
            </>
          )}
          {showsChanges && (
            <>
              <kbd>f</kbd> files · <kbd>{shortcutKeys().find}</kbd> find ·{" "}
            </>
          )}
          click line numbers (⇧ to extend), then <kbd>a</kbd> ask or <kbd>o</kbd> open in IDEA
        </footer>
      </div>
    </ShownAgentEdits.Provider>
  );
}
