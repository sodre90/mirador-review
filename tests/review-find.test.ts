import { describe, expect, test } from "bun:test";
import type { DiffRow } from "../shared/review.ts";
import { findTally, firstPlaceIn, matchesInFiles, matchesInHunks, placeAmong, positionOf, stepped, type FileMatches } from "../web/review-find.ts";

const row = (text: string, kind: DiffRow["kind"] = "context"): DiffRow => ({ kind, oldLine: null, newLine: null, text });
const ignoringCase = { caseSensitive: false };

/** Files with this many matches each, in the order they are listed. */
const filesWith = (...counts: number[]): FileMatches[] =>
  counts.map((count, file) => ({ path: `file${file}.ts`, matches: Array.from({ length: count }, (_, index) => ({ hunk: 0, row: index, start: 0, end: 1 })) }));

describe("matches in a review", () => {
  test("are found in every hunk's rows, removed lines too, but not in a row that stands for lines left out", () => {
    const hunks = [[row("const needle = 1;"), row("… 40 lines not shown, a needle among them …", "elided")], [row("needle(needle)", "removed")]];
    expect(matchesInHunks(hunks, "needle", ignoringCase)).toEqual([
      { hunk: 0, row: 0, start: 6, end: 12 },
      { hunk: 1, row: 0, start: 0, end: 6 },
      { hunk: 1, row: 0, start: 7, end: 13 },
    ]);
  });

  test("are kept by file, in the order the files are listed", () => {
    const found = matchesInFiles([{ path: "b.ts", hunks: [[row("Needle")]] }, { path: "a.ts", hunks: [[row("none here")]] }], "needle", ignoringCase);
    expect(found.map(({ path, matches }) => [path, matches.length])).toEqual([
      ["b.ts", 1],
      ["a.ts", 0],
    ]);
  });
});

describe("the current match", () => {
  test("starts at the open file's first one, and there is none while the open file has none", () => {
    const found = filesWith(2, 0, 3);
    expect(firstPlaceIn(found, "file2.ts")).toEqual({ path: "file2.ts", index: 0 });
    expect(firstPlaceIn(found, "file1.ts")).toBeNull();
  });

  test("steps through the file, then on into the next file with matches, and round from the last to the first", () => {
    const found = filesWith(2, 0, 3);
    expect(stepped(found, { path: "file0.ts", index: 0 }, "file0.ts", 1)).toEqual({ path: "file0.ts", index: 1 });
    expect(stepped(found, { path: "file0.ts", index: 1 }, "file0.ts", 1)).toEqual({ path: "file2.ts", index: 0 });
    expect(stepped(found, { path: "file2.ts", index: 2 }, "file2.ts", 1)).toEqual({ path: "file0.ts", index: 0 });
    expect(stepped(found, { path: "file2.ts", index: 0 }, "file2.ts", -1)).toEqual({ path: "file0.ts", index: 1 });
    expect(stepped(found, { path: "file0.ts", index: 0 }, "file0.ts", -1)).toEqual({ path: "file2.ts", index: 2 });
  });

  test("goes round within a file that alone has matches", () => {
    const found = filesWith(0, 2);
    expect(stepped(found, { path: "file1.ts", index: 1 }, "file1.ts", 1)).toEqual({ path: "file1.ts", index: 0 });
    expect(stepped(found, { path: "file1.ts", index: 0 }, "file1.ts", -1)).toEqual({ path: "file1.ts", index: 1 });
  });

  test("from an open file without matches, a step goes to the next file's first match, or back to the previous file's last", () => {
    const found = filesWith(2, 0, 3);
    expect(stepped(found, null, "file1.ts", 1)).toEqual({ path: "file2.ts", index: 0 });
    expect(stepped(found, null, "file1.ts", -1)).toEqual({ path: "file0.ts", index: 1 });
    expect(stepped(filesWith(0, 0), null, "file0.ts", 1)).toBeNull();
  });

  test("stays within its file's matches when revealed lines change them", () => {
    expect(placeAmong(filesWith(2), { path: "file0.ts", index: 5 })).toEqual({ path: "file0.ts", index: 1 });
    expect(placeAmong(filesWith(0), { path: "file0.ts", index: 0 })).toBeNull();
  });
});

describe("the find bar's tally", () => {
  const found = filesWith(2, 0, 3);

  test("counts the current match from the first file's first", () => {
    expect(positionOf(found, { path: "file2.ts", index: 1 })).toBe(4);
    expect(findTally("needle", ignoringCase, found, { path: "file2.ts", index: 1 })).toBe("4 of 5");
  });

  test("says how many matches there are without a current one, none, or why the pattern finds nothing", () => {
    expect(findTally("needle", ignoringCase, found, null)).toBe("5 matches");
    expect(findTally("needle", ignoringCase, filesWith(0, 1), null)).toBe("1 match");
    expect(findTally("needle", ignoringCase, filesWith(0), null)).toBe("No matches");
    expect(findTally("needle(", { caseSensitive: false, regex: true }, [], null)).toBe("Invalid pattern");
    expect(findTally("", ignoringCase, [], null)).toBe("");
  });
});
