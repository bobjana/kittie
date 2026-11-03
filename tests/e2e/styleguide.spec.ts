import { mkdirSync, writeFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const EVIDENCE_DIR = "/Users/dviljoen/Projects/kittie/.omo/evidence";
const LOG_PATH = `${EVIDENCE_DIR}/task-3-group-expense-splitter.log`;

type Violations = Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"];

type Report = {
  generatedAt: string;
  reducedMotion: Record<string, unknown>;
  axe: Record<string, unknown>;
  focusOrder: string[];
  undersized: string[];
  dialog: Record<string, unknown>;
};

const report: Report = {
  generatedAt: new Date().toISOString(),
  reducedMotion: {},
  axe: {},
  focusOrder: [],
  undersized: [],
  dialog: {},
};

test.describe.configure({ mode: "serial" });

test.afterAll(() => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(LOG_PATH, JSON.stringify(report, null, 2));
});

function blocking(violations: Violations): string[] {
  return violations
    .filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    )
    .map(
      (violation) =>
        `${violation.id} (${violation.impact}): ${violation.nodes
          .map((node) => node.target.join(" "))
          .join(", ")}`,
    );
}

function summarize(violations: Violations) {
  return violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.length,
  }));
}

async function settleAnimations(page: Page) {
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .filter((animation) => {
          const timing = animation.effect?.getComputedTiming();
          return timing ? timing.iterations !== Number.POSITIVE_INFINITY : true;
        })
        .every((animation) => animation.playState === "finished"),
    undefined,
    { timeout: 10_000 },
  );
}

async function openStyleguide(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  const response = await page.goto("/styleguide");
  expect(response?.status()).toBe(200);
  await expect(
    page.getByRole("heading", { level: 1, name: "Kittie styleguide" }),
  ).toBeVisible();
  await settleAnimations(page);
}

async function capture(page: Page, path: string) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await settleAnimations(page);
  await page.screenshot({ path });
}

test("styleguide has no serious axe violations at 390x844", async ({
  page,
}) => {
  await openStyleguide(page, 390, 844);

  const results = await new AxeBuilder({ page }).analyze();
  report.axe["width-390"] = summarize(results.violations);
  expect(blocking(results.violations)).toEqual([]);

  await capture(page, `${EVIDENCE_DIR}/task-3-group-expense-splitter-390.png`);
});

test("styleguide has no serious axe violations at 1280x900", async ({
  page,
}) => {
  await openStyleguide(page, 1280, 900);

  const results = await new AxeBuilder({ page }).analyze();
  report.axe["width-1280"] = summarize(results.violations);
  expect(blocking(results.violations)).toEqual([]);

  await capture(page, `${EVIDENCE_DIR}/task-3-group-expense-splitter-1280.png`);
});

test("every control is keyboard reachable with a 44px target", async ({
  page,
}) => {
  await openStyleguide(page, 390, 844);

  const focusOrder: string[] = [];
  for (let index = 0; index < 80; index += 1) {
    await page.keyboard.press("Tab");
    const descriptor = await page.evaluate(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) {
        return null;
      }
      const label =
        active instanceof HTMLInputElement ? active.labels?.[0] : undefined;
      const name =
        active.getAttribute("aria-label") ??
        label?.textContent?.trim().replace(/\s+/g, " ").slice(0, 32) ??
        active.getAttribute("placeholder") ??
        (active.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 32);
      const box = active.getBoundingClientRect();
      const labelBox = label?.getBoundingClientRect();
      const width = Math.max(box.width, labelBox?.width ?? 0);
      const height = Math.max(box.height, labelBox?.height ?? 0);
      return `${active.tagName.toLowerCase()}|${name}|${Math.round(width)}x${Math.round(height)}`;
    });
    if (descriptor === null) {
      break;
    }
    if (descriptor.startsWith("nextjs-portal|")) {
      continue;
    }
    if (descriptor === focusOrder[focusOrder.length - 1]) {
      break;
    }
    if (focusOrder.length > 0 && descriptor === focusOrder[0]) {
      break;
    }
    focusOrder.push(descriptor);
  }
  report.focusOrder = focusOrder;

  report.undersized = focusOrder.filter((entry) => {
    const size = entry.split("|")[2] ?? "";
    const [width, height] = size.split("x").map(Number);
    return Math.min(width, height) < 44;
  });

  expect(report.undersized).toEqual([]);
  expect(focusOrder.length).toBeGreaterThan(15);
  expect(focusOrder.some((entry) => entry.includes("Tally"))).toBe(true);
  expect(focusOrder.some((entry) => entry.includes("Add expense"))).toBe(true);
});

test("the dialog opens from the keyboard, closes on Escape and returns focus", async ({
  page,
}) => {
  await openStyleguide(page, 390, 844);

  const trigger = page.getByTestId("dialog-trigger");
  await trigger.focus();
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: "Delete this expense?" });
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("dialog-reason")).toBeFocused();
  await settleAnimations(page);

  const openResults = await new AxeBuilder({ page }).analyze();
  report.axe["dialog-open"] = summarize(openResults.violations);
  expect(blocking(openResults.violations)).toEqual([]);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  report.dialog = {
    opened: true,
    initialFocus: "dialog-reason",
    closedWithEscape: true,
    focusReturnedToTrigger: true,
  };
});

test("reduced motion switches the motion tokens off", async ({ page }) => {
  await openStyleguide(page, 390, 844);

  const readMotion = () =>
    page.evaluate(() => {
      const skeleton = document.querySelector(".animate-pulse");
      const button = document.querySelector("button");
      return {
        mediaMatches: window.matchMedia("(prefers-reduced-motion: reduce)")
          .matches,
        skeletonAnimationName: skeleton
          ? getComputedStyle(skeleton).animationName
          : null,
        buttonTransitionDuration: button
          ? getComputedStyle(button).transitionDuration
          : null,
      };
    });

  const normal = await readMotion();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await readMotion();
  report.reducedMotion = { normal, reduced };

  expect(normal.mediaMatches).toBe(false);
  expect(normal.skeletonAnimationName).toBe("pulse");
  expect(normal.buttonTransitionDuration).toBe("0.2s");

  expect(reduced.mediaMatches).toBe(true);
  expect(reduced.skeletonAnimationName).toBe("none");
  expect(reduced.buttonTransitionDuration).toBe("0s");
});
