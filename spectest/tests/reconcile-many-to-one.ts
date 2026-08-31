/**
 * Several bank rows settling one verifikat, the N:1 shape.
 *
 * `reconcile-one-to-many.ts` covers the other direction. This one is the
 * everyday case behind a company card: the books hold one verifikat for the
 * month's card purchases, and the bank shows each charge as its own row. The
 * ledger is right, the bank is right, and nothing lines up one-to-one.
 *
 * The worksheet's right pane goes single-select as soon as more than one bank
 * row is picked, which is the UI expressing the same constraint the engine
 * has: N rows may settle ONE verifikat, or one row may be split across N, but
 * not both at once.
 *
 *   2 487,50  TELIA SVERIGE AB
 *   1 249,00  DUSTIN SVERIGE AB
 *   --------
 *   3 736,50  one verifikat
 */
import { expect } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";
import { bookTransaction } from "./booking";

const VOUCHER = { text: "Företagskort augusti", amount: "3736.5" };
const ROWS = ["TELIA SVERIGE AB", "DUSTIN SVERIGE AB"];

export const bookTheCardStatementAsOneVoucher = env.test(
  "one verifikat covers a month of card purchases",
  { dependsOn: bookTransaction },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(`${APP_URL}/bookkeeping`);
    await b.getByRole("button", { name: /^Tomt verifikat/ }).first().click();

    const dialog = b.getByRole("dialog", { name: "Ny verifikation" });
    await dialog.getByPlaceholder("Verifikationstext...").fill(VOUCHER.text);

    // :visible: the form renders each cell twice, a 0x0 copy for one
    // breakpoint and the real one for the other.
    const account = dialog.locator('input[placeholder="Sök konto…"]:visible');
    const money = dialog.locator('input[placeholder="0,00"]:visible');

    await account.nth(0).fill("5410");
    await money.nth(0).fill(VOUCHER.amount);
    await account.nth(1).fill("1930");
    await money.nth(3).fill(VOUCHER.amount);

    await dialog.getByRole("button", { name: "Granska & skapa" }).click();
    await b.getByRole("button", { name: "Bokför utan underlag" }).click();

    const entry = await ctx.poll("the voucher is posted", async () => {
      const rows = await ctx.svc.supabase.sql<{
        status: string;
        amount: string;
      }>`
        select je.status, trim_scale(jel.credit_amount)::text as amount
        from public.journal_entries je
        join public.journal_entry_lines jel on jel.journal_entry_id = je.id
        where je.description = ${VOUCHER.text} and jel.account_number = '1930'`;
      return rows.unwrap().length === 1 ? rows : null;
    });
    expect(entry[0]?.status).toBe("posted");
    expect(entry[0]?.amount).toBe("3736.5");

    return ctx.parent;
  },
);

export const twoRowsSettleTheOneVoucher = env.test(
  "two bank rows together settle the single verifikat",
  { dependsOn: bookTheCardStatementAsOneVoucher },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(`${APP_URL}/reconciliation`);
    await b.getByRole("button", { name: /^Företagskonto 1930/ }).click();
    await b.getByRole("tab", { name: "Matcha manuellt" }).click();

    for (const row of ROWS) {
      await b.getByRole("checkbox", { name: row }).check();
    }
    await b.getByRole("row", { name: new RegExp(VOUCHER.text) }).click();

    // Koppla opens only when the two sides meet. 2 487,50 and 1 249 are not
    // memorable numbers, which is the point: the footer does the arithmetic
    // so nobody has to trust that they add up.
    await expect(b.getByText("Differens")).toBeVisible();
    await expect(
      b.getByRole("button", { name: /^Koppla/ }),
      "the link is offered once the rows account for the verifikat",
    ).toBeEnabled();
    await b.getByRole("button", { name: /^Koppla/ }).first().click();

    const linked = await ctx.poll("both rows point at the voucher", async () => {
      const rows = await ctx.svc.supabase.sql<{
        description: string;
        amount: string;
        entry: string;
      }>`
        select t.description,
               trim_scale(t.amount)::text as amount,
               je.description as entry
        from public.transactions t
        join public.journal_entries je on je.id = t.journal_entry_id
        where je.description = ${VOUCHER.text}
        order by t.amount`;
      return rows.unwrap().length === 2 ? rows : null;
    });

    // Both rows carry a single pointer to the same verifikat. That is the
    // shape N:1 takes, and it is the opposite of the 1:N split: there the
    // transaction points at nothing and slices live in
    // transaction_voucher_links, because no one voucher settles the row.
    // Here each row IS settled by one voucher; the voucher just happens to
    // settle two of them.
    expect(linked[0]?.amount).toBe("-2487.5");
    expect(linked[1]?.amount).toBe("-1249");
    expect(linked[0]?.entry).toBe(VOUCHER.text);
    expect(linked[1]?.entry).toBe(VOUCHER.text);

    const slices = await ctx.svc.supabase.sql<{ n: number }>`
      select count(*)::int as n from public.transaction_voucher_links`;
    expect(
      slices[0]?.n,
      "N:1 needs no slices: nothing is being divided",
    ).toBe(0);

    // And between them the rows account for the verifikat exactly, which is
    // what the footer required before it would offer Koppla at all.
    const total = await ctx.svc.supabase.sql<{ sum: string }>`
      select trim_scale(sum(t.amount))::text as sum
      from public.transactions t
      join public.journal_entries je on je.id = t.journal_entry_id
      where je.description = ${VOUCHER.text}`;
    expect(total[0]?.sum).toBe("-3736.5");

    return ctx.parent;
  },
);
