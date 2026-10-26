import { createContext, useContext } from "react";
import type { FindingDecision, GitHubCliProblem } from "../shared/review.ts";
import type { PlaceInWalkthrough } from "../shared/walkthrough-actions.ts";

/** The review's list as a part of its width, and the Flow tab's steps as a part of its height, with their setters. */
export interface WalkthroughPaneShares {
  listShare: number;
  setListShare: (share: number) => void;
  bandShare: number;
  setBandShare: (share: number) => void;
}

/**
 * What a review or tour reaches for outside itself, for one item: Mirador's panel provides it over its connection, and
 * the review plugin's view over its bridge.
 */
export interface WalkthroughHost {
  openInEditor(path: string, line: number): void;
  updateFinding(findingId: string, change: { decision?: FindingDecision; body?: string }): void;
  updateAnswer(answerId: string, change: { decision?: FindingDecision; body?: string; resolve?: boolean }): void;
  post(): void;
  reviewAgain(): void;
  /** The reviewed or toured version of a file, line by line. */
  readFile(path: string): Promise<string[]>;
  checkGitHubCli(): Promise<GitHubCliProblem | null>;
  /** Sends the agent a question as the composer sends; false when it couldn't go. */
  ask(text: string): Promise<boolean>;
  fullscreen: { isFullscreen: boolean; setFullscreen(on: boolean): void } | null;
  paneShares: WalkthroughPaneShares;
  typingAidAttributes: { autoCorrect: "on" | "off"; writingsuggestions: "true" | "false" };
  placeLeft(): PlaceInWalkthrough | undefined;
  leavePlace(place: PlaceInWalkthrough): void;
}

export const WalkthroughHostContext = createContext<WalkthroughHost | null>(null);

export function useWalkthroughHost() {
  const host = useContext(WalkthroughHostContext);
  if (!host) throw new Error("A review or tour needs a WalkthroughHost.");
  return host;
}
