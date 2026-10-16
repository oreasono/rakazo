import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { AppBootstrap, ThreadSnapshot } from "@rakazo/contracts";
import { ThreadSnapshotSchema } from "@rakazo/contracts";
import {
  CHILD_THREAD_ID,
  nativeRecoverySnapshot,
  RECOVERY_PROMPT,
  ROOT_THREAD_ID,
  recoveryStages,
} from "./fixtures/native-session-recovery";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

async function expectRecoveryTree(page: Page, stage: (typeof recoveryStages)[number]) {
  const tree = page.getByTestId("native-session-tree");
  await expect(tree).toHaveCount(1);
  await expect(tree).toHaveAttribute("data-root-thread-id", ROOT_THREAD_ID);
  await expect(tree.locator("[data-native-thread-id]")).toHaveCount(2);
  const root = tree.locator(`[data-native-thread-id="${ROOT_THREAD_ID}"]`);
  const child = tree.locator(`[data-native-thread-id="${CHILD_THREAD_ID}"]`);
  await expect(root).toHaveAttribute("data-depth", "0");
  await expect(root).not.toHaveAttribute("data-parent-thread-id");
  await expect(child).toHaveAttribute("data-depth", "1");
  await expect(child).toHaveAttribute("data-parent-thread-id", ROOT_THREAD_ID);
  await expect(child).toHaveAttribute("data-native-status", stage.nativeStatus);
  await expect(child).toHaveAttribute(
    "data-status",
    stage.nativeStatus === "recovering" ? "running" : "failed",
  );
  const label = child.getByText(stage.label, { exact: true });
  await expect(label).toBeInViewport();
  await expect(label).toHaveClass(`shrink-0 text-${stage.tone}`);
  await expect(child.locator(".text-success")).toHaveCount(0);
  await expect(root).toHaveAttribute(
    "data-native-status",
    stage.nativeStatus === "interrupted" ? "completed" : stage.nativeStatus,
  );
  await expect(root.getByText(ROOT_THREAD_ID, { exact: true })).toBeInViewport();
  await expect(child.getByText(CHILD_THREAD_ID, { exact: true })).toBeInViewport();
  // Native metadata stays in the shared tree, without duplicate transcript task cards.
  const transcript = page.getByTestId("transcript");
  await expect(transcript.getByText(RECOVERY_PROMPT, { exact: true })).toBeVisible();
  await expect(transcript.getByText("Release reviewer", { exact: true })).toHaveCount(0);
}

test("native session recovery survives reconnect refresh and page reload", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem("rakazo.uiAppearance", "light"));
  await signup(page, `native-recovery-${Date.now()}@rakazo.test`, "password12", "Recovery E2E");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const bootstrap = await rpc<AppBootstrap>(page, "bootstrap", { botId });
  const base = await rpc<ThreadSnapshot>(page, "threads/get", { botId });
  let current = ThreadSnapshotSchema.parse(nativeRecoverySnapshot(base, "recovering"));
  let refreshes = 0;

  // Use the usual API fixture boundary, not a component fixture. Shell performs
  // mergeThreadSnapshot -> buildNativeSessionTrees -> NativeSessionTrees itself.
  await page.route("**/rpc/bootstrap", (route) =>
    route.fulfill({ json: { json: { ...bootstrap, thread: current } } }),
  );
  await page.route("**/rpc/threads/get", (route) => {
    refreshes += 1;
    return route.fulfill({ json: { json: current } });
  });
  // EOF exercises the production subscription's reconnect-and-refresh path.
  // No runtime request, model, computer or database mutation supplies these states.
  await page.route("**/rpc/threads/subscribe", (route) =>
    route.fulfill({ contentType: "text/event-stream", body: "" }),
  );
  await page.reload({ waitUntil: "domcontentloaded" });

  for (const stage of recoveryStages) {
    const previousRefreshes = refreshes;
    current = ThreadSnapshotSchema.parse(nativeRecoverySnapshot(base, stage.nativeStatus));
    await expect.poll(() => refreshes).toBeGreaterThan(previousRefreshes);
    await expectRecoveryTree(page, stage);
    await captureScreenshot(page, testInfo, `native-session-${stage.nativeStatus}-refresh`);

    // Rebuild from bootstrap after losing all in-memory overlays; identity and
    // recovery labels must survive, including the stale completed message above.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expectRecoveryTree(page, stage);
    await captureScreenshot(page, testInfo, `native-session-${stage.nativeStatus}-reload`);
  }
});
