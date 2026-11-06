import { readFileSync } from "node:fs";
import { chromium, type Page, type Response } from "@playwright/test";

const BASE = "http://localhost:3200";
const EVIDENCE = "/Users/dviljoen/Projects/kittie/.omo/evidence";

interface State {
  email: string;
  password: string;
  secondEmail: string;
  secondPassword: string;
  thirdEmail: string;
  thirdPassword: string;
  events: {
    lisbon: string;
    porto: string;
    dolomites: string;
    foreign: string;
    solo: string;
  };
  expected: {
    lisbonTotalMinor: number;
    lisbonTransfers: {
      fromMemberId: string;
      toMemberId: string;
      amountMinor: number;
    }[];
    portoTotalMinor: number;
  };
}

const state = JSON.parse(
  readFileSync("/tmp/task18-qa-state.json", "utf8"),
) as State;

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`,
  );
}

function eur(minor: number): string {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

async function assertText(
  page: Page,
  text: string,
  name: string,
): Promise<void> {
  try {
    await page
      .getByText(text, { exact: false })
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
    check(name, true, text);
  } catch {
    check(name, false, `not visible: ${text}`);
  }
}

async function fabBox(page: Page, selector: string, name: string) {
  const locator = page.locator(selector);
  const box = await locator.boundingBox();
  check(
    name,
    box !== null &&
      Math.abs(box.width - 64) < 0.5 &&
      Math.abs(box.height - 64) < 0.5,
    box ? `${box.width}x${box.height}` : "no box",
  );
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) =>
    consoleErrors.push(`pageerror: ${error.message}`),
  );

  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email", { exact: true }).fill(state.email);
  await page.getByLabel("Password", { exact: true }).fill(state.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/tally/, { timeout: 20_000 });
  check("sign-in lands on /tally", page.url().endsWith("/tally"), page.url());

  await page.waitForSelector("text=Lisbon 2026");
  const tallyHtml = await page.content();
  check(
    "tally renders the most recent open event first",
    tallyHtml.indexOf("Lisbon 2026") < tallyHtml.indexOf("Porto weekend"),
  );
  await assertText(
    page,
    eur(state.expected.lisbonTotalMinor),
    "Lisbon card total",
  );
  await assertText(
    page,
    eur(state.expected.portoTotalMinor),
    "Porto card total",
  );
  const noHScroll = await page.evaluate(() => {
    const el = document.scrollingElement;
    return el !== null && el.scrollWidth <= el.clientWidth;
  });
  check("tally has no horizontal scroll at 390px", noHScroll);
  await fabBox(page, 'button[aria-label="Add expense"]', "tally FAB is 64x64");
  await page.screenshot({
    path: `${EVIDENCE}/task-18-group-expense-splitter-tally-390.png`,
    fullPage: true,
  });

  const lisbonCard = page
    .locator("li")
    .filter({ hasText: "Lisbon 2026" })
    .first();
  await lisbonCard.getByRole("link", { name: "View report" }).click();
  await page.waitForURL(new RegExp(`/events/${state.events.lisbon}/report`));
  await assertText(
    page,
    eur(state.expected.lisbonTotalMinor),
    "report group total matches domain total",
  );
  await assertText(page, "you are owed", "viewer net direction");
  await assertText(page, eur(11666), "viewer net amount");
  for (const transfer of state.expected.lisbonTransfers) {
    await assertText(
      page,
      eur(transfer.amountMinor),
      "transfer amount rendered",
    );
  }
  const names = ["Ana", "Bruno", "Carla"];
  for (const name of names) {
    await assertText(page, name, `member row ${name}`);
  }
  const reportNoHScroll = await page.evaluate(() => {
    const el = document.scrollingElement;
    return el !== null && el.scrollWidth <= el.clientWidth;
  });
  check("report has no horizontal scroll at 390px", reportNoHScroll);
  await page.screenshot({
    path: `${EVIDENCE}/task-18-group-expense-splitter-report-390.png`,
    fullPage: true,
  });

  await fabBox(page, 'a[aria-label="Add expense"]', "report FAB is 64x64");
  await page.locator('a[aria-label="Add expense"]').click();
  await page.waitForURL(
    new RegExp(`/events/${state.events.lisbon}/expenses/new`),
  );
  const headingVisible = await page
    .getByRole("heading", { name: "Add expense" })
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  check("report FAB opens the new-expense page", headingVisible, page.url());

  await page.goto(`${BASE}/events/${state.events.lisbon}/report`);
  await page.getByLabel("Switch event").selectOption(state.events.porto);
  await page.waitForURL(new RegExp(`/events/${state.events.porto}/report`));
  await assertText(
    page,
    eur(state.expected.portoTotalMinor),
    "event switcher moves to the other report",
  );

  await page.goto(`${BASE}/tally`);
  await page.locator('button[aria-label="Add expense"]').click();
  const dialog = page.getByRole("dialog");
  check("tally FAB opens the event chooser", await dialog.isVisible());
  check(
    "chooser lists both open events",
    (await dialog.getByText("Lisbon 2026").isVisible()) &&
      (await dialog.getByText("Porto weekend").isVisible()),
  );
  await dialog.getByRole("link", { name: /Porto weekend/ }).click();
  await page.waitForURL(
    new RegExp(`/events/${state.events.porto}/expenses/new`),
  );
  check("chooser opens the chosen event's new-expense page", true, page.url());

  const foreignResponse: Response | null = await page.goto(
    `${BASE}/events/${state.events.foreign}/report`,
  );
  check(
    "another group's report returns 404",
    foreignResponse?.status() === 404,
    `status ${foreignResponse?.status()}`,
  );
  const foreignBody = await page.content();
  check(
    "404 page does not leak the foreign event name",
    !foreignBody.includes("Other group"),
  );

  const closedResponse = await page.goto(
    `${BASE}/events/${state.events.dolomites}/report`,
  );
  check(
    "closed report renders",
    closedResponse?.status() === 200,
    `status ${closedResponse?.status()}`,
  );
  await assertText(
    page,
    "Final tally - frozen on",
    "closed report shows frozen banner",
  );
  await assertText(page, eur(5000), "closed report shows the frozen total");
  const closedBody = await page.content();
  check(
    "closed report ignores post-close live rows",
    !closedBody.includes("777.77"),
  );

  const seriousConsole = consoleErrors.filter(
    (message) =>
      !message.includes("favicon") &&
      !message.includes("the server responded with a status of 404"),
  );
  check(
    "no unexpected browser console errors",
    seriousConsole.length === 0,
    seriousConsole.slice(0, 3).join(" | "),
  );

  const secondContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const secondPage = await secondContext.newPage();
  await secondPage.goto(`${BASE}/login`);
  await secondPage.getByLabel("Email", { exact: true }).fill(state.secondEmail);
  await secondPage
    .getByLabel("Password", { exact: true })
    .fill(state.secondPassword);
  await secondPage.getByRole("button", { name: "Sign in" }).click();
  await secondPage.waitForURL(
    new RegExp(`/events/${state.events.solo}/report`),
    {
      timeout: 20_000,
    },
  );
  check(
    "single open event redirects /tally to its report",
    secondPage.url().endsWith(`/events/${state.events.solo}/report`),
    secondPage.url(),
  );
  const tallyLoad = await secondPage.goto(`${BASE}/tally`);
  const redirectFrom = tallyLoad?.request().redirectedFrom();
  const redirectResponse = redirectFrom ? await redirectFrom.response() : null;
  check(
    "the tally redirect is a real HTTP 307",
    redirectResponse?.status() === 307,
    `origin ${redirectResponse?.status()}`,
  );
  check(
    "redirect lands on the report",
    secondPage.url().endsWith(`/events/${state.events.solo}/report`) &&
      (tallyLoad?.status() ?? 0) === 200,
    secondPage.url(),
  );
  await secondContext.close();

  const emptyContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const emptyPage = await emptyContext.newPage();
  await emptyPage.goto(`${BASE}/login`);
  await emptyPage.getByLabel("Email", { exact: true }).fill(state.thirdEmail);
  await emptyPage
    .getByLabel("Password", { exact: true })
    .fill(state.thirdPassword);
  await emptyPage.getByRole("button", { name: "Sign in" }).click();
  await emptyPage.waitForURL(/\/tally/, { timeout: 20_000 });
  await assertText(
    emptyPage,
    "No events yet",
    "no events shows the empty state",
  );
  await emptyPage.getByRole("link", { name: "Create an event" }).click();
  await emptyPage.waitForURL(/\/events\/new/);
  check(
    "empty state primary action creates the first event",
    emptyPage.url().endsWith("/events/new"),
    emptyPage.url(),
  );
  await emptyContext.close();

  await browser.close();

  const failed = checks.filter((item) => !item.ok);
  console.log(
    `SUMMARY ${checks.length - failed.length}/${checks.length} checks passed`,
  );
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

await main();
