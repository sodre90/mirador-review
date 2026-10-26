import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { PluginItem, PluginItemContext, PluginViewBridge } from "../mirador/api.ts";
import type { GitHubCliProblem, Review, Tour } from "../shared/review.ts";
import type { Recalled, WalkthroughAction } from "../shared/walkthrough-actions.ts";
import type { ReviewItem, TourItem } from "../shared/walkthrough-items.ts";
import { ExternalImagesBlocked } from "./Markdown.tsx";
import { DEFAULT_FLOW_BAND_SHARE, DEFAULT_REVIEW_LIST_SHARE } from "./pane-shares.ts";
import { WalkthroughView } from "./Review.tsx";
import { isMac } from "./shortcuts.ts";
import reviewStyles from "./review.css" with { type: "text" };
import type { WalkthroughHost } from "./walkthrough-host.ts";
import viewStyles from "./view.css" with { type: "text" };

type Walkthrough = Review | Tour;

const bridge = (window as unknown as { mirador: PluginViewBridge<Walkthrough> }).mirador;

const send = (action: WalkthroughAction) => bridge.send(action);

const NOT_IN_A_TOUR = "A tour has no findings to post.";

/** The review or tour as the walkthrough view draws it. */
function walkthroughItem(item: PluginItem<Walkthrough>): ReviewItem | TourItem {
  const shared = { id: item.id, conversationId: "", title: item.title, status: "shown" as const, createdAt: item.createdAt };
  return item.type === "review" ? { ...shared, kind: "review", review: item.data as Review } : { ...shared, kind: "tour", tour: item.data as Tour };
}

/**
 * What a review or tour does through the plugin's bridge: the plugin's host code reads its files, keeps its layout,
 * opens the editor, and keeps the user's choices on a review and posts it.
 */
function useBridgedHost(item: PluginItem<Walkthrough>, context: PluginItemContext, recalled: Recalled, onProblem: (problem: string) => void): WalkthroughHost {
  const [listShare, setListShare] = useState(recalled.paneShares?.listShare ?? DEFAULT_REVIEW_LIST_SHARE);
  const [bandShare, setBandShare] = useState(recalled.paneShares?.bandShare ?? DEFAULT_FLOW_BAND_SHARE);
  useEffect(() => void send({ kind: "remember-pane-shares", shares: { listShare, bandShare } }), [listShare, bandShare]);
  const failed = (error: unknown) => onProblem(error instanceof Error ? error.message : String(error));
  const typing = context.typingAids;
  const isReview = item.type === "review";
  const reviewOnly = (action: WalkthroughAction) => (isReview ? void send(action).catch(failed) : failed(NOT_IN_A_TOUR));
  return {
    openInEditor: (path, line) => void send({ kind: "open-in-editor", path, line }).catch(failed),
    updateFinding: (findingId, change) => reviewOnly({ kind: "update-finding", findingId, ...change }),
    updateAnswer: (answerId, change) => reviewOnly({ kind: "update-answer", answerId, ...change }),
    post: () => reviewOnly({ kind: "post" }),
    reviewAgain: () => reviewOnly({ kind: "review-again" }),
    readFile: async (path) => (await send({ kind: "read-file", path })) as string[],
    checkGitHubCli: async () => (isReview ? ((await send({ kind: "check-github-cli" })) as GitHubCliProblem | null) : null),
    ask: (text) =>
      bridge.prompt(text).then(
        () => true,
        (error) => {
          failed(error);
          return false;
        },
      ),
    fullscreen: context.fullscreen === undefined ? null : { isFullscreen: context.fullscreen, setFullscreen: bridge.setFullscreen },
    paneShares: { listShare, setListShare, bandShare, setBandShare },
    typingAidAttributes: { autoCorrect: typing?.autocorrect ? "on" : "off", writingsuggestions: typing?.predictions ? "true" : "false" },
    placeLeft: () => recalled.place ?? undefined,
    leavePlace: (place) => void send({ kind: "leave-place", place }),
  };
}

function BridgedWalkthrough({ item, context, recalled }: { item: PluginItem<Walkthrough>; context: PluginItemContext; recalled: Recalled }) {
  const [problem, setProblem] = useState<string | null>(null);
  const host = useBridgedHost(item, context, recalled, setProblem);
  return (
    <>
      {problem && (
        <p className="walkthrough-problem" role="alert">
          {problem}
        </p>
      )}
      <WalkthroughView item={walkthroughItem(item)} host={host} />
    </>
  );
}

/** The view waits for what it recalls before its first paint, so the layout the user left doesn't jump into place. */
function WalkthroughPage() {
  const [shown, setShown] = useState<{ item: PluginItem<Walkthrough>; context: PluginItemContext }>();
  const [recalled, setRecalled] = useState<Recalled>();
  useEffect(() => bridge.onItem((item, context) => setShown({ item, context })), []);
  useEffect(() => {
    send({ kind: "recall" }).then(
      (answer) => setRecalled(answer as Recalled),
      () => setRecalled({ paneShares: null, place: null }),
    );
  }, []);
  if (!shown || !recalled) return null;
  return (
    <ExternalImagesBlocked.Provider value={!shown.context.imagesFromOtherSites}>
      <BridgedWalkthrough item={shown.item} context={shown.context} recalled={recalled} />
    </ExternalImagesBlocked.Provider>
  );
}

/** The find shortcut finds in the code, as the review's own button does; the panel leaves it to the view. */
addEventListener("keydown", (event: KeyboardEvent) => {
  const primary = isMac ? event.metaKey : event.ctrlKey;
  if (!primary || event.altKey || event.shiftKey || event.code !== "KeyF") return;
  const trigger = document.querySelector<HTMLButtonElement>(".review-find-trigger");
  if (!trigger) return;
  event.preventDefault();
  trigger.click();
});

const style = document.createElement("style");
style.textContent = `${reviewStyles}\n${viewStyles}`;
document.head.append(style);
const root = document.createElement("div");
root.id = "walkthrough";
document.body.append(root);
createRoot(root).render(<WalkthroughPage />);
