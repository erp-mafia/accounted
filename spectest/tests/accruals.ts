/**
 * Periodisering: revenue invoiced now, earned over several months.
 *
 * A support contract billed in September for September through November is
 * not September's revenue. Booking all 30 000 kr in one month overstates that
 * month and understates the next two, which matters at a year boundary and
 * matters to anyone reading a monthly result.
 *
 * The invoice therefore books the revenue to 2970 Förutbetalda intäkter, a
 * balance-sheet account, and a schedule releases a third of it to 3001 each
 * month. The VAT is not deferred with it: moms is owed for the period the
 * invoice was issued in, whatever the revenue does afterwards, so 2611 takes
 * the whole 7 500 straight away.
 *
 *   1510 Kundfordringar        D 37 500
 *   2611 Utgående moms         K  7 500   not deferred
 *   2970 Förutbetalda intäkter K 30 000   released over three months
 */
import { expect } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";
import { sendInvoiceAndBookIt } from "./invoice";

const LINE = {
  description: "Supportavtal sep-nov",
  unitPrice: "30000",
  vat: "7500",
  total: "37500",
};
const PERIOD = { start: "2026-09-01", end: "2026-11-30", months: 3 };

export const invoiceALineOverThreeMonths = env.test(
  "an invoice line can be spread over three months",
  { dependsOn: sendInvoiceAndBookIt },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(`${APP_URL}/invoices`);
    await b.getByRole("button", { name: "Ny faktura", exact: true }).click();

    await b.getByRole("combobox").first().click();
    await b.getByRole("option", { name: /Nordic Design AB/ }).click();

    await b.locator('input[placeholder^="Skriv fritt"]').fill(LINE.description);
    await b.keyboard.press("Enter");
    await b.locator('input[name="items.0.unit_price"]').fill(LINE.unitPrice);
    await expect(b.getByText("Moms 25%")).toBeVisible();

    // Per line, from the row's own menu: one invoice can mix a deferred
    // support contract with an ordinary hour billed today.
    await b.getByRole("button", { name: "Radåtgärder" }).first().click();
    await b.getByRole("menuitem", { name: "Lägg till periodisering" }).click();

    // exact: the nav has a "Periodiseringar" link that a loose match catches.
    await expect(b.getByText("Periodisering", { exact: true })).toBeVisible();
    await b.locator('input[type="date"]:visible').nth(0).fill(PERIOD.start);
    await b.locator('input[type="date"]:visible').nth(1).fill(PERIOD.end);

    // The panel does the division rather than leaving the user to check it.
    await expect(
      b.getByText(new RegExp(`${PERIOD.months} månader`)),
      "the split is shown before it is committed",
    ).toBeVisible();

    await b.getByRole("button", { name: "Granska & skapa" }).click();
    await b.getByRole("button", { name: "Bekräfta & skapa" }).click();

    const item = await ctx.poll("the line carries the accrual", async () => {
      const rows = await ctx.svc.supabase.sql<{
        account: string;
        start: string;
        end: string;
      }>`
        select accrual_balance_account as account,
               accrual_period_start::text as start,
               accrual_period_end::text   as end
        from public.invoice_items
        where accrual_balance_account is not null`;
      return rows.unwrap().length === 1 ? rows : null;
    });
    // 2970 Förutbetalda intäkter: a liability, because the money is owed as
    // service rather than earned.
    expect(item[0]?.account).toBe("2970");
    expect(item[0]?.start).toBe(PERIOD.start);
    expect(item[0]?.end).toBe(PERIOD.end);

    return ctx.parent;
  },
);

export const theRevenueIsDeferredButTheVatIsNot = env.test(
  "booking defers the revenue and keeps the VAT in the issuing period",
  { dependsOn: invoiceALineOverThreeMonths },
  async (ctx) => {
    const b = await ctx.browser();

    await b.getByRole("button", { name: "Hoppa över" }).click().catch(() => {});
    await b.goto(`${APP_URL}/invoices`);
    await b.locator("tr").filter({ hasText: "002" }).first().click();
    await expect(b.getByText("Faktura 002")).toBeVisible({ timeout: 20000 });

    await b.getByRole("button", { name: "Fler alternativ" }).click();
    await b.getByRole("menuitem", { name: /^Markera som skickad/ }).click();
    await b
      .getByRole("dialog")
      .getByRole("button", { name: /^Markera som skickad/ })
      .click();

    const lines = await ctx.poll("the invoice is booked", async () => {
      const rows = await ctx.svc.supabase.sql<{
        account_number: string;
        debit: string;
        credit: string;
      }>`
        select jel.account_number,
               trim_scale(jel.debit_amount)::text  as debit,
               trim_scale(jel.credit_amount)::text as credit
        from public.journal_entries je
        join public.journal_entry_lines jel on jel.journal_entry_id = je.id
        where je.voucher_number = 2
        order by jel.account_number`;
      return rows.unwrap().length === 3 ? rows : null;
    });

    expect(lines[0]?.account_number).toBe("1510");
    expect(lines[0]?.debit).toBe(LINE.total);

    // The VAT is not deferred. Moms belongs to the period the invoice was
    // issued in; deferring it with the revenue would understate the
    // momsdeklaration for a quarter and overstate a later one.
    expect(lines[1]?.account_number, "output VAT, in full, now").toBe("2611");
    expect(lines[1]?.credit).toBe(LINE.vat);

    // And the revenue is parked on the balance sheet rather than recognised.
    // 3001 here would be the whole point missed.
    expect(
      lines[2]?.account_number,
      "revenue is deferred to a balance account, not recognised",
    ).toBe("2970");
    expect(lines[2]?.credit).toBe(LINE.unitPrice);

    const revenue = await ctx.svc.supabase.sql<{ n: number }>`
      select count(*)::int as n from public.journal_entry_lines
      where account_number = '3001'
        and journal_entry_id in (
          select id from public.journal_entries where voucher_number = 2)`;
    expect(revenue[0]?.n, "nothing was recognised as revenue yet").toBe(0);

    return ctx.parent;
  },
);

export const theScheduleReleasesItInThreeEqualMonths = env.test(
  "a schedule releases the revenue in three equal monthly steps",
  { dependsOn: theRevenueIsDeferredButTheVatIsNot },
  async (ctx) => {
    const schedule = await ctx.poll("the schedule exists", async () => {
      const rows = await ctx.svc.supabase.sql<{
        n: number;
        total: string;
      }>`
        select count(*)::int as n,
               trim_scale(sum(amount))::text as total
        from public.accrual_schedule_installments`;
      return rows.unwrap()[0]?.n === PERIOD.months ? rows : null;
    });

    // Three months, and between them the whole deferred amount. A schedule
    // that released less would leave revenue stranded on 2970 forever; one
    // that released more would invent it.
    expect(schedule[0]?.n).toBe(PERIOD.months);
    expect(schedule[0]?.total, "the instalments account for the whole amount").toBe(
      LINE.unitPrice,
    );

    const rows = await ctx.svc.supabase.sql<{
      amount: string;
      month: string;
      status: string;
      posted: boolean;
    }>`
      select trim_scale(amount)::text as amount,
             to_char(period_month, 'YYYY-MM') as month,
             status,
             journal_entry_id is not null as posted
      from public.accrual_schedule_installments
      order by period_month`;

    // Equal thirds, one per calendar month of the period.
    expect(rows[0]?.amount).toBe("10000");
    expect(rows[0]?.month).toBe("2026-09");
    expect(rows[1]?.month).toBe("2026-10");
    expect(rows[2]?.month).toBe("2026-11");

    // And none of them is booked yet: a schedule is a plan, and the releases
    // happen when their months arrive.
    expect(
      rows[0]?.posted,
      "the plan exists without having booked anything in advance",
    ).toBe(false);
    expect(rows[0]?.status).toBe("pending");

    return ctx.parent;
  },
);
