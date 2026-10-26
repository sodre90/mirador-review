import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import {
  anchorLabel,
  parseAnchor,
  type CodeAnchor,
  type CodeExcerpt,
  type FindingCheck,
  type FindingSeverity,
  type Review,
} from "../../shared/review.ts";
import { hideUnreadableDiffs, parseGitDiff } from "./diff.ts";
import { parsePullRequestUrl } from "./github.ts";

export interface ReviewRequest {
  title: string;
  repository: string;
  base: string;
  head?: string;
  pullRequest?: string;
  verdict: string;
  summary: string;
  flow: { title: string; at: string; say: string }[];
  findings: { severity: FindingSeverity; checked: FindingCheck; at: string; title: string; body: string; evidence?: string }[];
  answers?: { conversation: string; body: string; resolve?: boolean }[];
}

/** What the agent has to fix before the review can be shown; all of it at once, so one more call is enough. */
export class ReviewProblems extends Error {
  constructor(
    readonly problems: string[],
    lead = "The review was not shown. Fix these and call review again",
  ) {
    super(`${lead}:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  }
}

/** Waits for each check, so the agent hears of the problems of all of them in one go. */
export async function allOrEveryProblem<A, B>(first: Promise<A>, second: Promise<B>): Promise<[A, B]> {
  const settled = await Promise.allSettled([first, second]);
  const problems = settled.flatMap((result) => (result.status === "rejected" && result.reason instanceof ReviewProblems ? result.reason.problems : []));
  if (problems.length > 0) throw new ReviewProblems(problems);
  const failure = settled.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  return settled.map((result) => (result as PromiseFulfilledResult<unknown>).value) as [A, B];
}

const EXCERPT_CONTEXT_LINES = 6;
const MAX_EXCERPT_LINES = 160;

export async function git(directory: string, args: string[], environment: Record<string, string> = {}) {
  const child = Bun.spawn(["git", "-C", directory, "-c", "core.quotepath=false", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...environment },
  });
  const [output, errors, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) throw new Error(errors.trim() || `git ${args[0]} failed`);
  return output;
}

export async function gitOrProblem(directory: string, args: string[], problems: string[], describe: (error: string) => string) {
  try {
    return await git(directory, args);
  } catch (error) {
    problems.push(describe(error instanceof Error ? error.message : String(error)));
    return null;
  }
}

const linesOfText = (text: string) => text.replace(/\n$/, "").split("\n");

export const linesAt = async (root: string, treeish: string, path: string) => linesOfText(await git(root, ["cat-file", "blob", `${treeish}:${path}`]));

/** Where anchors read their lines from, named the way a problem with a missing file says it. */
export interface LineSource {
  lines(path: string): Promise<string[] | null>;
  /** e.g. "in the reviewed version (1a2b3c4d5e)". */
  where: string;
}

export const commitLines = (root: string, commit: string): LineSource => ({
  lines: (path) => linesAt(root, commit, path).catch(() => null),
  where: `in the reviewed version (${commit.slice(0, 10)})`,
});

const isOutside = (relativePath: string) => relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);

/** `path` from `folder` with no `.` or `..` left in it, or null when it leads out of the folder. */
export function pathInside(folder: string, path: string) {
  const inside = relative(folder, resolve(folder, path));
  return isOutside(inside) ? null : inside;
}

/** Files as they are on disk now, gitignored ones included, as long as they are inside `folder`. */
export const diskLines = (folder: string): LineSource => ({
  lines: async (path) => {
    const inside = pathInside(folder, path);
    const file = inside && join(folder, inside);
    if (!file || !existsSync(file) || !statSync(file).isFile()) return null;
    return linesOfText(await Bun.file(file).text());
  },
  where: `in ${folder}`,
});

/** The reviewed version of one of the review's changed files, so the page can show more of it than the diff does. */
export async function reviewedFileLines(review: Review, path: string) {
  const file = review.files.find((candidate) => candidate.path === path);
  if (!file || file.change === "deleted") throw new Error(`${path} is not a file this review changes.`);
  return linesAt(review.repository, review.headCommit, path);
}

/** The anchor with as much context as the cap leaves room for, before the anchor first; an anchor over the cap keeps its two ends. */
function excerptAround({ line, endLine }: CodeAnchor, fileLines: string[]): CodeExcerpt {
  const anchorLength = endLine - line + 1;
  const spare = MAX_EXCERPT_LINES - anchorLength;
  if (spare >= 0) {
    const contextBefore = Math.min(EXCERPT_CONTEXT_LINES, line - 1, spare);
    const contextAfter = Math.min(EXCERPT_CONTEXT_LINES, fileLines.length - endLine, spare - contextBefore);
    return { startLine: line - contextBefore, lines: fileLines.slice(line - 1 - contextBefore, endLine + contextAfter) };
  }
  const shown = MAX_EXCERPT_LINES - 1;
  const head = Math.floor(shown / 2);
  const tail = shown - head;
  return {
    startLine: line,
    lines: [...fileLines.slice(line - 1, line - 1 + head), ...fileLines.slice(endLine - tail, endLine)],
    elision: { after: head - 1, lineCount: anchorLength - shown },
  };
}

/** Reads anchors against the reviewed version, collecting what is wrong with them instead of stopping at the first. */
export class AnchorReader {
  private readonly fileLines = new Map<string, Promise<string[] | null>>();

  constructor(
    private readonly root: string,
    private readonly source: LineSource,
    private readonly problems: string[],
  ) {}

  async read(text: string, where: string): Promise<{ at: CodeAnchor; excerpt: CodeExcerpt } | null> {
    const parsed = parseAnchor(text);
    if (!parsed) {
      this.problems.push(`${where}: "${text}" is not "path:line" or "path:start-end".`);
      return null;
    }
    const at = { ...parsed, path: this.relativePath(parsed.path) };
    const lines = await this.linesOf(at.path);
    if (!lines) {
      this.problems.push(`${where}: ${at.path} is not a file ${this.source.where}; paths are relative to ${this.root}.`);
      return null;
    }
    if (at.line < 1 || at.endLine < at.line || at.endLine > lines.length) {
      this.problems.push(`${where}: ${anchorLabel(at)} is outside the file, which has ${lines.length} lines.`);
      return null;
    }
    return { at, excerpt: excerptAround(at, lines) };
  }

  /**
   * An absolute path as git names the file: the native realpath also expands Windows' short 8.3 names, which git never
   * reports its checkout by, and git separates folders with / on Windows too.
   */
  private relativePath(path: string) {
    const fromRoot = isAbsolute(path) ? relative(this.root, existsSync(path) ? realpathSync.native(path) : path).split(sep).join(posix.sep) : path;
    return fromRoot.replace(/^\.\//, "");
  }

  private linesOf(path: string) {
    if (!this.fileLines.has(path)) {
      this.fileLines.set(path, this.source.lines(path));
    }
    return this.fileLines.get(path)!;
  }
}

/**
 * The review as the user will read it: the agent's tour and findings, anchored in the reviewed version, and the diff
 * from git rather than from the agent, so the code shown is the code that was reviewed.
 */
export async function snapshotReview(request: ReviewRequest): Promise<Review> {
  const problems: string[] = [];
  const pullRequest = request.pullRequest ? parsePullRequestOrProblem(request.pullRequest, problems) : null;
  const root = (await gitOrProblem(request.repository, ["rev-parse", "--show-toplevel"], problems, () => `repository: ${request.repository} is not inside a git checkout.`))?.trim();
  if (!root) throw new ReviewProblems(problems);

  const head = request.head ?? "HEAD";
  const headCommit = (await gitOrProblem(root, ["rev-parse", "--verify", `${head}^{commit}`], problems, () => `head: ${head} is not a commit in ${root}.`))?.trim();
  const baseCommit = headCommit
    ? (await gitOrProblem(root, ["merge-base", request.base, headCommit], problems, () => `base: ${request.base} has no common history with ${head} in ${root}.`))?.trim()
    : null;
  if (!headCommit || !baseCommit) throw new ReviewProblems(problems);

  const diff = await gitOrProblem(
    root,
    ["diff", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", "--find-renames", "-U3", baseCommit, headCommit],
    problems,
    (error) => `diff: git could not compare ${request.base} and ${head} in ${root}: ${error.trim().replace(/\.$/, "")}`,
  );
  if (diff === null) throw new ReviewProblems(problems);
  const anchors = new AnchorReader(root, commitLines(root, headCommit), problems);
  const flow = await mapInOrder(request.flow, async (step, index) => {
    const anchored = await anchors.read(step.at, `flow step ${index + 1} ("${step.title}")`);
    return anchored && { title: step.title, say: step.say, ...anchored };
  });
  const findings = await mapInOrder(request.findings, async (finding, index) => {
    const anchored = await anchors.read(finding.at, `finding ${index + 1} ("${finding.title}")`);
    return anchored && { ...finding, ...anchored, id: `finding-${index + 1}`, decision: "keep" as const };
  });
  if (problems.length > 0) throw new ReviewProblems(problems);

  return {
    repository: root,
    base: request.base,
    baseCommit,
    headCommit,
    pullRequest,
    verdict: request.verdict,
    summary: request.summary,
    flow: flow.filter((step) => step !== null),
    findings: findings.filter((finding) => finding !== null),
    answers: [],
    files: hideUnreadableDiffs(parseGitDiff(diff)),
    posting: false,
    pendingReviewUrl: null,
  };
}

/** One at a time, so the agent gets its problems in the order of its request. */
export async function mapInOrder<T, R>(items: T[], map: (item: T, index: number) => Promise<R>) {
  const results: R[] = [];
  for (const [index, item] of items.entries()) results.push(await map(item, index));
  return results;
}

function parsePullRequestOrProblem(url: string, problems: string[]) {
  try {
    return parsePullRequestUrl(url);
  } catch (error) {
    problems.push(`pullRequest: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
