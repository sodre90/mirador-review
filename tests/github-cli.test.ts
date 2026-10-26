import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitHubCliProblemOn } from "../host/review/github.ts";
import { fakeProgram } from "./fake-program.ts";

const root = mkdtempSync(join(tmpdir(), "mirador-gh-"));
const withGh = join(root, "with-gh");
const withoutGh = join(root, "without-gh");
mkdirSync(withGh);
mkdirSync(withoutGh);
fakeProgram(withGh, "gh", `process.exit(process.argv.slice(2).join(" ") === "auth status --hostname ghe.example.com" ? 0 : 1);`);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("gitHubCliProblemOn", () => {
  test("finds no problem when gh is logged in to the pull request's host", async () => {
    expect(await gitHubCliProblemOn("ghe.example.com", withGh)).toBeNull();
  });

  test("says gh is logged out when it has no account it can use on that host", async () => {
    expect(await gitHubCliProblemOn("github.com", withGh)).toBe("logged-out");
  });

  test("says gh is missing when it is nowhere on the search path", async () => {
    expect(await gitHubCliProblemOn("ghe.example.com", withoutGh)).toBe("missing");
  });
});
