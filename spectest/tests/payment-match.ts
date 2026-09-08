/**
 * The payment arrives, and closes the invoice.
 *
 * This is the loop the invoice page promises on its empty state: "Skicka med
 * ett mejl, och betalningen matchas mot fakturan när den kommer in." Nothing
 * else in the suite tests a promise the product makes to the user in those
 * words.
 *
 * The bank fixture pays in 18 750 kr with the text "Betalning faktura
 * 2026-114 OCR 1141234567890", and the invoice created upstream is for exactly
 * 18 750 kr. Whether the matcher finds each other is the question.
 */
import { expect } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";
import { connectBank } from "./bank";
import { SEK_TX_COUNT, EUR_TRANSACTIONS } from "../fakes/enable-banking-data";

/** Everything the consent imported, derived so a fixture change cannot rot it. */
const TOTAL_TX = SEK_TX_COUNT + EUR_TRANSACTIONS.length;

const PAYMENT_ROW = "2026-114";

export const paymentMatchesTheInvoice = env.test(
  "an incoming payment closes the invoice",
  { dependsOn: connectBank },
  async (ctx) => {
    const b = await ctx.browser();

    // The matcher runs at ingest, so the hint should already be on the row by
    // the time the transactions page is opened. Exactly one: a matcher that
    // hinted at several transactions would be guessing rather than matching.
    const hinted = await ctx.svc.supabase.sql<{
      description: string;
      amount: string;
    }>`
      select description, amount::text as amount
      from public.transactions
      where potential_invoice_id is not null`;
    expect(hinted).toHaveLength(1);
    expect(hinted[0]?.description).toBe("Betalning faktura 2026-114 OCR 1141234567890");
    expect(hinted[0]?.amount).toBe("18750");

    await b.goto(`${APP_URL}/transactions`);

    // Gate on the page's own count before looking for a row. The header and
    // the filters render before the list resolves, so a row locator alone
    // races the fetch and fails as "not visible" rather than "still loading".
    await expect(b.getByText(`${TOTAL_TX} att hantera`)).toBeVisible({
      timeout: 45000,
    });

    // One click, on the row itself, naming the invoice it found.
    const row = b.locator("tr").filter({ hasText: PAYMENT_ROW }).first();
    await expect(row).toBeVisible({ timeout: 25000 });
    await row.getByRole("button", { name: /Matcha Faktura 001/ }).click({ timeout: 20000 });

    // The confirmation shows the entry and states what will happen. "Beloppen
    // stämmer" is the matcher telling the user it is not guessing.
    const confirm = b.getByRole("dialog");
    await expect(confirm).toContainText("Beloppen stämmer");
    await expect(confirm).toContainText("Fakturan markeras som betald");
    await b.getByRole("button", { name: "Bekräfta matchning", exact: true }).click();

    // A3: the payment entry, after the invoice (A1) and the skattekonto
    // booking (A2). Sequential across three different sources.
    const lines = await ctx.poll("the payment is booked", async () => {
      const rows = await ctx.svc.supabase.sql<{
        voucher_number: number;
        account_number: string;
        debit: string;
        credit: string;
      }>`
        select je.voucher_number, jel.account_number,
               jel.debit_amount::text  as debit,
               jel.credit_amount::text as credit
        from public.journal_entries je
        join public.journal_entry_lines jel on jel.journal_entry_id = je.id
        where je.description like 'Inbetalning kundfaktura%'
        order by jel.account_number`;
      return rows.unwrap().length === 2 ? rows : null;
    });

    // Money into the bank, receivable out. Booking it the other way would
    // leave the customer owing twice what they owe.
    expect(lines[0]?.account_number).toBe("1510");
    expect(lines[0]?.credit).toBe("18750");
    expect(lines[1]?.account_number).toBe("1930");
    expect(lines[1]?.debit).toBe("18750");

    // The receivable is settled: 1510 was debited 18 750 by the invoice and is
    // now credited the same. A non-zero balance here means a customer still
    // shows as owing money they have already paid.
    const receivable = await ctx.svc.supabase.sql<{ net: string }>`
      select (sum(debit_amount) - sum(credit_amount))::text as net
      from public.journal_entry_lines where account_number = '1510'`;
    expect(receivable[0]?.net).toBe("0");

    // Revenue and output VAT are untouched by the payment. A payment that
    // moved either would double-count the sale.
    const revenue = await ctx.svc.supabase.sql<{
      account_number: string;
      net: string;
    }>`
      select account_number, (sum(debit_amount) - sum(credit_amount))::text as net
      from public.journal_entry_lines
      where account_number in ('2611', '3001')
      group by account_number order by account_number`;
    expect(revenue[0]?.net).toBe("-3750");
    expect(revenue[1]?.net).toBe("-15000");

    // And the transaction is tied to the invoice, not merely booked, which is
    // what stops the same payment matching a second invoice later. Both
    // columns are written after the entry, so poll rather than read the
    // instant the verifikat appears.
    const tx = await ctx.poll("the transaction is tied to the invoice", async () => {
      const rows = await ctx.svc.supabase.sql<{
        booked: boolean;
        linked: boolean;
      }>`
        select journal_entry_id is not null as booked,
               invoice_id       is not null as linked
        from public.transactions
        where description like '%2026-114%'`;
      const row = rows.unwrap()[0];
      return row?.booked && row?.linked ? rows : null;
    });
    expect(tx[0]?.booked).toBe(true);
    expect(tx[0]?.linked).toBe(true);

    return ctx.parent;
  },
);
