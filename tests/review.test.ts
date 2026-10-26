import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareUrl, excerptRows, findingNumber, isCommentable, parseAnchor, type Review, type ReviewFile } from "../shared/review.ts";
import { hideUnreadableDiffs, parseGitDiff } from "../host/review/diff.ts";
import { parsePullRequestUrl, PendingReviewOfOtherCommit, postPendingReview, PullRequestMovedOn, type GitHubCli } from "../host/review/github.ts";
import { AnchorReader, git, ReviewProblems, snapshotReview } from "../host/review/snapshot.ts";
import { gitRepository, reviewRequest as request } from "./review-repository.ts";

const diff = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,5 +1,5 @@ export function start() {
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
--- not a header, a removed line
 const e = 6;
diff --git a/README.md b/docs/README.md
similarity index 90%
rename from README.md
rename to docs/README.md
diff --git a/new file.txt b/new file.txt
new file mode 100644
--- /dev/null
+++ b/new file.txt
@@ -0,0 +1 @@
+hello
\\ No newline at end of file
diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
`;

const isolatedFromUserGitConfig = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** A fresh repo holding just the named file, committed, then given the change and committed again; the diff between the two commits, read the way Mirador reads it. */
async function diffOf(file: string, change: "deleted" | "mode" | "modified" | { renamedTo: string }) {
  const directory = mkdtempSync(join(tmpdir(), "mirador-quoted-paths-"));
  try {
    const run = (...args: string[]) => git(directory, args, isolatedFromUserGitConfig);
    await run("init", "-q", "-b", "main");
    writeFileSync(join(directory, file), "x\n");
    await run("add", ".");
    await run("commit", "-q", "-m", "base", "--no-gpg-sign");
    if (change === "deleted") await run("rm", "-q", "--", file);
    else if (change === "mode") chmodSync(join(directory, file), 0o755);
    else if (change === "modified") writeFileSync(join(directory, file), "y\n");
    else await run("mv", "--", file, change.renamedTo);
    await run("add", "-A");
    await run("commit", "-q", "-m", "change", "--no-gpg-sign");
    return await run("diff", "--no-color", "--no-ext-diff", "--find-renames", "-U3", "HEAD~1", "HEAD");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const pathsOf = async (file: string, change: "deleted" | "mode" | "modified") =>
  parseGitDiff(await diffOf(file, change)).map(({ path, change }) => [path, change]);

/** Windows does not allow ", \ or control characters in a file name, so git there makes no diff of such a file to read. */
const testWithNamesWindowsForbids = test.skipIf(process.platform === "win32");

describe("parseGitDiff", () => {
  testWithNamesWindowsForbids("keeps C-quoted paths whole when only the diff header carries them, deleted or mode-only", async () => {
    expect(await pathsOf('we"ird\\name.txt', "deleted")).toEqual([['we"ird\\name.txt', "deleted"]]);
    expect(parseGitDiff(await diffOf('we"ird\\name.txt', "mode")).map(({ path, hunks }) => [path, hunks.length])).toEqual([['we"ird\\name.txt', 0]]);
  });

  testWithNamesWindowsForbids("turns git's octal escapes for control characters back into the characters they spell", async () => {
    const name = "ctl\u0001.txt";
    expect(await diffOf(name, "deleted")).toContain('"a/ctl\\001.txt"');
    expect(await pathsOf(name, "deleted")).toEqual([[name, "deleted"]]);
  });

  testWithNamesWindowsForbids("decodes the non-ASCII characters git keeps raw inside a quoted name", async () => {
    expect(await pathsOf('café"q.txt', "modified")).toEqual([['café"q.txt', "modified"]]);
    expect(await pathsOf('café"q-del.txt', "deleted")).toEqual([['café"q-del.txt', "deleted"]]);
    expect(await pathsOf('中"文.txt', "deleted")).toEqual([['中"文.txt', "deleted"]]);
    expect(await pathsOf('😀"x.txt', "deleted")).toEqual([['😀"x.txt', "deleted"]]);
  });

  test("leaves out the tab git ends the new side's line with when the name has a space", async () => {
    expect(await pathsOf("space mod.txt", "modified")).toEqual([["space mod.txt", "modified"]]);
  });

  testWithNamesWindowsForbids("leaves out that tab from a quoted name with a space too", async () => {
    expect(await pathsOf('dq"space mod.txt', "modified")).toEqual([['dq"space mod.txt', "modified"]]);
  });

  testWithNamesWindowsForbids("reads both names of a rename between quoted names", async () => {
    const files = parseGitDiff(await diffOf('ren"src.txt', { renamedTo: 'ren é"b.txt' }));
    expect(files.map(({ path, oldPath, change }) => [path, oldPath, change])).toEqual([['ren é"b.txt', 'ren"src.txt', "renamed"]]);
  });

  test("reads files, their kind of change, and hunks with both sides' line numbers", () => {
    const files = parseGitDiff(diff);
    expect(files.map(({ path, change, added, removed }) => [path, change, added, removed])).toEqual([
      ["src/app.ts", "modified", 2, 2],
      ["docs/README.md", "renamed", 0, 0],
      ["new file.txt", "added", 1, 0],
      ["logo.png", "modified", 0, 0],
      ["gone.ts", "deleted", 0, 2],
    ]);
    const [app] = files;
    expect(app!.hunks[0]!.header).toBe("export function start() {");
    expect(app!.hunks[0]!.rows).toEqual([
      { kind: "context", oldLine: 1, newLine: 1, text: "const a = 1;" },
      { kind: "removed", oldLine: 2, newLine: null, text: "const b = 2;" },
      { kind: "added", oldLine: null, newLine: 2, text: "const b = 3;" },
      { kind: "added", oldLine: null, newLine: 3, text: "const c = 4;" },
      { kind: "context", oldLine: 3, newLine: 4, text: "const d = 5;" },
      { kind: "removed", oldLine: 4, newLine: null, text: "-- not a header, a removed line" },
      { kind: "context", oldLine: 5, newLine: 5, text: "const e = 6;" },
    ]);
    expect(files[1]!.oldPath).toBe("README.md");
    expect(files[3]!.hiddenBecause).toBe("binary file");
  });

  test("leaves out lock files and diffs too long to read, keeping their counts", () => {
    const lockFile: ReviewFile = { ...parseGitDiff(diff)[0]!, path: "web/bun.lock" };
    const [hidden] = hideUnreadableDiffs([lockFile]);
    expect(hidden).toMatchObject({ hiddenBecause: "generated file", hunks: [], added: 2, removed: 2 });
  });
});

describe("anchors and excerpts", () => {
  const [app] = parseGitDiff(diff);

  test("an anchor is a path and a line or a range", () => {
    expect(parseAnchor("src/a:b.ts:12")).toEqual({ path: "src/a:b.ts", line: 12, endLine: 12 });
    expect(parseAnchor(" src/app.ts:3-9 ")).toEqual({ path: "src/app.ts", line: 3, endLine: 9 });
    expect(parseAnchor("src/app.ts")).toBeNull();
  });

  test("an excerpt of the new version shows added lines, and removed lines where they were", () => {
    const rows = excerptRows(app, { startLine: 1, lines: ["const a = 1;", "const b = 3;", "const c = 4;", "const d = 5;", "const e = 6;"] });
    expect(rows.map(({ kind, text }) => `${kind[0]} ${text}`)).toEqual([
      "c const a = 1;",
      "r const b = 2;",
      "a const b = 3;",
      "a const c = 4;",
      "c const d = 5;",
      "r -- not a header, a removed line",
      "c const e = 6;",
    ]);
  });

  test("a trailing deletion in a hunk with no new-side rows sits after the line git counted from", () => {
    const deletionOnly: ReviewFile = {
      path: "tail.ts",
      oldPath: null,
      change: "modified",
      added: 0,
      removed: 1,
      hunks: [{ header: "@@ -5 +4,0 @@", newStart: 4, rows: [{ kind: "removed", oldLine: 5, newLine: null, text: "gone" }] }],
      hiddenBecause: null,
    };
    const rows = excerptRows(deletionOnly, { startLine: 3, lines: ["three", "four", "five"] });
    expect(rows.map(({ kind, text }) => `${kind} ${text}`)).toEqual(["context three", "context four", "removed gone", "context five"]);
  });

  test("GitHub takes comments on lines in its diff's hunks, and a range only within one hunk", () => {
    expect(isCommentable(app, { path: "src/app.ts", line: 2, endLine: 3 })).toBe(true);
    expect(isCommentable(app, { path: "src/app.ts", line: 5, endLine: 6 })).toBe(false);
    expect(isCommentable(undefined, { path: "elsewhere.ts", line: 1, endLine: 1 })).toBe(false);
  });
});

describe("excerpt budget", () => {
  const fileLines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`);
  const excerptOf = async (lines: string[], range: string) => {
    const reader = new AnchorReader("/repo", { lines: async () => lines, where: "in the test file" }, []);
    return (await reader.read(`big.ts:${range}`, "finding 1"))!.excerpt;
  };

  test("a short anchor keeps six lines of context on each side", async () => {
    expect(await excerptOf(fileLines(40), "10-12")).toEqual({ startLine: 4, lines: fileLines(40).slice(3, 18) });
  });

  test("an anchor that fits only when the context is dropped keeps every anchored line", async () => {
    expect(await excerptOf(fileLines(200), "1-160")).toEqual({ startLine: 1, lines: fileLines(160) });
  });

  test.each([
    ["100-248", 94, 253],
    ["100-253", 94, 253],
    ["1-150", 1, 156],
    ["151-300", 145, 300],
  ])("an anchor of %s that nearly fills the cap keeps the context that fits", async (range, from, to) => {
    const excerpt = await excerptOf(fileLines(300), range);
    expect(excerpt.startLine).toBe(from);
    expect(excerpt.lines).toEqual(fileLines(300).slice(from - 1, to));
    expect(excerpt.lines.length).toBeLessThanOrEqual(160);
  });

  test("context stops at the edges of the file", async () => {
    expect(await excerptOf(fileLines(20), "1-20")).toEqual({ startLine: 1, lines: fileLines(20) });
    expect(await excerptOf(fileLines(20), "19-20")).toEqual({ startLine: 13, lines: fileLines(20).slice(12) });
  });

  test("an anchor longer than the cap keeps its first and its last line", async () => {
    const excerpt = await excerptOf(fileLines(300), "1-300");
    expect(excerpt.lines[0]).toBe("line 1");
    expect(excerpt.lines.at(-1)).toBe("line 300");
  });

  test("an anchor longer than the cap says how many of its lines are left out", async () => {
    const excerpt = await excerptOf(fileLines(300), "1-300");
    expect(excerpt.elision).toEqual({ after: 78, lineCount: 141 });
    expect(excerpt.lines.length).toBe(159);
    expect(excerpt.lines[79]).toBe("line 221");
  });

  test("the excerpt's line numbers jump over the elision", () => {
    const rows = excerptRows(undefined, { startLine: 500, lines: ["a", "b", "c", "d"], elision: { after: 1, lineCount: 40 } });
    expect(rows.map(({ kind, newLine }) => (kind === "elided" ? "elided" : newLine))).toEqual([500, 501, "elided", 542, 543]);
    expect(rows[2]!.text).toBe("… 40 lines not shown …");
  });

  test("a gap of one line says so in the singular", () => {
    const rows = excerptRows(undefined, { startLine: 10, lines: ["a", "b"], elision: { after: 0, lineCount: 1 } });
    expect(rows[1]!.text).toBe("… 1 line not shown …");
  });
});

describe("snapshotReview", () => {
  test("takes the diff from git and anchors the tour and findings in the reviewed version", async () => {
    const { directory, head } = gitRepository();
    const review = await snapshotReview(request(join(directory, "."), { pullRequest: "https://github.example.com/acme/shop/pull/7/files" }));
    expect(review).toMatchObject({ headCommit: head, base: "main", pullRequest: { host: "github.example.com", owner: "acme", repo: "shop", number: 7 } });
    expect(review.files.map(({ path, added, removed }) => [path, added, removed])).toEqual([["service.ts", 1, 1]]);
    expect(review.flow[0]!.excerpt).toEqual({ startLine: 1, lines: ["export function serve() {", "  return load() + 1;", "}", "", "function load() {", "  return 1;", "}"] });
    expect(review.findings[0]).toMatchObject({ id: "finding-1", decision: "keep", at: { path: "service.ts", line: 2, endLine: 2 } });
  });

  test("reads the paths of added files whose names have spaces, even when the checkout's config sets diff.noprefix", async () => {
    const { directory } = gitRepository();
    await git(directory, ["config", "diff.noprefix", "true"]);
    writeFileSync(join(directory, "added space.txt"), "");
    mkdirSync(join(directory, "docs folder"));
    writeFileSync(join(directory, "docs folder", "notes file.md"), "");
    await git(directory, ["add", "."]);
    await git(directory, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "add files"]);

    const review = await snapshotReview(request(directory));

    expect(review.files.map(({ path, change }) => [path, change])).toEqual([
      ["added space.txt", "added"],
      ["docs folder/notes file.md", "added"],
      ["service.ts", "modified"],
    ]);
  });

  test.if(process.platform === "win32")("accepts an absolute path through the checkout's short 8.3 name, as a Windows account with a long name has in its TEMP", async () => {
    const { directory } = gitRepository();
    mkdirSync(join(directory, "docs"));
    writeFileSync(join(directory, "docs", "notes.md"), "# Notes\n");
    await git(directory, ["add", "."]);
    await git(directory, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "add notes"]);
    const shortName = execFileSync("powershell.exe", ["-NoProfile", "-Command", `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${directory}').ShortPath`], { encoding: "utf8" }).trim();
    expect(shortName).not.toBe(directory);

    const flow = [
      { title: "Entry", at: join(shortName, "service.ts:5"), say: "load" },
      { title: "Notes", at: join(shortName, "docs", "notes.md:1"), say: "read" },
    ];
    const review = await snapshotReview(request(directory, { flow }));
    expect(review.flow.map(({ at }) => at.path)).toEqual(["service.ts", "docs/notes.md"]);
  });

  test("accepts absolute paths inside the checkout, and lists every wrong anchor at once", async () => {
    const { directory } = gitRepository();
    const absolute = await snapshotReview(request(directory, { flow: [{ title: "Entry", at: join(directory, "service.ts:5"), say: "load" }] }));
    expect(absolute.flow[0]!.at.path).toBe("service.ts");

    const wrong = request(directory, {
      flow: [{ title: "Gone", at: "missing.ts:1", say: "?" }],
      findings: [
        { severity: "issue", checked: "plausible", at: "service.ts:99", title: "Past the end", body: "?" },
        { severity: "issue", checked: "plausible", at: "service.ts", title: "No line", body: "?" },
      ],
    });
    const problems = await snapshotReview(wrong).catch((error: ReviewProblems) => error.problems);
    expect(problems).toEqual([
      expect.stringContaining('flow step 1 ("Gone"): missing.ts is not a file in the reviewed version'),
      'finding 1 ("Past the end"): service.ts:99 is outside the file, which has 7 lines.',
      'finding 2 ("No line"): "service.ts" is not "path:line" or "path:start-end".',
    ]);
  });

  test("names a base or repository that git does not know", async () => {
    const { directory } = gitRepository();
    expect(await snapshotReview(request(directory, { base: "nope" })).catch((error: ReviewProblems) => error.problems)).toEqual([
      expect.stringContaining("base: nope has no common history"),
    ]);
    expect(await snapshotReview(request(tmpdir())).catch((error: ReviewProblems) => error.problems)).toEqual([expect.stringContaining("is not inside a git checkout")]);
  });

  test("tells the agent when git cannot read the diff", async () => {
    const { directory } = gitRepository();
    const blob = (await git(directory, ["rev-parse", "HEAD:service.ts"])).trim();
    rmSync(join(directory, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    const error = await snapshotReview(request(directory, { base: "HEAD~1" })).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ReviewProblems);
    expect((error as ReviewProblems).problems).toEqual([expect.stringContaining("diff: git could not compare")]);
  });
});

describe("posting to the pull request", () => {
  test("reads pull request URLs, also of GitHub Enterprise and with a tab after the number", () => {
    expect(parsePullRequestUrl("https://github.infra.example.com/team/repo/pull/123/files")).toEqual({
      url: "https://github.infra.example.com/team/repo/pull/123",
      host: "github.infra.example.com",
      owner: "team",
      repo: "repo",
      number: 123,
    });
    expect(() => parsePullRequestUrl("https://github.com/team/repo/issues/1")).toThrow("is not a pull request URL");
  });

  const reviewOf = (headCommit: string): Review => {
    const [app] = parseGitDiff(diff);
    const finding = (id: string, line: number, endLine = line) => ({
      id,
      severity: "issue" as const,
      checked: "confirmed" as const,
      at: { path: "src/app.ts", line, endLine },
      title: id,
      body: `About ${id}`,
      excerpt: { startLine: 1, lines: [] },
      decision: "keep" as const,
    });
    return {
      repository: "/repo",
      base: "main",
      baseCommit: "base",
      headCommit,
      pullRequest: parsePullRequestUrl("https://ghe.example.com/team/repo/pull/5"),
      verdict: "",
      summary: "",
      flow: [],
      findings: [finding("finding-1", 2, 3), { ...finding("finding-2", 4), decision: "drop" }, finding("finding-3", 5), finding("finding-4", 40)],
      files: [app!],
      posting: false,
      pendingReviewUrl: null,
    };
  };

  /** Only the user's own pending review is ever pending for them. */
  function fakeGitHub(responses: { head: string; reviews: object[]; refuse?: string }) {
    const calls: { args: string[]; body?: any }[] = [];
    const gh: GitHubCli = async (args, body: any) => {
      calls.push({ args, body });
      const endpoint = args[3]!;
      if (endpoint === "repos/team/repo/pulls/5") return { node_id: "PR_node", head: { sha: responses.head } };
      if (body.query.includes("states: PENDING")) {
        expect(body.variables).toEqual({ owner: "team", repo: "repo", number: 5 });
        const pending = responses.reviews.filter((review: any) => review.state === "PENDING");
        return { data: { repository: { pullRequest: { reviews: { nodes: pending.map((review: any) => ({ id: review.node_id, url: review.html_url, commit: { oid: review.commit_id } })) } } } } };
      }
      if (body.query.includes("addPullRequestReview(")) return { data: { addPullRequestReview: { pullRequestReview: { id: "PRR_new", url: "https://ghe.example.com/review/new" } } } };
      if (body.variables.input.path === responses.refuse) return { errors: [{ message: "Line could not be resolved" }] };
      return { data: { addPullRequestReviewThread: { thread: { id: `thread-${body.variables.input.line}` } } } };
    };
    return { gh, calls };
  }

  test("starts a pending review and adds each kept finding on the diff as a comment on it", async () => {
    const { gh, calls } = fakeGitHub({ head: "abc", reviews: [{ state: "COMMENTED", node_id: "old", html_url: "x" }], refuse: "nothing" });
    const outcome = await postPendingReview(reviewOf("abc"), gh);
    expect(calls.every(({ args }) => args.slice(0, 3).join(" ") === "api --hostname ghe.example.com")).toBe(true);
    expect(calls[2]!.body.variables.input).toEqual({ pullRequestId: "PR_node", commitOID: "abc" });
    expect(calls.slice(3).map(({ body }) => body.variables.input)).toEqual([
      { pullRequestReviewId: "PRR_new", path: "src/app.ts", line: 3, side: "RIGHT", startLine: 2, startSide: "RIGHT", body: "About finding-1" },
      { pullRequestReviewId: "PRR_new", path: "src/app.ts", line: 5, side: "RIGHT", body: "About finding-3" },
    ]);
    expect(outcome.pendingReviewUrl).toBe("https://ghe.example.com/review/new");
    expect([...outcome.threadIds]).toEqual([
      ["finding-1", "thread-3"],
      ["finding-3", "thread-5"],
    ]);
  });

  test("adds to the pending review the user already has, and reports the comments GitHub refused", async () => {
    const { gh, calls } = fakeGitHub({ head: "abc", reviews: [{ state: "PENDING", node_id: "PRR_mine", html_url: "https://ghe.example.com/review/mine", commit_id: "abc" }], refuse: "src/app.ts" });
    const outcome = await postPendingReview(reviewOf("abc"), gh);
    expect(calls.some(({ body }) => body?.query.includes("addPullRequestReview("))).toBe(false);
    expect(outcome.pendingReviewUrl).toBe("https://ghe.example.com/review/mine");
    expect([...outcome.errors.keys()]).toEqual(["finding-1", "finding-3"]);
    expect(outcome.errors.get("finding-1")).toBe("Line could not be resolved");
  });

  test("finds the user's pending review on a pull request with more than a hundred reviews", async () => {
    const older = Array.from({ length: 120 }, (_, index) => ({ state: "COMMENTED", node_id: `old-${index}`, html_url: "x" }));
    const { gh, calls } = fakeGitHub({ head: "abc", reviews: [...older, { state: "PENDING", node_id: "PRR_mine", html_url: "https://ghe.example.com/review/mine", commit_id: "abc" }] });
    const outcome = await postPendingReview(reviewOf("abc"), gh);
    expect(calls.some(({ body }) => body?.query.includes("addPullRequestReview("))).toBe(false);
    expect(outcome.pendingReviewUrl).toBe("https://ghe.example.com/review/mine");
  });

  test("refuses when the pull request moved on since the review, naming the head it moved on to", async () => {
    const { gh } = fakeGitHub({ head: "0123456789abcdef", reviews: [] });
    const refusal = await postPendingReview(reviewOf("fedcba9876543210"), gh).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PullRequestMovedOn);
    expect((refusal as PullRequestMovedOn).headCommit).toBe("0123456789abcdef");
    expect((refusal as PullRequestMovedOn).message).toBe("The pull request has changed since the review: its head is 0123456789, the review is of fedcba9876.");
  });

  test("refuses to add to the user's pending review when it was started on another commit, naming it, and posts nothing", async () => {
    const pendingReview = { state: "PENDING", node_id: "PRR_mine", html_url: "https://ghe.example.com/review/mine", commit_id: "0123456789abcdef" };
    const { gh, calls } = fakeGitHub({ head: "fedcba9876543210", reviews: [pendingReview] });
    const refusal = await postPendingReview(reviewOf("fedcba9876543210"), gh).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PendingReviewOfOtherCommit);
    expect((refusal as PendingReviewOfOtherCommit).pendingReview).toEqual({ url: "https://ghe.example.com/review/mine", commit: "0123456789abcdef" });
    expect((refusal as PendingReviewOfOtherCommit).message).toBe(
      "Your pending review on the pull request was started on 0123456789, not on fedcba9876, the commit this review is of. Submit or discard it on GitHub, then post again.",
    );
    expect(calls.map(({ body }) => body?.query.match(/(addPullRequestReview\w*)\(/)?.[1]).filter(Boolean)).toEqual([]);
  });
});

describe("compareUrl", () => {
  test("is GitHub's compare page on the pull request's own host, from the reviewed commit to the new head", () => {
    expect(compareUrl({ url: "https://ghe.example.com/team/repo/pull/5", host: "ghe.example.com", owner: "team", repo: "repo", number: 5 }, "abc", "def")).toBe(
      "https://ghe.example.com/team/repo/compare/abc...def",
    );
  });
});

describe("finding numbers", () => {
  test("a finding's number is the N of its id finding-N, and 0 for an id of another shape", () => {
    expect([findingNumber("finding-1"), findingNumber("finding-12"), findingNumber("finding 3"), findingNumber("note-2")]).toEqual([1, 12, 0, 0]);
  });
});
