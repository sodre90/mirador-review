import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { DiffRow, ReviewFile } from "../shared/review.ts";
import { FindToggle, keepsFocusInQuery, noToggles, toggleButtons, type FindToggles } from "./FindToggle.tsx";
import { hints } from "./hints.ts";
import { firstPlaceIn, findTally, matchesInFiles, placeAmong, stepped, type CodeMatch, type FindPlace } from "./review-find.ts";

/** Highlighting creates a range per match, and every range slows each later change of the page. */
const MAX_HIGHLIGHTED = 1_000;

/** Not the conversation's highlights, which an open conversation find bar keeps setting. */
const MATCHES = "review-find-match";
const CURRENT = "review-find-current";

const canHighlight = typeof CSS !== "undefined" && "highlights" in CSS;

function highlight(ranges: Range[], current: Range | null) {
  if (!canHighlight) return;
  CSS.highlights.set(MATCHES, new Highlight(...ranges));
  if (current) CSS.highlights.set(CURRENT, new Highlight(current));
  else CSS.highlights.delete(CURRENT);
}

function clearHighlights() {
  if (!canHighlight) return;
  CSS.highlights.delete(MATCHES);
  CSS.highlights.delete(CURRENT);
}

/** The rows the diff of the open file shows, by hunk: flow markers and finding cards sit between them. */
const rowElementsOf = (diff: Element) => [...diff.querySelectorAll(":scope > .hunk")].map((hunk) => [...hunk.querySelectorAll(":scope > .code-block > .code-row")]);

/** Syntax highlighting splits a row's text into elements, so a match may start in one and end in another. */
function rangeIn(code: Element, start: number, end: number) {
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  const pieces: { node: Text; start: number }[] = [];
  let length = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    pieces.push({ node, start: length });
    length += node.data.length;
  }
  const at = (offset: number, holds: (pieceStart: number) => boolean) => {
    const piece = pieces.findLast(({ start: pieceStart }) => holds(pieceStart))!;
    return [piece.node, offset - piece.start] as const;
  };
  const range = document.createRange();
  range.setStart(...at(start, (pieceStart) => pieceStart <= start));
  range.setEnd(...at(end, (pieceStart) => pieceStart < end));
  return range;
}

function scrollToMiddle(scroller: HTMLElement, target: Element) {
  const box = target.getBoundingClientRect();
  scroller.scrollTop += box.top - scroller.getBoundingClientRect().top - (scroller.clientHeight - box.height) / 2;
}

/** The matches nearest the current one, when there are too many to highlight. */
const aroundIndex = <T,>(items: T[], index: number) => {
  const from = Math.max(0, Math.min(index - MAX_HIGHLIGHTED / 2, items.length - MAX_HIGHLIGHTED));
  return items.slice(from, from + MAX_HIGHLIGHTED);
};

/**
 * Finds text in the code of a review's or tour's changed files, in the lines their diffs show. The current match is in
 * the open file; stepping past its last match opens the next file with one.
 */
export function useReviewFind({
  files,
  rowsShownOf,
  openPath,
  linesRevealed,
  showing,
  root,
  onOpen,
}: {
  files: ReviewFile[];
  rowsShownOf: (file: ReviewFile) => DiffRow[][];
  openPath: string | null;
  /** Changes whenever lines are revealed in a diff, which the find then searches too. */
  linesRevealed: number;
  /** Whether the Files tab, and so the find bar, is shown. */
  showing: boolean;
  root: RefObject<HTMLElement | null>;
  /** Opens the file at the hunk, scrolled by the find rather than to the hunk. */
  onOpen: (path: string, hunk: number) => void;
}) {
  const [query, setQuery] = useState<string | null>(null);
  const [toggles, setToggles] = useState<FindToggles>(noToggles);
  const [chosen, setChosen] = useState<{ search: string; place: FindPlace } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const placeShown = useRef<string | null>(null);
  const search = JSON.stringify([query, toggles]);
  const found = useMemo(
    () => (query ? matchesInFiles(files.map((file) => ({ path: file.path, hunks: rowsShownOf(file) })), query, toggles) : []),
    [search, files, linesRevealed],
  );
  const stillChosen = chosen?.search === search && chosen.place.path === openPath ? placeAmong(found, chosen.place) : null;
  const place = stillChosen ?? firstPlaceIn(found, openPath);

  const matchAt = ({ path, index }: FindPlace): CodeMatch | undefined => found.find((file) => file.path === path)?.matches[index];

  useEffect(() => {
    const diff = root.current?.querySelector<HTMLElement>(".file-diff");
    const openFile = files.find(({ path }) => path === openPath);
    if (!showing || !query || !diff || !openFile) return;
    const rows = rowsShownOf(openFile);
    const rowElements = rowElementsOf(diff);
    const rangeOf = ({ hunk, row, start, end }: CodeMatch) => {
      const code = rowElements[hunk]?.[row]?.querySelector(".code-text");
      return code?.textContent === rows[hunk]?.[row]?.text ? rangeIn(code!, start, end) : null;
    };
    const matches = found.find(({ path }) => path === openPath)?.matches ?? [];
    const current = place ? matchAt(place) : undefined;
    highlight(
      aroundIndex(matches, place?.index ?? 0).flatMap((match) => rangeOf(match) ?? []),
      current ? rangeOf(current) : null,
    );
    const shownKey = place && `${search} ${place.path} ${place.index}`;
    if (current && shownKey !== placeShown.current) {
      placeShown.current = shownKey;
      const row = rowElements[current.hunk]?.[current.row];
      if (row) scrollToMiddle(diff, row);
    }
    return clearHighlights;
  }, [found, place?.path, place?.index, showing, openPath]);

  const step = (direction: 1 | -1) => {
    const next = stepped(found, place, openPath, direction);
    if (!next) return;
    setChosen({ search, place: next });
    onOpen(next.path, matchAt(next)!.hunk);
  };
  const toggle = (name: keyof FindToggles) => setToggles((current) => ({ ...current, [name]: !current[name] }));
  const open = () => {
    const openQuery = inputRef.current;
    if (openQuery) {
      openQuery.focus();
      openQuery.select();
    } else if (query === null) setQuery("");
  };
  const close = () => {
    setQuery(null);
    setToggles(noToggles);
    setChosen(null);
    placeShown.current = null;
    root.current?.focus({ preventScroll: true });
  };
  const matchCounts = new Map(found.map(({ path, matches }) => [path, matches.length]));
  const tally = query === null ? "" : findTally(query, toggles, found, place);
  const canStep = found.some(({ matches }) => matches.length > 0);
  return { query, toggles, tally, canStep, matchCounts, search: setQuery, toggle, step, open, close, inputRef };
}

export type ReviewFind = ReturnType<typeof useReviewFind>;

export function ReviewFindBar({ find: { query, toggles, tally, canStep, search, toggle, step, close, inputRef } }: { find: ReviewFind }) {
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };
  return (
    <div className="find-bar" role="search">
      <input
        ref={inputRef}
        autoFocus
        value={query ?? ""}
        onChange={(event) => search(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Find in the changed files"
        aria-label="Find in the changed files"
        spellCheck={false}
        autoComplete="off"
      />
      {toggleButtons.map(({ toggle: name, label, name: toggleName, hint }) => (
        <FindToggle key={name} className={name} label={label} name={toggleName} hint={hint} on={toggles[name]} onToggle={() => toggle(name)} />
      ))}
      <span className="find-tally" aria-live="polite">
        {tally}
      </span>
      <button type="button" className="icon" aria-label="Previous match" data-hint={hints.reviewFindPrevious} disabled={!canStep} onMouseDown={keepsFocusInQuery} onClick={() => step(-1)}>
        ↑
      </button>
      <button type="button" className="icon" aria-label="Next match" data-hint={hints.reviewFindNext} disabled={!canStep} onMouseDown={keepsFocusInQuery} onClick={() => step(1)}>
        ↓
      </button>
      <button type="button" className="icon" aria-label="Close find" onClick={close}>
        ×
      </button>
    </div>
  );
}
