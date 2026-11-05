/**
 * Row 17 browser QA: mounts the receipt capture in the new-expense flow and
 * exercises the OCR review, the dirty-field rule, the save-while-reading path
 * and the capturer's "Apply receipt values" action on the detail page.
 *
 * Standalone on purpose: it drives its own Chromium against a server the
 * operator started (port 3200 with OCR_PROVIDER=fake, 3201 with
 * OCR_PROVIDER=fail) and never touches the preview on 3100.
 *
 *   QA_BASE_URL=http://localhost:3200 QA_MODE=fake bun run scripts/task-17-qa.ts
 *   QA_BASE_URL=http://localhost:3201 QA_MODE=fail bun run scripts/task-17-qa.ts
 */
import { appendFileSync, readFileSync } from "node:fs";
import { chromium, type Page } from "playwright";

const BASE = process.env.QA_BASE_URL ?? "http://localhost:3200";
const MODE = (process.env.QA_MODE ?? "fake") as "fake" | "fail";
const EVIDENCE_DIR = "/Users/dviljoen/Projects/kittie/.omo/evidence";
const WORKTREE =
  "/Users/dviljoen/Projects/kittie-wt/group-expense-splitter-wave3";
const FIXTURE = `${WORKTREE}/tests/fixtures/receipt.jpg`;
const EMAIL = "demo@kittie.zynafin.cc";
const PASSWORD = "Kittie-demo-2026";

const lines: string[] = [];
const failures: string[] = [];

function say(message: string): void {
  lines.push(message);
  console.log(message);
}

function check(name: string, condition: boolean, detail = ""): void {
  if (!condition) {
    failures.push(name);
  }
  say(
    `${condition ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`,
  );
}

function magicIsJpeg(path: string): boolean {
  const buffer = new Uint8Array(readFileSync(path));
  return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

async function inputValue(page: Page, label: string): Promise<string> {
  return page.getByLabel(label, { exact: true }).inputValue();
}

async function signIn(page: Page): Promise<void> {
  const response = await page
    .context()
    .request.post(`${BASE}/api/auth/sign-in/email`, {
      data: { email: EMAIL, password: PASSWORD },
    });
  if (!response.ok()) {
    throw new Error(`sign-in failed: ${response.status()}`);
  }
  await page.goto(`${BASE}/events`);
  await page.waitForURL(/\/events/, { timeout: 30_000 });
}

/**
 * Next's dev server hydrates after the HTML lands, so a click or a file change
 * dispatched too early is handled natively (a full form submit) instead of by
 * React. Wait for React's own key on the element before interacting with it.
 */
async function waitForHydration(page: Page, selector: string): Promise<void> {
  await page.waitForFunction(
    (sel) => {
      const element = document.querySelector(sel);
      if (!element) {
        return false;
      }
      return Object.keys(element).some(
        (key) =>
          key.startsWith("__reactFiber$") || key.startsWith("__reactProps$"),
      );
    },
    selector,
    { timeout: 30_000 },
  );
}

async function gotoHydrated(
  page: Page,
  url: string,
  selector: string,
): Promise<void> {
  await page.goto(url);
  await page.locator(selector).first().waitFor({ state: "attached" });
  await waitForHydration(page, selector);
}

async function createEvent(page: Page, name: string): Promise<string> {
  const response = await page.context().request.post(`${BASE}/api/events`, {
    data: { name, currency: "EUR" },
  });
  if (!response.ok()) {
    throw new Error(`event creation failed: ${response.status()}`);
  }
  const body = (await response.json()) as { event?: { id?: string } };
  const id = body.event?.id;
  if (!id) {
    throw new Error("event creation returned no id");
  }
  return id;
}

async function uploadReceipt(page: Page): Promise<void> {
  await waitForHydration(page, 'input[type="file"]');
  await page.locator('input[type="file"]').setInputFiles(FIXTURE);
}

async function observable(page: Page, text: string | RegExp, timeout: number) {
  const locator = page.getByText(text).first();
  await locator.waitFor({ state: "visible", timeout });
  return locator;
}

async function runFakeFlow(page: Page, eventId: string): Promise<void> {
  // ---- Scenario A: upload -> review banner -> prefilled amount/date/merchant
  await gotoHydrated(
    page,
    `${BASE}/events/${eventId}/expenses/new`,
    'input[type="file"]',
  );
  check(
    "A: capture is mounted inside the new-expense form",
    (await page.getByRole("button", { name: "Add receipt photo" }).count()) ===
      1,
  );

  await uploadReceipt(page);
  await observable(page, "Reading the receipt", 30_000);
  check("A: non-blocking chip shows the reading state", true);

  await observable(page, "Check the receipt values", 30_000);
  check("A: review banner appears after success", true);
  check(
    "A: amount is prefilled from the receipt",
    (await inputValue(page, "Amount")) === "12.50",
    await inputValue(page, "Amount"),
  );
  check(
    "A: date is prefilled from the receipt",
    (await inputValue(page, "Date")) === "2026-11-04",
    await inputValue(page, "Date"),
  );
  check(
    "A: merchant is prefilled into the description",
    (await inputValue(page, "Description")).startsWith("Fixture Merchant"),
    await inputValue(page, "Description"),
  );
  await observable(page, "Receipt read.", 15_000);
  check("A: chip reaches the done state", true);

  await page.screenshot({
    path: `${EVIDENCE_DIR}/task-17-group-expense-splitter-receipt-390.png`,
    fullPage: true,
  });
  await page.screenshot({
    path: `${EVIDENCE_DIR}/task-17-group-expense-splitter-ocr-review-390.png`,
    fullPage: true,
  });

  // ---- Poll must stop after the terminal status
  const before = jobRequestCount;
  const sawAnother = await page
    .waitForRequest((request) => /\/api\/ocr-jobs\//.test(request.url()), {
      timeout: 4000,
    })
    .then(() => true)
    .catch(() => false);
  check(
    "A: no further poll requests after the terminal status",
    sawAnother === false && jobRequestCount === before,
    `requests=${jobRequestCount}`,
  );

  // ---- Scenario B: a typed amount survives the OCR result
  await gotoHydrated(
    page,
    `${BASE}/events/${eventId}/expenses/new`,
    'input[type="file"]',
  );
  await uploadReceipt(page);
  await observable(page, "Reading the receipt", 30_000);
  await page.getByLabel("Amount", { exact: true }).fill("42.00");
  const stillReading =
    (await page.getByText("Reading the receipt").count()) > 0;
  check(
    "B: saving is never blocked while OCR runs",
    stillReading &&
      (await page.getByRole("button", { name: "Save expense" }).isEnabled()),
    `chip was reading: ${stillReading}`,
  );
  await observable(page, "Check the receipt values", 30_000);
  check(
    "B: a typed amount is preserved, not overwritten",
    (await inputValue(page, "Amount")) === "42.00",
    await inputValue(page, "Amount"),
  );
  check(
    "B: untouched fields still get the receipt values",
    (await inputValue(page, "Date")) === "2026-11-04",
    await inputValue(page, "Date"),
  );

  // ---- Scenario C: saved while OCR was still reading, applied from the detail
  await gotoHydrated(
    page,
    `${BASE}/events/${eventId}/expenses/new`,
    'input[type="file"]',
  );
  await uploadReceipt(page);
  await observable(page, "Reading the receipt", 30_000);
  await page.getByLabel("Amount", { exact: true }).fill("99.00");
  await page.getByLabel("Description", { exact: true }).fill("Manual entry");
  const readingAtSave =
    (await page.getByText("Reading the receipt").count()) > 0;
  await page.getByRole("button", { name: "Save expense" }).click();
  await page.waitForURL(new RegExp(`/events/${eventId}$`), { timeout: 30_000 });
  check(
    "C: the expense saves before the client saw the OCR result",
    readingAtSave,
    `chip was reading at save time: ${readingAtSave}`,
  );
  await page
    .getByRole("link", { name: /Manual entry/ })
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await waitForHydration(page, 'a[href*="/expenses/"]');
  check(
    "C: nothing is auto-applied - the typed amount is what got saved",
    (await page.getByText("€99.00").count()) > 0,
  );
  await page
    .getByRole("link", { name: /Manual entry/ })
    .first()
    .click();
  await page.waitForURL(/\/expenses\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  await waitForHydration(page, "form");
  await page
    .getByRole("button", { name: "Apply receipt values" })
    .waitFor({ state: "visible", timeout: 30_000 });
  check("C: the receipt result is offered on the expense detail", true);
  await page.getByRole("button", { name: "Apply receipt values" }).click();
  await observable(page, "These values are already on the expense.", 30_000);
  await page.goto(page.url());
  await page
    .getByText("Fixture Merchant")
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  check("C: applying the receipt values updates the expense", true);
}

async function runFailFlow(page: Page, eventId: string): Promise<void> {
  await gotoHydrated(
    page,
    `${BASE}/events/${eventId}/expenses/new`,
    'input[type="file"]',
  );
  await uploadReceipt(page);
  await observable(page, "Couldn't read it - enter manually", 120_000);
  check("D: a failed job shows the manual fallback", true);
  check(
    "D: no review banner is shown for a failed job",
    (await page.getByText("Check the receipt values").count()) === 0,
  );
  check(
    "D: the amount stays empty after a failure",
    (await inputValue(page, "Amount")) === "",
  );

  await page.getByLabel("Amount", { exact: true }).fill("55.00");
  await page.getByLabel("Description", { exact: true }).fill("Fail fallback");
  await page.getByRole("button", { name: "Save expense" }).click();
  await page.waitForURL(new RegExp(`/events/${eventId}$`), { timeout: 30_000 });
  check("D: the manual path still saves the expense", true);
  await page
    .getByRole("link", { name: /Fail fallback/ })
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  check("D: the saved expense is listed on the event", true);
}

let jobRequestCount = 0;

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  page.on("request", (request) => {
    if (/\/api\/ocr-jobs\//.test(request.url())) {
      jobRequestCount += 1;
    }
  });

  try {
    check("fixture is a real JPEG", magicIsJpeg(FIXTURE));
    await signIn(page);
    check("signed in as the demo user", true);
    const eventId = await createEvent(page, `OCR QA row17 ${Date.now()}`);
    check(`created a QA event (${eventId})`, true);

    if (MODE === "fake") {
      await runFakeFlow(page, eventId);
    } else {
      await runFailFlow(page, eventId);
    }
  } catch (error) {
    failures.push("unhandled exception");
    say(`FAIL  unhandled exception: ${String(error)}`);
  } finally {
    await browser.close();
  }

  say(`failures: ${failures.length}`);
  if (failures.length > 0) {
    say(`failed checks: ${failures.join(" | ")}`);
  }
  appendFileSync(
    `${EVIDENCE_DIR}/task-17-group-expense-splitter.log`,
    `\n--- playwright QA (mode=${MODE}, base=${BASE}) ---\n${lines.join("\n")}\n`,
  );
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

await main();
