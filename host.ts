import * as z from "zod/v4";
import type { CanvasActionContext, CanvasHost, CanvasPluginContext, CanvasTool, PluginItem, PluginItemType } from "./mirador/api.ts";
import type { Review, Tour } from "./shared/review.ts";
import type { PlaceInWalkthrough, Recalled, StoredPaneShares, WalkthroughAction } from "./shared/walkthrough-actions.ts";
import { openInIdea } from "./host/review/editor.ts";
import { ghCli, type GitHubCli } from "./host/review/github.ts";
import { reviewedFileLines } from "./host/review/snapshot.ts";
import { snapshotTour, touredFileLines } from "./host/review/tour.ts";
import { codeReviews, reviewActionKinds, type ReviewAction } from "./reviews.ts";

const tourStepSchema = z.object({
  title: z.string().min(1).describe('A few words, e.g. "Controller accepts the request".'),
  at: z
    .string()
    .min(3)
    .describe('Where this step happens; a range for a whole method. Written "path:line" or "path:start-end": the path relative to folder, lines of the file as it is now.'),
  say: z.string().min(1).describe("Markdown: what happens here and why it matters, in a few sentences."),
});

const tourSchema = z.object({
  title: z.string().min(1).describe('What the tour is about, e.g. "How a message reaches the agent".'),
  folder: z.string().min(1).describe("Absolute path of the folder the steps' paths are relative to, usually your working directory."),
  since: z
    .string()
    .optional()
    .describe(
      "To walk the user through what you changed: the git ref the changes count from, e.g. HEAD for uncommitted work, or the commit the task started from. Changed lines are marked in the steps and the diff gets a tab. Leave it out to show the code as it is.",
    ),
  summary: z.string().min(1).describe("Markdown for the user: what the code does, or what you changed, and how it flows, in plain words, so they understand it fast."),
  flow: z.array(tourStepSchema).min(1).describe("The tour, in the order the code runs: the entry point first, then each place control or data goes."),
});

const PANE_SHARES_KEY = "pane-shares";
const PLACES_KEY = "places";
/** Places in this many items stay, the latest left; older ones are let go. */
const PLACES_KEPT = 50;

type Places = Record<string, PlaceInWalkthrough>;

type Walkthrough = Tour | Review;

function leavePlace(context: CanvasPluginContext<Walkthrough>, itemId: string, place: PlaceInWalkthrough) {
  const { [itemId]: _, ...others } = (context.storage.get(PLACES_KEY) ?? {}) as Places;
  const kept = Object.entries(others).slice(-(PLACES_KEPT - 1));
  context.storage.set(PLACES_KEY, Object.fromEntries([...kept, [itemId, place]]));
}

function recall(context: CanvasPluginContext<Walkthrough>, itemId: string): Recalled {
  const places = (context.storage.get(PLACES_KEY) ?? {}) as Places;
  return { paneShares: (context.storage.get(PANE_SHARES_KEY) as StoredPaneShares | undefined) ?? null, place: places[itemId] ?? null };
}

const isReview = (item: PluginItem<Walkthrough>): item is PluginItem<Review> => item.type === "review";

const isReviewAction = (action: WalkthroughAction): action is ReviewAction => (reviewActionKinds as readonly string[]).includes(action.kind);

const readFile = (item: PluginItem<Walkthrough>, path: string) =>
  isReview(item) ? reviewedFileLines(item.data, path) : touredFileLines(item.data as Tour, path);

const checkoutOf = (item: PluginItem<Walkthrough>) => (isReview(item) ? item.data.repository : (item.data as Tour).folder);

const tourTool: CanvasTool<Tour> = {
  description:
    "Publish a guided tour of the code flow to the user's canvas: a summary, then steps in the order the code runs, each anchored to lines the page shows with the code around them (read from the files, so do not paste code). Use it to explain how code works, or with since to walk the user through what you changed: changed lines are marked and the diff gets a tab. The user can ask you about any lines. Anchors are checked; if any are wrong, nothing is shown and the result lists them all. To change a tour, publish it again.",
  input: z.toJSONSchema(tourSchema, { io: "input" }),
  async run(input, { publish }) {
    const request = input as z.infer<typeof tourSchema>;
    const tour = await snapshotTour(request);
    const { id } = publish({ type: "tour", title: request.title, data: tour });
    const changes = tour.changes ? `, ${tour.files.length} files changed since ${tour.changes.since}` : "";
    return `Shown to the user as tour ${id}: ${tour.flow.length} flow steps${changes}.`;
  },
};

const TOUR_INSTRUCTIONS =
  "- tour: when you explain how code works, or walk the user through code you changed, publish a guided tour of its flow with this tool rather than show: steps anchored to lines, which the page shows with the code. Pass since to mark what you changed and show its diff.";

const TOUR_OFTEN =
  "- tour: explaining how code works, and at the end of a substantial coding task, walking the user through what you changed (pass since) instead of a summary page. Keep the chat reply to a few lines that point at the tour.";

/**
 * Mirador's code reviews and code tours: the agent's review of a change, which the user curates and posts to the pull
 * request with gh, and its guided read of how code works or what it changed. Both are anchored to lines the view shows
 * with the code around them. What runs gh is given, so tests can stand in for it.
 */
export function codeReviewPlugin(gh: GitHubCli): CanvasHost<Walkthrough> {
  const reviews = codeReviews(gh);

  function act(item: PluginItem<Walkthrough>, action: WalkthroughAction, context: CanvasActionContext<Walkthrough>) {
    switch (action.kind) {
      case "recall":
        return recall(context, item.id);
      case "remember-pane-shares":
        return void context.storage.set(PANE_SHARES_KEY, action.shares);
      case "leave-place":
        return void leavePlace(context, item.id, action.place);
      case "read-file":
        return readFile(item, action.path);
      case "open-in-editor":
        return void openInIdea(checkoutOf(item), action.path, action.line);
    }
    if (isReviewAction(action) && isReview(item)) return reviews.act(item, action, context as CanvasActionContext<Review>);
    throw new Error(isReviewAction(action) ? "Only a review takes that action." : "The review plugin doesn't know that action.");
  }

  return {
    items: {
      review: reviews.type as PluginItemType<Walkthrough>,
      tour: { icon: "↯", placement: "page" },
    },
    tools: { ...reviews.tools, tour: tourTool } as Record<string, CanvasTool<Walkthrough>>,
    guidance: { instructions: `${reviews.guidance}\n${TOUR_INSTRUCTIONS}`, often: TOUR_OFTEN },
    action: (item, action, context) => act(item, action as WalkthroughAction, context),
  };
}

export default codeReviewPlugin(ghCli);
