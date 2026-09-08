/**
 * What comes after the books close: the income tax return and the annual
 * report.
 *
 * Both read the migrated year, where the result is 8 000 kr (20 000 revenue
 * less 12 000 cost). Neither is filed here. Filing needs Skatteverket and
 * Bolagsverket, and this environment has fakes for neither, which is exactly
 * why the second test is about the app refusing rather than pretending.
 */
import { expect } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";
import { importSieFile } from "./sie-import";

export const ink2ReportsTheYearsResult = env.test(
  "INK2 carries the year's result into the right box",
  { dependsOn: importSieFile },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(`${APP_URL}/reports/ink2-declaration`);
    await expect(b.getByText("INK2S: SKATTEMÄSSIGA JUSTERINGAR")).toBeVisible({
      timeout: 25000,
    });

    await b.getByRole("button", { name: "Räkenskapsår" }).click();
    await b.getByRole("option", { name: "Räkenskapsår 2025" }).click();

    // 4.1 is profit and 4.2 is loss. Putting 8 000 in the wrong one turns a
    // taxable surplus into a deficit carried forward, which is a difference
    // Skatteverket notices and the ledger does not.
    await expect(b.getByText(/4\.1\s*Årets resultat \(vinst\)/)).toBeVisible({
      timeout: 20000,
    });
    await expect(b.getByText(/Överskott \(punkt 1\.1\)/)).toBeVisible();
    // The amount, tolerating whatever space Swedish formatting uses.
    await expect(b.getByText(/8\s?000 kr/).first()).toBeVisible();

    // Derived from the ledger, not entered by anyone.
    const result = await ctx.svc.supabase.sql<{ net: string }>`
      select (sum(credit_amount) - sum(debit_amount))::text as net
      from public.journal_entry_lines
      where account_number like '3%' or account_number like '5%'`;
    expect(result[0]?.net).toBe("8000");

    return ctx.parent;
  },
);

export const annualReportRefusesUntilAnswered = env.test(
  "the annual report will not be produced until the questions are answered",
  { dependsOn: importSieFile },
  async (ctx) => {
    const b = await ctx.browser();

    const period = await ctx.svc.supabase.sql<{ id: string }>`
      select id::text as id from public.fiscal_periods
      where period_end = '2025-12-31'`;
    await b.goto(
      `${APP_URL}/bookkeeping/year-end/arsredovisning?period=${period[0]!.id.unwrap()}`,
    );

    await expect(b.getByText("Årsredovisning Räkenskapsår 2025")).toBeVisible({
      timeout: 30000,
    });

    // The scope questions come first, because their answers decide whether K2
    // may be used at all and therefore what the rest of the document looks
    // like. Each renders in two places, hence .first().
    await expect(
      b.getByText("Är bolaget ett publikt aktiebolag?").first(),
    ).toBeVisible({ timeout: 25000 });
    await expect(b.getByText("Är bolaget i likvidation?").first()).toBeVisible();
    await expect(
      b.getByText("Krävs revisionsberättelse för året?").first(),
    ).toBeVisible();

    // Unanswered questions are counted as blockers rather than defaulted. An
    // årsredovisning filed on guessed answers is worse than one not filed.
    await expect(
      b.getByText(/blockerande fel/).first(),
      "the unanswered scope questions block the document rather than defaulting",
    ).toBeVisible();

    // And the filing route is honest about not existing yet, with what it
    // would take, rather than offering a button that fails.
    await expect(b.getByText(/Bolagsverket-integrationen är inte aktiverad/)).toBeVisible();
    await expect(b.getByText(/organisationscertifikat och godkänt acceptanstest/)).toBeVisible();

    return ctx.parent;
  },
);
