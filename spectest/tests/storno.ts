/**
 * Rättelse by storno, BFL 5 kap. 5 §.
 *
 * A posted verifikat is never edited and never deleted. It is cancelled by a
 * mirroring entry, and the chain original → storno stays traceable forever.
 * That is not a preference, it is what the law requires of the books, so it is
 * worth a test that reads the ledger rather than the screen.
 */
import { expect } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";
import { bookTransaction } from "./booking";
import { SEK_TX_COUNT, EUR_TRANSACTIONS } from "../fakes/enable-banking-data";

/** Everything the consent imported, derived so a fixture change cannot rot it. */
const TOTAL_TX = SEK_TX_COUNT + EUR_TRANSACTIONS.length;

export const stornoReversesTheEntry = env.test(
  "storno cancels the verifikat without deleting it",
  { dependsOn: bookTransaction },
  async (ctx) => {
    const b = await ctx.browser();

    // Straight to the bank booking's verifikat by id. Navigating the list is
    // a different thing that can break, and mixing it in here would make a
    // storno failure read as a routing failure. Not `limit 1`: A1 is the
    // invoice, and stornoing that would be a different test.
    const entry = await ctx.svc.supabase.sql<{ id: string }>`
      select id::text as id from public.journal_entries
      where description = 'Inbetalning skattekonto 16556677-8899'`;
    const entryId = entry[0]!.id.unwrap();
    await b.goto(`${APP_URL}/bookkeeping/${entryId}`);

    await expect(b.getByText("Verifikat A2")).toBeVisible({ timeout: 20000 });

    await b.getByRole("button", { name: "Fler alternativ" }).click();
    await b.getByRole("menuitem", { name: "Återför (storno)" }).click();

    // The confirmation is where the user learns what storno means, and it
    // names the law. If this text goes missing, someone is about to be
    // surprised by an immutable entry.
    await expect(b.getByText(/Originalet raderas inte/)).toBeVisible();
    await expect(b.getByText(/BFL 5 kap\. 5 §/)).toBeVisible();

    await b.getByRole("button", { name: "Skapa storno", exact: true }).click();

    const lines = await ctx.poll("the storno is posted", async () => {
      const rows = await ctx.svc.supabase.sql<{
        voucher_number: number;
        status: string;
        is_storno: boolean;
        was_reversed: boolean;
        account_number: string;
        debit: string;
        credit: string;
      }>`
        select je.voucher_number, je.status,
               je.reverses_id    is not null as is_storno,
               je.reversed_by_id is not null as was_reversed,
               jel.account_number,
               jel.debit_amount::text  as debit,
               jel.credit_amount::text as credit
        from public.journal_entries je
        join public.journal_entry_lines jel on jel.journal_entry_id = je.id
        where je.id = ${entryId}::uuid or je.reverses_id = ${entryId}::uuid
        order by je.voucher_number, jel.account_number`;
      return rows.unwrap().length === 4 ? rows : null;
    });

    // The original survives, marked as reversed and pointing at its storno.
    // A missing row here would mean the entry was deleted, which BFL forbids.
    expect(lines[0]?.voucher_number).toBe(2);
    expect(lines[0]?.status).toBe("reversed");
    expect(lines[0]?.was_reversed).toBe(true);
    expect(lines[0]?.is_storno).toBe(false);

    // The storno is its own posted verifikat, numbered next in the series,
    // and it points back at what it cancels.
    expect(lines[2]?.voucher_number).toBe(3);
    expect(lines[2]?.status).toBe("posted");
    expect(lines[2]?.is_storno).toBe(true);

    // Mirrored, side for side. A1 debited 1630 and credited 1930; A2 does the
    // opposite, so the two together leave the ledger exactly as it was.
    expect(lines[2]?.account_number).toBe("1630");
    expect(lines[2]?.credit).toBe("43120");
    expect(lines[2]?.debit).toBe("0");
    expect(lines[3]?.account_number).toBe("1930");
    expect(lines[3]?.debit).toBe("43120");
    expect(lines[3]?.credit).toBe("0");

    // Net effect of the pair on every account it touched is zero, which is
    // the whole point. Scoped to the two entries: the invoice's own lines are
    // untouched and must stay where they are.
    const net = await ctx.svc.supabase.sql<{ account_number: string; net: string }>`
      select jel.account_number,
             (sum(jel.debit_amount) - sum(jel.credit_amount))::text as net
      from public.journal_entry_lines jel
      join public.journal_entries je on je.id = jel.journal_entry_id
      where je.id = ${entryId}::uuid or je.reverses_id = ${entryId}::uuid
      group by jel.account_number order by jel.account_number`;
    expect(net).toHaveLength(2);
    expect(net[0]?.net).toBe("0");
    expect(net[1]?.net).toBe("0");

    // And the bank transaction is no longer claimed by any verifikat.
    const linked = await ctx.svc.supabase.sql<{ n: number }>`
      select count(*)::int as n from public.transactions
      where journal_entry_id is not null`;
    expect(linked[0]?.n).toBe(0);

    // The invoice's own verifikat is untouched by all this.
    const invoiceEntry = await ctx.svc.supabase.sql<{ status: string }>`
      select status from public.journal_entries where voucher_number = 1`;
    expect(invoiceEntry[0]?.status).toBe("posted");

    return ctx.parent;
  },
);

/**
 * KNOWN FAILING, on purpose. Pins issue #1950.
 *
 * The storno confirmation dialog states plainly that "kopplade
 * banktransaktioner återgår till 'Att bokföra'". They do not. Storno clears
 * `journal_entry_id` but leaves `is_business = true`, and the canonical
 * worklist predicate (`is_business IS NULL`) therefore keeps counting the
 * transaction as handled. It vanishes from the list while being unbooked.
 *
 * Same field, same misreading as #1947: `is_business` is written as if it
 * meant "booked" while the worklist treats it as "dealt with". This one is
 * worse only because the product promised otherwise a moment earlier.
 */
export const stornoReturnsTheTransactionToTheWorklist = env.test(
  "storno puts the bank transaction back on the worklist",
  { dependsOn: stornoReversesTheEntry },
  async (ctx) => {
    const counts = await ctx.svc.supabase.sql<{
      unbooked: number;
      worklist_says: number;
    }>`
      select count(*) filter (where journal_entry_id is null and is_ignored = false)::int as unbooked,
             count(*) filter (where is_business is null and is_ignored = false)::int      as worklist_says
      from public.transactions`;

    // The storno released the one booked transaction, so everything imported
    // is work again (#1950, fixed in cb9ae15d4).
    expect(counts[0]?.unbooked).toBe(TOTAL_TX);
    expect(
      counts[0]?.worklist_says,
      'the dialog promised the transaction returns to "Att bokföra"',
    ).toBe(TOTAL_TX);

    return ctx.parent;
  },
);
