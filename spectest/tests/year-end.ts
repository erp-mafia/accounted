/**
 * Bokslut readiness, on migrated books.
 *
 * Closing a year is the point of no return: past it, BFL leaves storno as the
 * only correction path. So the interesting question is not whether the app can
 * close a year, but whether it refuses to let you close one blind.
 *
 * The company here migrated in via SIE, and that combination surfaces a real
 * trap. SIE carries the ledger but not the subledgers: no customers, no
 * suppliers, no open invoices. The balances on 1510 and 2440 therefore arrive
 * with nothing behind them, and a bokslut signed off in that state states
 * receivables and payables the books cannot substantiate.
 */
import { expect } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";
import { importSieFile } from "./sie-import";

/**
 * Straight out of the fixture, which is why they can be asserted exactly.
 *
 *   1510  IB 62 500, +25 000 invoiced, -25 000 paid  ->  62 500 unbacked
 *   2440  IB 45 000, +15 000 supplier invoice        ->  60 000 unbacked
 */
const UNBACKED = {
  receivables: "-62500.00",
  payables: "-60000.00",
};

export const yearEndOffersTheEndedYear = env.test(
  "bokslut offers the year that has ended, not the one in progress",
  { dependsOn: importSieFile },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(`${APP_URL}/bookkeeping/year-end`);

    // The company has two fiscal years after the migration: 2025 from the
    // file and 2026 from onboarding. Only the ended one can be closed, and
    // the balansdagen names it.
    await expect(b.getByText(/balansdagen 2025-12-31/)).toBeVisible({ timeout: 25000 });

    const periods = await ctx.svc.supabase.sql<{
      name: string;
      period_end: string;
      is_closed: boolean;
    }>`
      select name, period_end::text as period_end, is_closed
      from public.fiscal_periods order by period_start`;

    expect(periods).toHaveLength(2);
    expect(periods[0]?.period_end).toBe("2025-12-31");
    expect(periods[1]?.period_end).toBe("2026-12-31");
    // Nothing closed yet. Readiness is a view, not an action.
    expect(periods[0]?.is_closed).toBe(false);
    expect(periods[1]?.is_closed).toBe(false);

    return ctx.parent;
  },
);

export const readinessCatchesTheMigrationGap = env.test(
  "bokslut readiness catches what the SIE file could not bring across",
  { dependsOn: yearEndOffersTheEndedYear },
  async (ctx) => {
    const b = await ctx.browser();

    // The two that matter. A SIE file carries the ledger and not the
    // reskontror, so a migrated company starts with balances on 1510 and 2440
    // that no open invoice explains. Closing the year on those numbers states
    // receivables and payables nobody can substantiate, and the reminder is
    // what stops that happening silently.
    await expect(
      b.getByText(
        `Kundreskontran stämmer inte mot konto 1510: differens ${UNBACKED.receivables} kr. Kontrollera obetalda kundfakturor innan bokslut.`,
      ),
      "the unbacked receivable balance from the migration is named exactly",
    ).toBeVisible({ timeout: 25000 });

    await expect(
      b.getByText(
        `Leverantörsreskontran stämmer inte mot konto 2440: differens ${UNBACKED.payables} kr. Kontrollera obetalda leverantörsfakturor innan bokslut.`,
      ),
      "and so is the unbacked payable balance",
    ).toBeVisible();

    // Balance-sheet accounts are unsigned until someone has actually looked at
    // them. Bokslutsbilagorna are where that happens, per account.
    await expect(b.getByText(/balanskonton är inte signerade/)).toBeVisible();

    // The amounts the reminders quote are the ones in the ledger, so the
    // warning is derived rather than guessed.
    const balances = await ctx.svc.supabase.sql<{
      account_number: string;
      net: string;
    }>`
      select account_number, (sum(debit_amount) - sum(credit_amount))::text as net
      from public.journal_entry_lines
      where account_number in ('1510', '2440')
      group by account_number order by account_number`;
    expect(balances[0]?.account_number).toBe("1510");
    expect(balances[0]?.net).toBe("62500");
    expect(balances[1]?.account_number).toBe("2440");
    expect(balances[1]?.net).toBe("-60000");

    // And there really is nothing behind them: the import said "0 motparter".
    const subledgers = await ctx.svc.supabase.sql<{
      customers: number;
      suppliers: number;
    }>`
      select (select count(*)::int from public.customers) as customers,
             (select count(*)::int from public.suppliers) as suppliers`;
    expect(subledgers[0]?.customers).toBe(0);
    expect(subledgers[0]?.suppliers).toBe(0);

    return ctx.parent;
  },
);
