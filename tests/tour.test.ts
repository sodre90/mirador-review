import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { excerptRows } from "../shared/review.ts";
import { ReviewProblems } from "../host/review/snapshot.ts";
import { snapshotTour, touredFileLines, type TourRequest } from "../host/review/tour.ts";

const made: string[] = [];
afterAll(() => made.forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function folderWith(files: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "mirador-tour-"));
  made.push(directory);
  Object.entries(files).forEach(([path, text]) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), text);
  });
  return directory;
}

const lines = (...each: string[]) => each.join("\n") + "\n";

/**
 * git still reads this repo but cannot add an object to it, as with a read-only .git: once its objects are packed, a file
 * stands where each folder of loose objects would go. Call the result to let it write again.
 */
function withoutNewObjects(git: (...args: string[]) => string, directory: string) {
  git("repack", "-adq");
  git("prune-packed");
  const objectFolders = Array.from({ length: 256 }, (_, index) => join(directory, ".git", "objects", index.toString(16).padStart(2, "0")));
  objectFolders.forEach((folder) => writeFileSync(folder, ""));
  return () => objectFolders.forEach((folder) => rmSync(folder));
}

/** git cannot make a ref under refs/mirador/: a file stands where that folder would go. Call the result to let it again. */
function withoutMiradorRefs(directory: string) {
  const inTheWay = join(directory, ".git", "refs", "mirador");
  writeFileSync(inTheWay, "");
  return () => rmSync(inTheWay);
}

/** A checkout with an app/ folder, where the task changed a line of service.ts and wrote new.ts and a gitignored file, none of it committed. */
function checkoutWithUncommittedWork() {
  const directory = folderWith({
    ".gitignore": "generated/\n",
    "readme.md": "# Top\n",
    "app/service.ts": lines("export function serve() {", "  return load();", "}", "", "function load() {", "  return 1;", "}"),
  });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", directory, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  writeFileSync(join(directory, "app/service.ts"), lines("export function serve() {", "  return load() + 1;", "}", "", "function load() {", "  return 1;", "}"));
  writeFileSync(join(directory, "app/new.ts"), lines("export const added = true;"));
  mkdirSync(join(directory, "app/generated"));
  writeFileSync(join(directory, "app/generated/out.ts"), lines("// generated", "export const out = 1;"));
  return { directory, git, head: git("rev-parse", "HEAD").trim() };
}

const request = (folder: string, change: Partial<TourRequest> = {}): TourRequest => ({
  title: "How serve works",
  folder,
  summary: "serve() adds one to load().",
  flow: [{ title: "Entry", at: "service.ts:1-3", say: "serve() calls load()." }],
  ...change,
});

async function problemsOf(tour: Promise<unknown>) {
  const error = await tour.then(
    () => null,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(ReviewProblems);
  return (error as ReviewProblems).problems;
}

describe("snapshotTour", () => {
  test("without since, each step shows its code as it is on disk, also in a folder outside git, and no changes", async () => {
    const folder = folderWith({ "notes/plan.ts": lines("const a = 1;", "const b = 2;", "const c = a + b;") });

    const tour = await snapshotTour(request(folder, { flow: [{ title: "Sum", at: "notes/plan.ts:3", say: "Adds them." }] }));

    expect(tour.changes).toBeNull();
    expect(tour.files).toEqual([]);
    expect(tour.flow[0]).toMatchObject({ title: "Sum", at: { path: "notes/plan.ts", line: 3, endLine: 3 }, excerpt: { startLine: 1, lines: ["const a = 1;", "const b = 2;", "const c = a + b;"] } });
  });

  test("with since HEAD, a tour of a subfolder shows the uncommitted changes and new files relative to it, marks them in its steps, and leaves the user's index alone", async () => {
    const { directory, git, head } = checkoutWithUncommittedWork();
    const folder = join(directory, "app");

    const tour = await snapshotTour(request(folder, { since: "HEAD" }));

    expect(tour.changes).toMatchObject({ since: "HEAD", sinceCommit: head });
    expect(tour.files.map(({ path, change }) => [path, change])).toEqual([
      ["new.ts", "added"],
      ["service.ts", "modified"],
    ]);
    const service = tour.files.find(({ path }) => path === "service.ts");
    expect(excerptRows(service, tour.flow[0]!.excerpt).map(({ kind, text }) => `${kind} ${text}`)).toContain("added   return load() + 1;");
    expect(excerptRows(service, tour.flow[0]!.excerpt).map(({ kind, text }) => `${kind} ${text}`)).toContain("removed   return load();");
    expect(await touredFileLines(tour, "service.ts")).toHaveLength(7);
    expect(git("status", "--porcelain").split("\n").filter(Boolean).sort()).toEqual([" M app/service.ts", "?? app/new.ts"]);
  });

  test("with since, git gc keeps the files the tour was made from, under a ref of Mirador's own, and the user's branches stay as they were", async () => {
    const { directory, git, head } = checkoutWithUncommittedWork();
    const tour = await snapshotTour(request(join(directory, "app"), { since: "HEAD" }));

    git("gc", "--quiet", "--prune=now");

    expect(await touredFileLines(tour, "service.ts")).toContain("  return load() + 1;");
    expect(git("for-each-ref", "--format=%(refname)").split("\n").filter(Boolean)).toEqual(["refs/heads/main", expect.stringMatching(/^refs\/mirador\/tours\/\d{16}-[0-9a-f]{40}$/)]);
    expect(git("rev-parse", "HEAD").trim()).toBe(head);
  });

  test("only the newest tours keep their files; an older one's changed file says so rather than failing with git's message", async () => {
    const { directory, git } = checkoutWithUncommittedWork();
    const older = await snapshotTour(request(join(directory, "app"), { since: "HEAD" }), 1);
    writeFileSync(join(directory, "app/service.ts"), lines("export function serve() {", "  return load() + 2;", "}", "", "function load() {", "  return 1;", "}"));
    const newer = await snapshotTour(request(join(directory, "app"), { since: "HEAD" }), 1);

    git("gc", "--quiet", "--prune=now");

    expect(git("for-each-ref", "--format=%(refname)", "refs/mirador/tours/").split("\n").filter(Boolean)).toHaveLength(1);
    expect(await touredFileLines(newer, "service.ts")).toContain("  return load() + 2;");
    await expect(touredFileLines(older, "service.ts")).rejects.toThrow("Git no longer has service.ts as it was when the tour was published: Mirador keeps the files of a repository's newest 100 tours.");
  });

  test("with since, the paths of new files with spaces in their names are right even when the checkout's config sets diff.noprefix", async () => {
    const { directory, git } = checkoutWithUncommittedWork();
    git("config", "diff.noprefix", "true");
    writeFileSync(join(directory, "app/added space.txt"), "");
    mkdirSync(join(directory, "app/nested dir"));
    writeFileSync(join(directory, "app/nested dir/new file.ts"), "");

    const tour = await snapshotTour(request(join(directory, "app"), { since: "HEAD" }));

    expect(tour.files.map(({ path, change }) => [path, change])).toEqual([
      ["added space.txt", "added"],
      ["nested dir/new file.ts", "added"],
      ["new.ts", "added"],
      ["service.ts", "modified"],
    ]);
  });

  test("with since, a step in a file git ignores still shows its code, read from disk", async () => {
    const { directory } = checkoutWithUncommittedWork();

    const tour = await snapshotTour(request(join(directory, "app"), { since: "HEAD", flow: [{ title: "Output", at: "generated/out.ts:2", say: "Built." }] }));

    expect(tour.flow[0]!.excerpt.lines).toEqual(["// generated", "export const out = 1;"]);
    expect(tour.files.map(({ path }) => path)).not.toContain("generated/out.ts");
  });

  test("every wrong anchor is reported in one go, a path outside the folder among them", async () => {
    const { directory } = checkoutWithUncommittedWork();

    const problems = await problemsOf(
      snapshotTour(
        request(join(directory, "app"), {
          flow: [
            { title: "Missing", at: "nowhere.ts:1", say: "?" },
            { title: "Past the end", at: "service.ts:99", say: "?" },
            { title: "No line", at: "service.ts", say: "?" },
            { title: "Outside", at: "../readme.md:1", say: "?" },
          ],
        }),
      ),
    );

    expect(problems).toHaveLength(4);
    expect(problems[0]).toContain('flow step 1 ("Missing"): nowhere.ts is not a file in ');
    expect(problems[1]).toContain("service.ts:99 is outside the file, which has 7 lines");
    expect(problems[2]).toContain('"service.ts" is not "path:line"');
    expect(problems[3]).toContain("../readme.md is not a file in ");
  });

  test("a tour sent back for its anchors keeps none of its files, so it takes no place among the newest tours", async () => {
    const { directory, git } = checkoutWithUncommittedWork();

    await problemsOf(snapshotTour(request(join(directory, "app"), { since: "HEAD", flow: [{ title: "Past the end", at: "service.ts:99", say: "?" }] })));

    expect(git("for-each-ref", "refs/mirador/tours/")).toBe("");
  });

  test("with since, a path out of the folder is reported even when the folder has a file of that name, and so is a folder", async () => {
    const { directory } = checkoutWithUncommittedWork();
    writeFileSync(join(directory, "app/readme.md"), "# App\n");
    mkdirSync(join(directory, "app/lib"));
    writeFileSync(join(directory, "app/lib/util.ts"), "export const util = 1;\n");

    const problems = await problemsOf(
      snapshotTour(
        request(join(directory, "app"), {
          since: "HEAD",
          flow: [
            { title: "Outside", at: "../readme.md:1", say: "?" },
            { title: "Folder", at: "lib:1", say: "?" },
          ],
        }),
      ),
    );

    expect(problems).toEqual([expect.stringContaining("../readme.md is not a file in "), expect.stringContaining("lib is not a file in ")]);
  });

  test("since in a folder outside git, a since that is no commit, or a folder that is no absolute path, each say what to fix", async () => {
    const outsideGit = folderWith({ "a.ts": "const a = 1;\n" });
    const { directory } = checkoutWithUncommittedWork();

    expect(await problemsOf(snapshotTour(request(outsideGit, { since: "HEAD", flow: [{ title: "A", at: "a.ts:1", say: "?" }] })))).toEqual([
      expect.stringContaining("is not inside a git checkout, so the tour cannot show what changed; leave since out."),
    ]);
    expect(await problemsOf(snapshotTour(request(join(directory, "app"), { since: "no-such-branch" })))).toEqual([`since: no-such-branch is not a commit in ${realpathSync(join(directory, "app"))}.`]);
    expect(await problemsOf(snapshotTour(request("app")))).toEqual(["folder: app is not an absolute path of a folder."]);
  });

  test("with since, a checkout where core.safecrlf=true refuses to store a file with other line endings still shows what changed", async () => {
    const { directory, git } = checkoutWithUncommittedWork();
    git("config", "core.safecrlf", "true");
    writeFileSync(join(directory, ".gitattributes"), "* text=auto\n");
    writeFileSync(join(directory, "app/windows.ts"), "export const crlf = true;\r\n");

    const tour = await snapshotTour(request(join(directory, "app"), { since: "HEAD" }));

    expect(tour.files.map(({ path, change }) => [path, change])).toEqual([
      ["new.ts", "added"],
      ["service.ts", "modified"],
      ["windows.ts", "added"],
    ]);
  });

  test("with since, git failing to write while taking the snapshot of the current files says what to fix instead of failing with git's own error", async () => {
    const { directory, git } = checkoutWithUncommittedWork();
    const allowWrites = withoutNewObjects(git, directory);
    let problems: string[];
    try {
      problems = await problemsOf(snapshotTour(request(join(directory, "app"), { since: "HEAD" })));
    } finally {
      allowWrites();
    }

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`since: Mirador could not read the files in ${realpathSync(join(directory, "app"))} as they are now to compare with HEAD`);
    expect(problems[0]).toContain("failed to insert into database");
    expect(problems[0]).toContain("fatal: updating files failed. Fix what git reports, or leave since out to show the tour without what changed.");
    expect(problems[0]).not.toContain("..");
  });

  test("with since, a tour is shown even when git cannot drop an older snapshot, and the next tour drops it", async () => {
    const { directory, git } = checkoutWithUncommittedWork();
    const folder = join(directory, "app");
    await snapshotTour(request(folder, { since: "HEAD" }), 1);
    git("pack-refs", "--all");
    const packedRefsLock = join(directory, ".git/packed-refs.lock");
    writeFileSync(packedRefsLock, "");
    let tour: Awaited<ReturnType<typeof snapshotTour>>;
    try {
      tour = await snapshotTour(request(folder, { since: "HEAD" }), 1);
    } finally {
      rmSync(packedRefsLock, { force: true });
    }

    expect(tour.changes).toMatchObject({ since: "HEAD" });
    expect(git("for-each-ref", "refs/mirador/tours/").split("\n").filter(Boolean)).toHaveLength(2);

    await snapshotTour(request(folder, { since: "HEAD" }), 1);

    expect(git("for-each-ref", "refs/mirador/tours/").split("\n").filter(Boolean)).toHaveLength(1);
  });

  test("with since, git failing to keep the files the tour was made from says the tour was not shown instead of failing with git's own error", async () => {
    const { directory, git } = checkoutWithUncommittedWork();
    const allowWrites = withoutMiradorRefs(directory);
    let problems: string[];
    try {
      problems = await problemsOf(snapshotTour(request(join(directory, "app"), { since: "HEAD" })));
    } finally {
      allowWrites();
    }

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("snapshot: Mirador could not keep the files the tour was made from in git");
    expect(problems[0]).toContain("cannot lock ref 'refs/mirador/tours/");
    expect(problems[0]).toContain("Fix what git reports, or leave since out to show the tour without what changed.");
    expect(problems[0]).not.toContain("..");
    expect(git("for-each-ref", "refs/mirador/tours/")).toBe("");
  });
});
