import {
  answersOf,
  findingNumber,
  type CodeAnchor,
  type CodeExcerpt,
  type FindingCheck,
  type FindingSeverity,
  type Review,
  type ReviewAnswer,
  type ReviewFinding,
} from "../../shared/review.ts";
import { AnchorReader, commitLines, mapInOrder, ReviewProblems } from "./snapshot.ts";

export interface NewFinding {
  severity: FindingSeverity;
  checked: FindingCheck;
  at: string;
  title: string;
  body: string;
  evidence?: string;
}

export type FindingEdit = Partial<NewFinding> & { id: string };

export interface AnswerEdit {
  id: string;
  body?: string;
  resolve?: boolean;
}

/** What the agent changes in a review it already published, naming findings and answers by the ids the review tool reported. */
export interface ReviewEdit {
  verdict?: string;
  summary?: string;
  /** The whole tour, replacing it. */
  flow?: { title: string; at: string; say: string }[];
  findings?: FindingEdit[];
  addFindings?: NewFinding[];
  removeFindings?: string[];
  answers?: AnswerEdit[];
}

type Anchored = { at: CodeAnchor; excerpt: CodeExcerpt } | null;

/** The code lines an edit names, read against the reviewed version, by position in the edit. */
export interface EditAnchors {
  flow: Anchored[];
  findings: Anchored[];
  addFindings: Anchored[];
  problems: string[];
}

export const REVIEW_NOT_CHANGED = "The review was not changed. Fix these and call update_review again";

/** Reads git, so it runs before the edit is applied to the review as it is by then. */
export async function readEditAnchors(review: Review, edit: ReviewEdit): Promise<EditAnchors> {
  const problems: string[] = [];
  const anchors = new AnchorReader(review.repository, commitLines(review.repository, review.headCommit), problems);
  const readEach = <T extends { at?: string }>(entries: T[] | undefined, where: (entry: T, index: number) => string) =>
    mapInOrder(entries ?? [], (entry, index) => (entry.at === undefined ? Promise.resolve(null) : anchors.read(entry.at, where(entry, index))));
  return {
    flow: await readEach(edit.flow, (step, index) => `flow step ${index + 1} ("${step.title}")`),
    findings: await readEach(edit.findings, (finding) => finding.id),
    addFindings: await readEach(edit.addFindings, (finding, index) => `added finding ${index + 1} ("${finding.title}")`),
    problems,
  };
}

export const definedOnly = <T extends object>(fields: T) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>;

/** The review tool's result writes "finding 2" in sentences and finding-2 as an id; either names the same finding. */
const idNamed = (name: string) => name.trim().replace(/\s+/, "-");

const touchesAnything = (edit: ReviewEdit) =>
  [edit.verdict, edit.summary, edit.flow, edit.findings?.length, edit.addFindings?.length, edit.removeFindings?.length, edit.answers?.length].some(Boolean);

/**
 * The review with the agent's edit applied, the user's keep or drop and rewording of everything else as they were. A new
 * body replaces the user's rewording too: the agent was asked with the wording the user sees.
 */
export function applyReviewEdit(review: Review, edit: ReviewEdit, anchors: EditAnchors) {
  const problems = [...anchors.problems];
  if (!touchesAnything(edit)) problems.push("Nothing to change: pass a verdict, a summary, the tour, or findings or answers to change, add or remove.");
  const editable = <T extends { id: string; postedAs?: object }>(all: T[], name: string, kind: string) => {
    const id = idNamed(name);
    const found = all.find((each) => each.id === id);
    if (!found) problems.push(`${id} is not one of this review's ${kind}s (${all.map((each) => each.id).join(", ") || "it has none"}).`);
    else if (found.postedAs) problems.push(`${id} is already on the pull request; change it there.`);
    return found && !found.postedAs ? found : null;
  };

  const editedFindings = new Map<string, ReviewFinding>();
  (edit.findings ?? []).forEach(({ id, at: _, ...change }, index) => {
    const finding = editable(review.findings, id, "finding");
    if (!finding) return;
    if (editedFindings.has(finding.id)) return problems.push(`${finding.id} is changed twice; change each finding once.`);
    const { agentBody, postError: _postError, ...unchanged } = finding;
    const userWordingStays = change.body === undefined && agentBody !== undefined;
    editedFindings.set(finding.id, { ...unchanged, ...(userWordingStays && { agentBody }), ...definedOnly(change), ...anchors.findings[index] });
  });
  const removed = new Set(
    (edit.removeFindings ?? []).flatMap((name) => {
      const finding = editable(review.findings, name, "finding");
      if (finding && editedFindings.has(finding.id)) problems.push(`${finding.id} is both changed and taken out; pick one.`);
      return finding?.id ?? [];
    }),
  );
  const lastNumber = Math.max(review.lastFindingNumber ?? 0, ...review.findings.map(({ id }) => findingNumber(id)));
  const added = (edit.addFindings ?? []).flatMap((finding, index): ReviewFinding[] => {
    const anchored = anchors.addFindings[index];
    return anchored ? [{ ...finding, ...anchored, id: `finding-${lastNumber + index + 1}`, decision: "keep" }] : [];
  });

  const answers = answersOf(review);
  const editedAnswers = new Map<string, ReviewAnswer>();
  (edit.answers ?? []).forEach(({ id, body, resolve }) => {
    const answer = editable(answers, id, "answer");
    if (!answer) return;
    const { agentBody, postError: _postError, ...unchanged } = answer;
    const userWordingStays = body === undefined && agentBody !== undefined;
    editedAnswers.set(answer.id, { ...unchanged, ...(userWordingStays && { agentBody }), ...definedOnly({ body, suggestsResolving: resolve }) });
  });
  if (problems.length > 0) throw new ReviewProblems(problems, REVIEW_NOT_CHANGED);

  const changed = [
    ...(edit.verdict !== undefined ? ["verdict"] : []),
    ...(edit.summary !== undefined ? ["summary"] : []),
    ...(edit.flow ? ["flow"] : []),
    ...editedFindings.keys(),
    ...added.map(({ id }) => id),
    ...editedAnswers.keys(),
  ];
  return {
    review: {
      ...review,
      ...definedOnly({ verdict: edit.verdict, summary: edit.summary }),
      ...(edit.flow && { flow: edit.flow.map((step, index) => ({ title: step.title, say: step.say, ...anchors.flow[index]! })) }),
      findings: [...review.findings.filter(({ id }) => !removed.has(id)).map((finding) => editedFindings.get(finding.id) ?? finding), ...added],
      lastFindingNumber: lastNumber + added.length,
      answers: answers.map((answer) => editedAnswers.get(answer.id) ?? answer),
    },
    changed,
    removed: [...removed],
  };
}
