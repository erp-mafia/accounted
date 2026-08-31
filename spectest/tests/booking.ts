/**
 * Booking an imported bank transaction, and the period lock that stops it.
 *
 * This is the product's centre of gravity. Everything upstream exists to get a
 * transaction here, and everything downstream reads what this produces. The
 * assertions are on the journal entry itself rather than on the screen: a
 * verifikat that renders correctly but stores the wrong side of the ledger is
 * the failure that costs a customer their books.
 *
 * The company already carries A1 from the invoice, so this booking must land
 * as A2. Voucher numbers come from the commit_journal_entry RPC and have to
 * stay sequential across every source that creates entries: a gap in the
 * series needs a documented explanation under BFNAR 2013:2.
 */
import { expect } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";
import { connectBank } from "./bank";

export const bookTransaction = env.test(
  "book a bank transaction into the ledger",
  { dependsOn: connectBank },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(`${APP_URL}/transactions`);

    // The skattekonto payment: a real Swedish operation with no VAT, so the
    // expected entry is exactly two lines and there is nothing to argue about.
    const row = b
      .locator("tr")
      .filter({ hasText: "Inbetalning skattekonto 16556677-8899" })
      .first();
    // Gate on the row before reaching into it: the page header renders first,
    // and under load the fetch behind the table takes a while.
    await expect(row).toBeVisible({ timeout: 45000 });
    await row
      .getByRole("button", { name: "Bokför", exact: true })
      .click({ timeout: 20000 });

    // The template picker offers BAS-mapped templates. Insättning skattekonto
    // is D 1630 / K 1930.
    await b
      .getByRole("button", { name: /Insättning skattekonto/ })
      .first()
      .click();

    // Nothing is posted before the user has seen the entry. That review step
    // is what makes the booking a decision rather than a side effect.
    const review = b.getByRole("dialog");
    await expect(b.getByText("Granska verifikationen innan du bokför")).toBeVisible();
    await expect(review).toContainText("D: 1630 Skattekonto → K: 1930 Företagskonto");

    await review.getByRole("button", { name: "Bokför", exact: true }).click();

    // Read this booking's own verifikat back once it exists. The POST is in
    // flight when the click resolves, so poll rather than race it.
    const lines = await ctx.poll("the verifikat is posted", async () => {
      const rows = await ctx.svc.supabase.sql<{
        voucher_series: string;
        voucher_number: number;
        status: string;
        account_number: string;
        debit: string;
        credit: string;
      }>`
        select je.voucher_series, je.voucher_number, je.status,
               jel.account_number,
               jel.debit_amount::text  as debit,
               jel.credit_amount::text as credit
        from public.journal_entries je
        join public.journal_entry_lines jel on jel.journal_entry_id = je.id
        where je.description = 'Inbetalning skattekonto 16556677-8899'
        order by jel.account_number`;
      return rows.unwrap().length === 2 ? rows : null;
    });

    expect(lines).toHaveLength(2);
    expect(lines[0]?.voucher_series).toBe("A");
    // A2, not A1: the invoice took the first number. Sequential numbering
    // across different sources is the property under test.
    expect(lines[0]?.voucher_number).toBe(2);
    // Posted, not draft: a draft would leave the transaction looking booked
    // while nothing had actually entered the ledger.
    expect(lines[0]?.status).toBe("posted");

    // Debit the tax account, credit the bank. The other way round would turn a
    // payment to Skatteverket into money received.
    expect(lines[0]?.account_number).toBe("1630");
    expect(lines[0]?.debit).toBe("43120");
    expect(lines[0]?.credit).toBe("0");
    expect(lines[1]?.account_number).toBe("1930");
    expect(lines[1]?.debit).toBe("0");
    expect(lines[1]?.credit).toBe("43120");

    // Balanced across the whole ledger, invoice included.
    const balance = await ctx.svc.supabase.sql<{ diff: string }>`
      select (sum(debit_amount) - sum(credit_amount))::text as diff
      from public.journal_entry_lines`;
    expect(balance[0]?.diff).toBe("0");

    // And the transaction now points at the verifikat, which is what stops it
    // being booked twice. The link is written after the entry, in a separate
    // statement, so poll for it rather than reading the instant the entry
    // appears.
    const linked = await ctx.poll("the transaction is linked to it", async () => {
      const rows = await ctx.svc.supabase.sql<{ n: number }>`
        select count(*)::int as n from public.transactions
        where journal_entry_id is not null`;
      return rows.unwrap()[0]?.n === 1 ? rows : null;
    });
    expect(linked[0]?.n).toBe(1);

    return ctx.parent;
  },
);

export const lockedPeriodRefusesBooking = env.test(
  "a locked period refuses the booking and says so",
  { dependsOn: bookTransaction },
  async (ctx) => {
    const b = await ctx.browser();

    // Lock the whole fiscal year. Past a lock, BFL leaves storno as the only
    // correction path, so nothing new may enter the period at all.
    await ctx.svc.supabase.sql`update public.fiscal_periods set locked_at = now()`;

    await b.goto(`${APP_URL}/transactions`);
    const row = b.locator("tr").filter({ hasText: "Frakt" }).first();
    await row.getByRole("button", { name: "Bokför", exact: true }).click();
    await b
      .getByRole("button", { name: /Konsulttjänster/ })
      .first()
      .click();
    await b.getByRole("dialog").getByRole("button", { name: "Bokför", exact: true }).click();

    // The user is told, in Swedish, what happened and why. A silent failure
    // here would leave them believing the transaction was booked.
    await expect(
      b.getByText(
        "Verifikation kunde inte skapas: Perioden är låst. Verifikationen kan inte skapas i en stängd eller låst period.",
      ),
    ).toBeVisible({ timeout: 20000 });

    // The trigger held: still the invoice and the one bank booking, no more.
    const entries = await ctx.svc.supabase.sql<{ n: number }>`
      select count(*)::int as n from public.journal_entries`;
    expect(entries[0]?.n).toBe(2);

    return ctx.parent;
  },
);

/**
 * KNOWN FAILING, on purpose. Pins issue #1947.
 *
 * lib/worklist/types.ts defines the canonical "att bokföra" predicate as
 * `is_business IS NULL AND is_ignored = false`, and states its done-condition
 * as "any booking flow sets is_business = true". The partial-booking path
 * breaks that: when the journal entry is refused (a locked period, here) the
 * categorisation has already been persisted with is_business = true, so the
 * transaction reads as done while it is not booked.
 *
 * The user therefore sees "Delvis bokförd", and the transaction then vanishes
 * from "Att bokföra" and from the nav badge while still being unbooked. In an
 * accounting product an unbooked transaction silently leaving the work list is
 * the expensive kind of bug: nothing is lost, but nobody is told to finish it.
 *
 * The fix is a design decision (does "delvis bokförd" become its own worklist
 * state, or does the categorisation roll back with the entry?), so it is left
 * to the founder rather than guessed at here. See also #1950, which is the
 * same field misread on the storno path.
 */
export const partiallyBookedStaysOnTheWorklist = env.test(
  "a partially booked transaction is still work to do",
  { dependsOn: lockedPeriodRefusesBooking },
  async (ctx) => {
    const counts = await ctx.svc.supabase.sql<{
      unbooked: number;
      worklist_says: number;
    }>`
      select count(*) filter (where journal_entry_id is null and is_ignored = false)::int as unbooked,
             count(*) filter (where is_business is null and is_ignored = false)::int      as worklist_says
      from public.transactions`;

    // 22 imported, 1 booked, so 21 remain to be dealt with. The worklist
    // reports one fewer, because the refused booking marked one of them done.
    expect(counts[0]?.unbooked).toBe(21);
    expect(
      counts[0]?.worklist_says,
      "every unbooked transaction is still counted as work to do",
    ).toBe(21);

    return ctx.parent;
  },
);
