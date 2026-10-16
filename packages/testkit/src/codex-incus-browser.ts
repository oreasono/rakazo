import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";

/** Capture the real tree itself; DOM visibility alone does not put it in the viewport. */
export async function captureNativeTree(
  page: Page,
  tree: { rootThreadId: string; childThreadIds: string[] },
  screenshot: string,
) {
  const container = page.locator(
    `[data-testid="native-session-tree"][data-root-thread-id="${tree.rootThreadId}"]`,
  );
  await container.waitFor({ state: "visible", timeout: 30_000 });
  const ids = [tree.rootThreadId, ...tree.childThreadIds];
  for (const id of ids) {
    await container
      .locator(`[data-native-thread-id="${id}"]`)
      .waitFor({ state: "visible", timeout: 30_000 });
  }
  await container.scrollIntoViewIfNeeded();
  const box = await container.boundingBox();
  const viewport = page.viewportSize();
  assert(box && viewport && box.width > 0 && box.height > 0, "Tree has no capture bounds");
  assert(
    box.x >= 0 &&
      box.y >= 0 &&
      box.x + box.width <= viewport.width + 1 &&
      box.y + box.height <= viewport.height + 1,
    "Native tree does not fit in the viewport; enlarge the capture viewport before taking evidence",
  );
  const bytes = await container.screenshot({ path: screenshot, animations: "disabled" });
  const pageScreenshot = screenshot.replace(/\.png$/, "-page.png");
  const pageBytes = await page.screenshot({ path: pageScreenshot, animations: "disabled" });
  return {
    capturedAt: new Date().toISOString(),
    rootThreadId: tree.rootThreadId,
    childThreadIds: tree.childThreadIds,
    screenshot,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    pageScreenshot,
    pageSha256: createHash("sha256").update(pageBytes).digest("hex"),
    boundingBox: box,
    viewport,
  };
}
