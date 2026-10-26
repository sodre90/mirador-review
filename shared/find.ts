export const MIN_SEARCH_LENGTH = 2;

const escapedForRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Finding ignores case unless the find bar's Match case is on; a review's find bar can also match whole words or a regular expression. */
export interface MatchOptions {
  caseSensitive: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

export const ignoringCase: MatchOptions = { caseSensitive: false };

/** A word is made of letters, digits and _, as in code. */
const asWholeWord = (source: string) => `(?<!\\w)(?:${source})(?!\\w)`;

/** Null for a regular expression that does not compile, which finds nothing. */
function patternFor(query: string, { caseSensitive, wholeWord = false, regex = false }: MatchOptions) {
  const source = regex ? query : escapedForRegExp(query);
  try {
    return new RegExp(wholeWord ? asWholeWord(source) : source, caseSensitive ? "g" : "gi");
  } catch {
    return null;
  }
}

export const isValidQuery = (query: string, options: MatchOptions) => patternFor(query, options) !== null;

/** Where the query occurs in the text: [start, end) offsets of each occurrence, in order. An empty match, as of ^, is none. */
export function matchOffsets(text: string, query: string, options = ignoringCase): [number, number][] {
  const pattern = query === "" ? null : patternFor(query, options);
  if (!pattern) return [];
  return [...text.matchAll(pattern)].filter((match) => match[0] !== "").map((match) => [match.index, match.index + match[0].length]);
}

/** How often the query occurs in the text; a one-letter query can occur millions of times, so none is kept. */
export function matchCount(text: string, query: string, options = ignoringCase) {
  const pattern = query === "" ? null : patternFor(query, options);
  if (!pattern) return 0;
  let count = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match[0] === "") pattern.lastIndex++;
    else count++;
  }
  return count;
}
