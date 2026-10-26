import { copyFileSync, existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ReviewFile, Tour, TourChanges } from "../../shared/review.ts";
import { IDENTITY, WITHOUT_SAFECRLF } from "../git-identity.ts";
import { hideUnreadableDiffs, parseGitDiff } from "./diff.ts";
import { AnchorReader, diskLines, git, gitOrProblem, linesAt, mapInOrder, pathInside, ReviewProblems, type LineSource } from "./snapshot.ts";

export interface TourRequest {
  title: string;
  folder: string;
  since?: string;
  summary: string;
  flow: { title: string; at: string; say: string }[];
}

const TOUR_NOT_SHOWN = "The tour was not shown. Fix these and call tour again";

export const TOURS_KEPT = 100;
const TOUR_REFS = "refs/mirador/tours/";
const TOUR_SNAPSHOT_MESSAGE = "mirador: the files a tour was made from";
/** Named by when it was taken, so the names sort oldest first. */
const tourRefOf = (commit: string, takenAt: number) => `${TOUR_REFS}${String(takenAt).padStart(16, "0")}-${commit}`;

function folderOrProblem(folder: string, problems: string[]) {
  if (!isAbsolute(folder) || !existsSync(folder) || !statSync(folder).isDirectory()) {
    problems.push(`folder: ${folder} is not an absolute path of a folder.`);
    return null;
  }
  return realpathSync(folder);
}

/**
 * The folder's files as they are now, untracked ones included, as a git tree of the whole checkout, and a commit of it
 * for a ref to keep. The user's index, branches and HEAD stay as they were.
 */
async function workingTree(folder: string) {
  const scratch = mkdtempSync(join(tmpdir(), "mirador-tour-"));
  const index = join(scratch, "index");
  try {
    const usersIndex = (await git(folder, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim();
    if (existsSync(usersIndex)) copyFileSync(usersIndex, index);
    await git(folder, [...WITHOUT_SAFECRLF, "add", "--all", "--", "."], { GIT_INDEX_FILE: index });
    const tree = (await git(folder, ["write-tree"], { GIT_INDEX_FILE: index })).trim();
    const commit = (await git(folder, [...IDENTITY, "commit-tree", tree, "-m", TOUR_SNAPSHOT_MESSAGE])).trim();
    return { tree, commit };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * A ref of its own under refs/mirador/tours/ keeps git's gc from taking a shown tour's files, as Undo's snapshots do;
 * only the newest `keep` stay. A tour sent back for its anchors gets none, so it takes no place among them.
 */
async function keepSnapshot(folder: string, commit: string, keep: number) {
  await git(folder, ["update-ref", tourRefOf(commit, Date.now()), commit]);
  await dropSnapshotsPast(folder, keep).catch(() => undefined);
}

/** Left to the next tour when git cannot drop one now, for example while another git process holds packed-refs.lock. */
async function dropSnapshotsPast(folder: string, keep: number) {
  const refs = await git(folder, ["for-each-ref", "--sort=-refname", "--format=%(refname)", TOUR_REFS]);
  for (const dropped of refs.split("\n").filter(Boolean).slice(keep)) await git(folder, ["update-ref", "-d", dropped]);
}

function fixGitOrLeaveSince(problem: string, gitMessage: string) {
  return `${problem}: ${gitMessage.trim().replace(/\.$/, "")}. Fix what git reports, or leave since out to show the tour without what changed.`;
}

async function changesSince(folder: string, since: string, problems: string[]): Promise<{ changes: TourChanges; files: ReviewFile[]; snapshotCommit: string } | null> {
  const notInGit = () => `since: ${folder} is not inside a git checkout, so the tour cannot show what changed; leave since out.`;
  const prefix = await gitOrProblem(folder, ["rev-parse", "--show-prefix"], problems, notInGit);
  if (prefix === null) return null;
  const sinceCommit = (await gitOrProblem(folder, ["rev-parse", "--verify", `${since}^{commit}`], problems, () => `since: ${since} is not a commit in ${folder}.`))?.trim();
  if (!sinceCommit) return null;
  const current = await workingTree(folder).catch((error: unknown) => {
    problems.push(fixGitOrLeaveSince(`since: Mirador could not read the files in ${folder} as they are now to compare with ${since}`, error instanceof Error ? error.message : String(error)));
    return null;
  });
  if (!current) return null;
  const snapshot = (await gitOrProblem(folder, ["rev-parse", `${current.tree}:${prefix.trim()}`], problems, () => `since: git ignores everything in ${folder}, so the tour cannot show what changed; leave since out.`))?.trim();
  if (!snapshot) return null;
  const diff = await gitOrProblem(folder, ["diff", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", "--find-renames", "-U3", "--relative", sinceCommit, current.tree], problems, (error) => fixGitOrLeaveSince(`since: Mirador could not compare ${since} with the files in ${folder}`, error));
  if (diff === null) return null;
  return { changes: { since, sinceCommit, snapshot }, files: hideUnreadableDiffs(parseGitDiff(diff)), snapshotCommit: current.commit };
}

/**
 * Lines of the snapshot the changes were taken from, so the marks land on the right lines; files git ignores come from
 * disk. git reads a `../` path from the working directory, not from the snapshot, so paths are kept inside the folder first.
 */
const snapshotThenDisk = (folder: string, snapshot: string): LineSource => ({
  lines: async (path) => {
    const inside = pathInside(folder, path);
    if (!inside) return null;
    return (await linesAt(folder, snapshot, inside).catch(() => null)) ?? diskLines(folder).lines(inside);
  },
  where: `in ${folder}`,
});

/** The tour as the user will read it: each step's code as it was when published, and with `since`, what changed since then. */
export async function snapshotTour(request: TourRequest, keep = TOURS_KEPT): Promise<Tour> {
  const problems: string[] = [];
  const folder = folderOrProblem(request.folder, problems);
  if (!folder) throw new ReviewProblems(problems, TOUR_NOT_SHOWN);
  const changed = request.since === undefined ? null : await changesSince(folder, request.since, problems);
  const anchors = new AnchorReader(folder, changed ? snapshotThenDisk(folder, changed.changes.snapshot) : diskLines(folder), problems);
  const flow = await mapInOrder(request.flow, async (step, index) => {
    const anchored = await anchors.read(step.at, `flow step ${index + 1} ("${step.title}")`);
    return anchored && { title: step.title, say: step.say, ...anchored };
  });
  if (problems.length > 0) throw new ReviewProblems(problems, TOUR_NOT_SHOWN);
  if (changed) {
    try {
      await keepSnapshot(folder, changed.snapshotCommit, keep);
    } catch (error) {
      throw new ReviewProblems([fixGitOrLeaveSince("snapshot: Mirador could not keep the files the tour was made from in git", error instanceof Error ? error.message : String(error))], TOUR_NOT_SHOWN);
    }
  }
  return {
    folder,
    changes: changed?.changes ?? null,
    summary: request.summary,
    flow: flow.filter((step) => step !== null),
    files: changed?.files ?? [],
  };
}

/** A changed file of the tour as it was published, so the page can show more of it than the diff does. */
export async function touredFileLines(tour: Tour, path: string) {
  const file = tour.files.find((candidate) => candidate.path === path);
  if (!file || file.change === "deleted" || !tour.changes) throw new Error(`${path} is not a file this tour shows changes of.`);
  return linesAt(tour.folder, tour.changes.snapshot, path).catch(() => {
    throw new Error(`Git no longer has ${path} as it was when the tour was published: Mirador keeps the files of a repository's newest ${TOURS_KEPT} tours. The steps still show their lines.`);
  });
}
