import type { Review, Tour } from "./review.ts";

interface WalkthroughItemBase {
  id: string;
  conversationId: string;
  title: string;
  status: "shown" | "waiting" | "answered" | "cancelled";
  createdAt: number;
}

/** A review as the walkthrough view draws it. */
export interface ReviewItem extends WalkthroughItemBase {
  kind: "review";
  review: Review;
}

/** A tour as the walkthrough view draws it. */
export interface TourItem extends WalkthroughItemBase {
  kind: "tour";
  tour: Tour;
}
