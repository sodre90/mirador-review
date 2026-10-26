import { isValidQuery, matchOffsets, type MatchOptions } from "../shared/find.ts";
import type { DiffRow } from "../shared/review.ts";

/** A match in a file's diff: the hunk, the row among the rows the diff shows of it, and where in the row's text. */
export interface CodeMatch {
  hunk: number;
  row: number;
  start: number;
  end: number;
}

export interface FileMatches {
  path: string;
  matches: CodeMatch[];
}

/** The current match: the one at this index among its file's. */
export interface FindPlace {
  path: string;
  index: number;
}

/** A row that stands for lines left out is not code. */
export function matchesInHunks(hunks: DiffRow[][], query: string, options: MatchOptions): CodeMatch[] {
  return hunks.flatMap((rows, hunk) =>
    rows.flatMap((row, index) => (row.kind === "elided" ? [] : matchOffsets(row.text, query, options).map(([start, end]) => ({ hunk, row: index, start, end })))),
  );
}

/** Every file's matches, in the order the files are listed. */
export const matchesInFiles = (files: { path: string; hunks: DiffRow[][] }[], query: string, options: MatchOptions): FileMatches[] =>
  files.map(({ path, hunks }) => ({ path, matches: matchesInHunks(hunks, query, options) }));

const total = (found: FileMatches[]) => found.reduce((sum, { matches }) => sum + matches.length, 0);

/** A new search, or another file opened, starts at the open file's first match; with none there, there is no current match. */
export function firstPlaceIn(found: FileMatches[], path: string | null): FindPlace | null {
  const file = found.find((each) => each.path === path);
  return file && file.matches.length > 0 ? { path: file.path, index: 0 } : null;
}

/** The place still within its file's matches, once revealed lines changed them. */
export function placeAmong(found: FileMatches[], place: FindPlace): FindPlace | null {
  const count = found.find(({ path }) => path === place.path)?.matches.length ?? 0;
  return count > 0 ? { path: place.path, index: Math.min(place.index, count - 1) } : null;
}

/** The files after the one at the index, going down (1) or up (-1), round to it again last; from the top or bottom without one. */
function filesFrom(found: FileMatches[], index: number, direction: 1 | -1) {
  if (index === -1) return direction === 1 ? found : [...found].reverse();
  const downward = [...found.slice(index + 1), ...found.slice(0, index + 1)];
  return direction === 1 ? downward : [...downward.slice(0, -1).reverse(), downward.at(-1)!];
}

/**
 * The next match down (1) or up (-1): in the same file, else on into the next file with matches, and round from the
 * last match to the first. Without a current match, the open file has none, and the step goes to the next file's.
 */
export function stepped(found: FileMatches[], place: FindPlace | null, openPath: string | null, direction: 1 | -1): FindPlace | null {
  const file = found.find(({ path }) => path === (place?.path ?? openPath));
  if (place && file && place.index + direction >= 0 && place.index + direction < file.matches.length) return { path: place.path, index: place.index + direction };
  const next = filesFrom(found, file ? found.indexOf(file) : -1, direction).find(({ matches }) => matches.length > 0);
  if (!next) return null;
  return { path: next.path, index: direction === 1 ? 0 : next.matches.length - 1 };
}

/** The match at the place, counted from the first file's first match. */
export function positionOf(found: FileMatches[], place: FindPlace) {
  const fileIndex = found.findIndex(({ path }) => path === place.path);
  return total(found.slice(0, fileIndex)) + place.index + 1;
}

/** Where the current match is among them all, or how many there are without one, or why there are none. */
export function findTally(query: string, options: MatchOptions, found: FileMatches[], place: FindPlace | null) {
  if (query === "") return "";
  if (!isValidQuery(query, options)) return "Invalid pattern";
  const count = total(found);
  if (count === 0) return "No matches";
  if (place) return `${positionOf(found, place)} of ${count}`;
  return count === 1 ? "1 match" : `${count} matches`;
}
