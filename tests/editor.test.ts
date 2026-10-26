import { expect, test } from "bun:test";
import { posix, win32 } from "node:path";
import { fileInCheckout, ideaLauncherMissing } from "../host/review/editor.ts";

test("without IDEA's launcher, the host says how IDEA sets one up on the host's platform", () => {
  expect(ideaLauncherMissing("darwin")).toContain("In IDEA, choose Tools › Create Command Line Launcher…");
  expect(ideaLauncherMissing("win32")).toContain(`Tick Add "bin" folder to the PATH in IDEA's installer, or install IDEA with the Toolbox App, then try again.`);
  expect(ideaLauncherMissing("win32")).not.toContain("Create Command Line Launcher");
});

test("a line of the review opens in its file in the checkout, also where git names a Windows checkout with /", () => {
  expect(fileInCheckout("/work/shop", "src/app.ts", 3, posix)).toBe("/work/shop/src/app.ts");
  expect(fileInCheckout("C:/Users/me/shop", "src/app.ts", 3, win32)).toBe("C:\\Users\\me\\shop\\src\\app.ts");
  expect(fileInCheckout("C:\\Users\\me\\shop\\", "src\\app.ts", 3, win32)).toBe("C:\\Users\\me\\shop\\src\\app.ts");
});

test("a file outside the checkout, or no line of it, does not open", () => {
  expect(() => fileInCheckout("/work/shop", "../secrets.txt", 1, posix)).toThrow("../secrets.txt:1 is not a line in the reviewed checkout.");
  expect(() => fileInCheckout("/work/shop", "/etc/hosts", 1, posix)).toThrow("is not a line in the reviewed checkout");
  expect(() => fileInCheckout("C:/Users/me/shop", "..\\secrets.txt", 1, win32)).toThrow("is not a line in the reviewed checkout");
  expect(() => fileInCheckout("/work/shop", "src/app.ts", 0, posix)).toThrow("is not a line in the reviewed checkout");
});
