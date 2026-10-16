import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser } from "@playwright/test";
import { chromium } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureNativeTree } from "./codex-incus-browser.js";

const executablePath = process.env.CODEX_INCUS_TEST_CHROMIUM ?? chromium.executablePath();
describe.skipIf(!existsSync(executablePath))(
  "tree screenshot viewport evidence (offline browser fixture)",
  () => {
    let browser: Browser;
    let directory: string;
    beforeAll(async () => {
      directory = mkdtempSync(path.join(os.tmpdir(), "codex-tree-capture-test-"));
      browser = await chromium.launch({ executablePath, headless: true });
    });
    afterAll(async () => {
      await browser?.close();
      if (directory) rmSync(directory, { recursive: true, force: true });
    });

    it("scrolls a tree above the conversation bottom into view and captures the tree pixels", async () => {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      try {
        await page.setContent(`<div id="scroll" style="height:400px;overflow:auto">
        <div data-testid="native-session-tree" data-root-thread-id="root" style="width:350px;height:180px;background:white">
          <div data-native-thread-id="root">Root session</div><div data-native-thread-id="child">Child session</div>
        </div><div style="height:2000px">Conversation bottom</div></div>`);
        await page.locator("#scroll").evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        const screenshot = path.join(directory, "visible-tree.png");
        const capture = await captureNativeTree(
          page,
          { rootThreadId: "root", childThreadIds: ["child"] },
          screenshot,
        );
        expect(capture.boundingBox.y).toBeGreaterThanOrEqual(0);
        expect(capture.boundingBox.y + capture.boundingBox.height).toBeLessThanOrEqual(600);
        const png = readFileSync(screenshot);
        expect(png.readUInt32BE(16)).toBe(350);
        expect(png.readUInt32BE(20)).toBe(180);
        expect(capture.sha256).toMatch(/^[a-f0-9]{64}$/);
        const pagePng = readFileSync(capture.pageScreenshot);
        expect(pagePng.readUInt32BE(16)).toBe(800);
        expect(pagePng.readUInt32BE(20)).toBe(600);
        expect(capture.pageSha256).toMatch(/^[a-f0-9]{64}$/);
      } finally {
        await page.close();
      }
    });

    it("refuses a tree that cannot fit rather than recording a clipped page as evidence", async () => {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      try {
        await page.setContent(`<div data-testid="native-session-tree" data-root-thread-id="root" style="height:1200px">
        <div data-native-thread-id="root">Root session</div><div data-native-thread-id="child">Child session</div></div>`);
        const screenshot = path.join(directory, "must-not-capture.png");
        await expect(
          captureNativeTree(page, { rootThreadId: "root", childThreadIds: ["child"] }, screenshot),
        ).rejects.toThrow("does not fit");
        expect(existsSync(screenshot)).toBe(false);
      } finally {
        await page.close();
      }
    });
  },
);
