/**
 * The reports a customer and their accountant actually open.
 *
 * All three read the books the SIE migration brought in, so the expected
 * figures are derivable from the fixture rather than sampled:
 *
 *   3001 Försäljning   20 000 revenue
 *   5010 Lokalhyra     12 000 cost
 *   result              8 000, and it has not been transferred to equity
 *
 * That last part is the point of the first test. The fixture is a mid-year
 * export with no closing entries, which is what a real migration looks like,
 * and the balance sheet is expected to notice.
 *
 * Amounts are asserted against the ledger rather than the screen throughout:
 * Swedish thousands separators are non-breaking spaces, so a literal like
 * "8 000,00 kr" matches nothing while looking correct in the diff.
 */
import { expect } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";
import { importSieFile } from "./sie-import";

export const balanceSheetExplainsTheImbalance = env.test(
  "the balance sheet names why it does not balance",
  { dependsOn: importSieFile },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(`${APP_URL}/reports`);
    await b.locator("tr").filter({ hasText: "Balansräkning" }).first().click();

    await expect(b.getByText("Summa tillgångar")).toBeVisible({ timeout: 25000 });
    await expect(b.getByText("Kundfordringar").first()).toBeVisible();
    await expect(b.getByText("Leverantörsskulder").first()).toBeVisible();

    // It does not balance, and it says so plainly rather than presenting a
    // total that happens to be wrong.
    await expect(b.getByText("Balanserar ej")).toBeVisible();

    // And then it explains the cause and the entry that fixes it. This is the
    // difference between a report that is broken and a report that is
    // diagnosing an incomplete migration: the year's result was never
    // transferred to equity, because the file was exported mid-year with no
    // closing entries.
    await expect(
      b.getByText(/aldrig har förts om till eget kapital/),
      "the balance sheet explains the untransferred result rather than just failing",
    ).toBeVisible();
    await expect(b.getByText(/konto 8999 mot eget kapital/)).toBeVisible();
    await expect(b.getByText(/Räkenskapsår 2025/).first()).toBeVisible();

    // The difference it quotes is the year's result, derived from the ledger.
    const result = await ctx.svc.supabase.sql<{ net: string }>`
      select (sum(credit_amount) - sum(debit_amount))::text as net
      from public.journal_entry_lines
      where account_number like '3%' or account_number like '5%'`;
    expect(result[0]?.net, "revenue less costs is the 8 000 the report quotes").toBe(
      "8000",
    );

    return ctx.parent;
  },
);

export const incomeStatementForTheImportedYear = env.test(
  "the income statement reports the migrated year",
  { dependsOn: importSieFile },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(`${APP_URL}/reports/income-statement`);

    // It opens on the current year, where there is nothing: result accounts
    // reset at the turn of the year, so an empty 2026 is correct, not a bug.
    await expect(b.getByText("Rörelseresultat")).toBeVisible({ timeout: 25000 });
    await expect(b.getByText("Inga poster.").first()).toBeVisible();

    await b.getByRole("button", { name: "Räkenskapsår" }).click();
    await b.getByRole("option", { name: "Räkenskapsår 2025" }).click();

    // The migrated year, account by account.
    await expect(b.getByText("Försäljning inom Sverige 25% moms")).toBeVisible({
      timeout: 20000,
    });
    await expect(b.getByText("Lokalhyra")).toBeVisible();
    await expect(b.getByText("Summa rörelseintäkter")).toBeVisible();
    await expect(b.getByText("Summa rörelsekostnader")).toBeVisible();
    await expect(b.getByText("Årets resultat")).toBeVisible();

    // The figures behind it. Revenue is a credit balance and cost a debit, so
    // a sign error either way would show up here as a wrong sign, not just a
    // wrong number.
    const lines = await ctx.svc.supabase.sql<{
      account_number: string;
      net: string;
    }>`
      select account_number, (sum(debit_amount) - sum(credit_amount))::text as net
      from public.journal_entry_lines
      where account_number in ('3001', '5010')
      group by account_number order by account_number`;
    expect(lines[0]?.account_number).toBe("3001");
    expect(lines[0]?.net).toBe("-20000");
    expect(lines[1]?.account_number).toBe("5010");
    expect(lines[1]?.net).toBe("12000");

    return ctx.parent;
  },
);

export const processingHistoryRecordsWhoDidWhat = env.test(
  "behandlingshistoriken records who did what and when",
  { dependsOn: importSieFile },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(`${APP_URL}/reports/behandlingshistorik`);

    // Select the years explicitly rather than trusting whichever one the page
    // opens with: with two fiscal years present the default is not something
    // this test should depend on.
    await expect(b.getByRole("button", { name: "Räkenskapsår" })).toBeVisible({
      timeout: 25000,
    });
    await b.getByRole("button", { name: "Räkenskapsår" }).click();
    await b.getByRole("option", { name: "Räkenskapsår 2025" }).click();

    // 2025 is empty, and that is the right answer rather than a gap: the
    // history is keyed on when something was processed, not on what date the
    // verifikat carries. The migration happened today, in 2026.
    await expect(b.getByText("Inga händelser i perioden")).toBeVisible({
      timeout: 20000,
    });

    await b.getByRole("button", { name: "Räkenskapsår" }).click();
    await b.getByRole("option", { name: "Räkenskapsår 2026" }).click();

    // BFL 5 kap. 11 § wants the processing history of the bookkeeping system:
    // what was done, when, and by whom. Each of these is a real event from the
    // onboarding and migration this suite just performed.
    await expect(b.getByText("Företagsinställningar skapade")).toBeVisible({
      timeout: 20000,
    });
    // .first(): both fiscal years were created during this run, so the event
    // appears twice and a bare match is a strict-mode violation.
    await expect(b.getByText("Räkenskapsår skapat").first()).toBeVisible();
    await expect(b.getByText("Konto ändrat").first()).toBeVisible();

    // Attributed to a person, not to "systemet". An audit trail without an
    // actor answers half the question the law asks.
    await expect(b.getByText("flow@example.test").first()).toBeVisible();

    // Eleven events from onboarding and the migration, grouped by what they
    // touched. The counts are the report's own summary of the run this suite
    // just performed.
    await expect(b.getByText(/11 händelser/)).toBeVisible();

    // And the changes are recorded as before-and-after, not just as "changed".
    await expect(b.getByText(/→ standard_25/).first()).toBeVisible();

    return ctx.parent;
  },
);
