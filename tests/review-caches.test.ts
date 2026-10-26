import { beforeEach, describe, expect, test } from "bun:test";
import { evictStaleReviewCaches, reviewedFile, reviewedFiles, shownContexts } from "../web/Review.tsx";

describe("review caches and eviction", () => {
  beforeEach(() => {
    shownContexts.clear();
    reviewedFiles.clear();
  });

  test("evictStaleReviewCaches drops contexts and files for older review items", () => {
    shownContexts.set("old-1:file.ts", { fileLines: ["line 1"], revealed: [] });
    shownContexts.set("old-2:file.ts", { fileLines: ["line 2"], revealed: [] });
    shownContexts.set("current:file.ts", { fileLines: ["line 3"], revealed: [] });

    reviewedFiles.set("old-1:file.ts", Promise.resolve(["line 1"]));
    reviewedFiles.set("current:file.ts", Promise.resolve(["line 3"]));

    evictStaleReviewCaches("current");

    expect(Array.from(shownContexts.keys())).toEqual(["current:file.ts"]);
    expect(Array.from(reviewedFiles.keys())).toEqual(["current:file.ts"]);
  });

  test("reviewedFile caches the in-flight read and clears it on failure so retrying works", async () => {
    const failed = reviewedFile("item-1", "src/index.ts", () => Promise.reject(new Error("Not connected to the host.")));
    await expect(failed).rejects.toThrow("Not connected to the host.");
    expect(reviewedFiles.has("item-1:src/index.ts")).toBe(false);

    let reads = 0;
    const read = async () => {
      reads += 1;
      return ["first line", "second line"];
    };
    const retried = reviewedFile("item-1", "src/index.ts", read);
    expect(reviewedFiles.has("item-1:src/index.ts")).toBe(true);
    expect(await retried).toEqual(["first line", "second line"]);
    expect(await reviewedFile("item-1", "src/index.ts", read)).toEqual(["first line", "second line"]);
    expect(reads).toBe(1);
  });
});
