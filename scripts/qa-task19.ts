import { readFileSync } from "node:fs";
import { chromium, type Page } from "@playwright/test";
import postgres from "postgres";

const BASE = "http://localhost:3200";
const DB = "postgres://kittie:kittie@localhost:5433/kittie_r19_qa";
const EVIDENCE = "/Users/dviljoen/Projects/kittie/.omo/evidence";

interface State {
  email: string;
  password: string;
  friendEmail: string;
  friendPassword: string;
  eventId: string;
  expenseId: string;
}

const state = JSON.parse(
  readFileSync("/tmp/task19-qa-state.json", "utf8"),
) as State;

const sql = postgres(DB, { max: 1 });
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

async function signIn(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/tally/, { timeout: 20_000 });
}

async function postJson(
  page: Page,
  path: string,
  body?: unknown,
): Promise<{ status: number; error?: string }> {
  return page.evaluate(
    async ({ path, body }) => {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      return { status: response.status, error: data.error };
    },
    { path, body },
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
  const expectedNoise =
    /Failed to load resource: the server responded with a status of 409|encountered uncached data during prerendering/;
  page.on("console", (message) => {
    if (message.type() === "error" && !expectedNoise.test(message.text())) {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) =>
    consoleErrors.push(`pageerror: ${error.message}`),
  );

  const reportUrl = `${BASE}/events/${state.eventId}/report`;

  // --- organizer closes the event ---
  await signIn(page, state.email, state.password);
  await page.goto(reportUrl);
  await page.getByTestId("close-event-button").waitFor({ timeout: 15_000 });
  check("organizer sees the close control", true);

  await page.getByTestId("close-event-button").click();
  await page.getByRole("dialog").waitFor({ timeout: 10_000 });
  check(
    "close dialog explains the freeze and email",
    (await page.getByRole("dialog").textContent())?.includes("frozen") ?? false,
  );
  await page.getByTestId("confirm-close-event").click();
  await assertText(
    page,
    "Final tally - frozen on",
    "report shows the frozen banner",
  );
  await page.getByText("Closed", { exact: true }).waitFor({ timeout: 10_000 });
  check("status badge flips to Closed", true);
  await assertText(page, eur(30000), "frozen group total is €300.00");
  await assertText(page, eur(15000), "frozen transfer is €150.00");

  await page.screenshot({
    path: `${EVIDENCE}/task-19-group-expense-splitter-close-390.png`,
    fullPage: true,
  });

  const jobsAfterClose = await sql<Array<{ status: string; count: string }>>`
    select status, count(*)::text as count from notification_jobs
    where event_id = ${state.eventId} group by status order by status
  `;
  check(
    "close queues one tally job per member with an email",
    jobsAfterClose.length === 1 &&
      jobsAfterClose[0].status === "queued" &&
      jobsAfterClose[0].count === "3",
    JSON.stringify(jobsAfterClose),
  );

  const doubleClose = await postJson(
    page,
    `/api/events/${state.eventId}/close`,
  );
  check(
    "double close returns 409 EVENT_CLOSED",
    doubleClose.status === 409 && doubleClose.error === "EVENT_CLOSED",
    JSON.stringify(doubleClose),
  );

  const closedExpense = await postJson(
    page,
    `/api/events/${state.eventId}/expenses`,
    {
      totalMinor: 100,
      paidByMemberId: null,
      splitMode: "equal",
      participants: [],
    },
  );
  check(
    "new expense on a closed event returns 409 EVENT_CLOSED",
    closedExpense.status === 409 && closedExpense.error === "EVENT_CLOSED",
    JSON.stringify(closedExpense),
  );

  const closedEdit = await page.goto(
    `${BASE}/events/${state.eventId}/expenses/${state.expenseId}/edit`,
  );
  check(
    "closed event redirects away from the expense editor",
    !page.url().endsWith("/edit"),
    `${closedEdit?.status()} ${page.url()}`,
  );

  // --- reopen ---
  await page.goto(reportUrl);
  await page.getByTestId("reopen-event-button").waitFor({ timeout: 15_000 });
  await page.getByTestId("reopen-event-button").click();
  await page.getByRole("dialog").waitFor({ timeout: 10_000 });
  const confirmReopen = page.getByTestId("confirm-reopen-event");
  check(
    "reopen confirm is disabled until explicitly confirmed",
    await confirmReopen.isDisabled(),
  );
  await page.getByLabel("I understand this unfreezes the tally").check();
  await confirmReopen.click();
  await page.getByText("Open", { exact: true }).waitFor({ timeout: 10_000 });
  check("reopen restores the Open badge", true);
  check(
    "frozen banner is gone after reopen",
    (await page.getByText("Final tally - frozen on").count()) === 0,
  );

  const settlementRows = await sql<
    Array<{ version: number; superseded: boolean }>
  >`
    select version, superseded_at is not null as superseded
    from event_settlements where event_id = ${state.eventId}
  `;
  check(
    "reopen supersedes the settlement instead of deleting it",
    settlementRows.length === 1 && settlementRows[0].superseded,
    JSON.stringify(settlementRows),
  );
  const jobsAfterReopen = await sql<Array<{ status: string; count: string }>>`
    select status, count(*)::text as count from notification_jobs
    where event_id = ${state.eventId} group by status order by status
  `;
  check(
    "reopen cancels the queued tally jobs",
    jobsAfterReopen.length === 1 && jobsAfterReopen[0].status === "cancelled",
    JSON.stringify(jobsAfterReopen),
  );

  // --- member close is forbidden while open ---
  const memberContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  const memberPage = await memberContext.newPage();
  await signIn(memberPage, state.friendEmail, state.friendPassword);
  await memberPage.goto(reportUrl);
  await memberPage.getByText("Who pays whom").waitFor({ timeout: 15_000 });
  check(
    "member does not get the close control",
    (await memberPage.getByTestId("close-event-button").count()) === 0,
  );
  const memberClose = await postJson(
    memberPage,
    `/api/events/${state.eventId}/close`,
  );
  check(
    "member close returns 403 NOT_ORGANIZER",
    memberClose.status === 403 && memberClose.error === "NOT_ORGANIZER",
    JSON.stringify(memberClose),
  );

  // --- edit an expense, then close again ---
  await page.goto(
    `${BASE}/events/${state.eventId}/expenses/${state.expenseId}/edit`,
  );
  await page.getByLabel("Amount", { exact: true }).fill("350");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForURL(
    new RegExp(`/events/${state.eventId}/expenses/${state.expenseId}$`),
    { timeout: 15_000 },
  );
  check("reopened event accepts an expense edit", true, page.url());

  await page.goto(reportUrl);
  await assertText(page, eur(35000), "live report reflects the edit (€350.00)");
  await page.getByTestId("close-event-button").click();
  await page.getByTestId("confirm-close-event").click();
  await assertText(
    page,
    "Final tally - frozen on",
    "second close freezes the tally",
  );
  await assertText(page, eur(35000), "second frozen total is €350.00");
  await assertText(page, eur(17500), "second frozen transfer is €175.00");

  await memberPage.goto(reportUrl);
  await assertText(
    memberPage,
    eur(35000),
    "member sees the second frozen total",
  );

  const noHScroll = await page.evaluate(() => {
    const el = document.scrollingElement;
    return el ? el.scrollWidth <= el.clientWidth + 1 : false;
  });
  check("no horizontal scroll at 390px", noHScroll);

  check(
    "no console errors",
    consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(" | "),
  );

  await context.close();
  await memberContext.close();
  await browser.close();
  await sql.end();

  const failed = checks.filter((entry) => !entry.ok);
  console.log(
    `\n${failed.length === 0 ? "ALL CHECKS PASSED" : `${failed.length} CHECK(S) FAILED`} (${checks.length} total)`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

await main();
