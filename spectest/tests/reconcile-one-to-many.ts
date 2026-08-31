/**
 * One bank row settling several verifikationer, the 1:N split of #1553.
 *
 * The ordinary case is one bank row, one verifikat, and the transaction just
 * points at it. A customer who pays two invoices with a single transfer breaks
 * that: the bank shows one 18 750 kr deposit and the books hold two vouchers
 * of 10 000 and 8 750. Before #1553 there was nowhere to put that, so the row
 * sat unmatched forever or someone invented a verifikat to make it go away.
 *
 * The new shape keeps `transactions.journal_entry_id` NULL and writes one
 * `transaction_voucher_links` row per voucher, each carrying a signed slice.
 * The invariant that makes it safe is that the slices must sum to the row
 * exactly: a split that does not close is not a reconciliation, it is a
 * difference someone has stopped looking at.
 *
 * Two vouchers are created by hand first, because the point is a row matched
 * to verifikationer that already exist rather than one booked from the row.
 */
import { expect } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";
import { bookTransaction } from "./booking";

/** The incoming row in the bank fixture: one 18 750 kr transfer. */
const BANK_ROW = { counterparty: "NORDIC DESIGN AB", amount: "18750" };
const FIRST = { text: "Delbetalning Nordic Design 1", amount: "10000" };
const SECOND = { text: "Delbetalning Nordic Design 2", amount: "8750" };

/** Create a two-line voucher: money into the bank, a receivable cleared. */
async function bookPayment(
  b: Awaited<ReturnType<Parameters<Parameters<typeof env.test>[2]>[0]["browser"]>>,
  text: string,
  amount: string,
) {
  await b.goto(`${APP_URL}/bookkeeping`);
  // The button names the number it is about to take, so match the prefix.
  await b.getByRole("button", { name: /^Tomt verifikat/ }).first().click();

  const dialog = b.getByRole("dialog", { name: "Ny verifikation" });
  await dialog.getByPlaceholder("Verifikationstext...").fill(text);

  // :visible matters. The form renders each cell twice, a 0x0 copy for one
  // breakpoint and the real one for the other, so a plain .first() targets an
  // element that exists, is reported visible by the accessibility tree, and
  // measures nothing.
  const account = dialog.locator('input[placeholder="Sök konto…"]:visible');
  const money = dialog.locator('input[placeholder="0,00"]:visible');

  await account.nth(0).fill("1930");
  await money.nth(0).fill(amount);

  await account.nth(1).fill("1510");
  await money.nth(3).fill(amount);

  // "Spara som utkast" is the other button here, and a draft is not something
  // a bank row can settle: post it.
  await dialog.getByRole("button", { name: "Granska & skapa" }).click();
  // The review step asks for an underlag first. There is none here, and it
  // offers to post without one rather than refusing: BFL wants the document,
  // but a bank payment already carries its own evidence in the statement.
  await b.getByRole("button", { name: "Bokför utan underlag" }).click();
}

export const bookTwoPaymentsByHand = env.test(
  "two verifikationer wait for one bank row",
  { dependsOn: bookTransaction },
  async (ctx) => {
    const b = await ctx.browser();

    await bookPayment(b, FIRST.text, FIRST.amount);
    await bookPayment(b, SECOND.text, SECOND.amount);

    const entries = await ctx.poll("both vouchers are posted", async () => {
      const rows = await ctx.svc.supabase.sql<{
        description: string;
        status: string;
        amount: string;
      }>`
        select je.description, je.status,
               trim_scale(jel.debit_amount)::text as amount
        from public.journal_entries je
        join public.journal_entry_lines jel on jel.journal_entry_id = je.id
        where jel.account_number = '1930' and jel.debit_amount > 0
        order by jel.debit_amount desc`;
      return rows.unwrap().length === 2 ? rows : null;
    });
    expect(entries[0]?.amount).toBe(FIRST.amount);
    expect(entries[1]?.amount).toBe(SECOND.amount);
    // Posted, not drafts: an unposted voucher is not something a bank row can
    // settle, and the reconciliation would not offer it.
    expect(entries[0]?.status).toBe("posted");
    expect(entries[1]?.status).toBe("posted");

    // Neither is tied to a bank row yet: that is what the next test does.
    const links = await ctx.svc.supabase.sql<{ n: number }>`
      select count(*)::int as n from public.transaction_voucher_links`;
    expect(links[0]?.n).toBe(0);

    return ctx.parent;
  },
);

export const oneRowSettlesBothVouchers = env.test(
  "one bank row is split across both verifikationer",
  { dependsOn: bookTwoPaymentsByHand },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(`${APP_URL}/reconciliation`);
    // Pick the account first: the worksheet is per account, and 1930 is the
    // one the bank row and both vouchers live on.
    await b.getByRole("button", { name: /^Företagskonto 1930/ }).click();
    await b.getByRole("tab", { name: "Matcha manuellt" }).click();

    // Left pane: the bank row nobody has booked. Right pane follows the left,
    // and becomes multi-select precisely because exactly one row is picked.
    await b.getByRole("checkbox", { name: BANK_ROW.counterparty }).check();
    await b.getByRole("row", { name: new RegExp(FIRST.text) }).click();
    await b.getByRole("row", { name: new RegExp(SECOND.text) }).click();

    // The footer sums both sides and Koppla stays disabled until they meet.
    // A split that does not close exactly is not a reconciliation.
    await expect(b.getByText("Differens")).toBeVisible();
    await expect(
      b.getByRole("button", { name: /^Koppla/ }),
      "the link is offered only once the two sides net to zero",
    ).toBeEnabled();

    await b.getByRole("button", { name: /^Koppla/ }).first().click();

    const links = await ctx.poll("the split is written", async () => {
      const rows = await ctx.svc.supabase.sql<{
        allocated: string;
        description: string;
      }>`
        select trim_scale(tvl.allocated_amount)::text as allocated,
               je.description
        from public.transaction_voucher_links tvl
        join public.journal_entries je on je.id = tvl.journal_entry_id
        order by tvl.allocated_amount desc`;
      return rows.unwrap().length === 2 ? rows : null;
    });

    // One slice per voucher, each the voucher's own amount.
    expect(links[0]?.allocated).toBe(FIRST.amount);
    expect(links[0]?.description).toBe(FIRST.text);
    expect(links[1]?.allocated).toBe(SECOND.amount);
    expect(links[1]?.description).toBe(SECOND.text);

    // And they sum to the row. This is the invariant the whole feature rests
    // on: a row is settled when its slices account for all of it, not when
    // someone has attached a plausible voucher to it.
    const total = await ctx.svc.supabase.sql<{ sum: string }>`
      select trim_scale(sum(allocated_amount))::text as sum
      from public.transaction_voucher_links`;
    expect(total[0]?.sum, "the slices account for the whole bank row").toBe(
      BANK_ROW.amount,
    );

    // The transaction itself keeps no single pointer. Setting journal_entry_id
    // to one of the two would make the row look settled by that voucher alone
    // and hide the other half from every reader that follows the pointer.
    const tx = await ctx.svc.supabase.sql<{
      single_pointer: boolean;
      amount: string;
    }>`
      select journal_entry_id is not null as single_pointer,
             trim_scale(amount)::text as amount
      from public.transactions
      where id in (select transaction_id from public.transaction_voucher_links)`;
    expect(tx).toHaveLength(1);
    expect(
      tx[0]?.single_pointer,
      "a split row points at no single voucher, only at its slices",
    ).toBe(false);
    expect(tx[0]?.amount).toBe(BANK_ROW.amount);

    return ctx.parent;
  },
);

export const stornoOfOneSliceReleasesTheRow = env.test(
  "stornoing one of the split vouchers releases the bank row",
  { dependsOn: oneRowSettlesBothVouchers },
  async (ctx) => {
    const b = await ctx.browser();

    // Storno the larger of the two. The row was settled by the pair, so with
    // one of them cancelled the remaining slice no longer accounts for it and
    // the row has to come back as work to do. Leaving it settled would hide a
    // 18 750 kr deposit that is now only half explained.
    const entry = await ctx.svc.supabase.sql<{ id: string }>`
      select id::text as id from public.journal_entries
      where description = ${FIRST.text}`;
    await b.goto(`${APP_URL}/bookkeeping/${entry[0]!.id.unwrap()}`);
    await expect(b.getByText(FIRST.text).first()).toBeVisible({ timeout: 20000 });

    await b.getByRole("button", { name: "Fler alternativ" }).click();
    await b.getByRole("menuitem", { name: "Återför (storno)" }).click();
    await b.getByRole("button", { name: "Skapa storno", exact: true }).click();

    const released = await ctx.poll("the row is released", async () => {
      const rows = await ctx.svc.supabase.sql<{ n: number }>`
        select count(*)::int as n from public.transaction_voucher_links`;
      return rows.unwrap()[0]?.n === 0 ? rows : null;
    });
    expect(
      released[0]?.n,
      "a half-explained row keeps no slices: it is unmatched again",
    ).toBe(0);

    // And the transaction is back to unbooked rather than half-linked.
    const tx = await ctx.svc.supabase.sql<{
      booked: boolean;
      amount: string;
    }>`
      select journal_entry_id is not null as booked,
             trim_scale(amount)::text as amount
      from public.transactions
      where amount = ${BANK_ROW.amount}::numeric`;
    expect(tx[0]?.booked).toBe(false);

    // The stornoed voucher and its storno both survive: releasing the bank row
    // is a reconciliation change, not a licence to delete a posted verifikat.
    const entries = await ctx.svc.supabase.sql<{
      status: string;
      description: string;
    }>`
      select status, description from public.journal_entries
      where description like ${"%" + FIRST.text + "%"}
      order by voucher_number`;
    expect(entries).toHaveLength(2);
    expect(entries[0]?.status).toBe("reversed");
    expect(entries[1]?.status).toBe("posted");

    return ctx.parent;
  },
);
