/**
 * Crediting a supplier invoice, and undoing that.
 *
 * `credit-note.ts` covers the sales side. This is the purchase side, and it
 * has something the sales side does not: an undo. A supplier credit note is a
 * document we register rather than issue, so registering the wrong one is our
 * mistake to take back, and "Ångra kreditering" exists to free the invoice
 * again.
 *
 * That makes the interesting assertion the same one as everywhere else in
 * this suite: what survives. Undoing a credit must not delete a posted
 * verifikat, because BFL does not care that we were the ones who got it
 * wrong.
 *
 * Forks from the approved supplier invoice: 5010 D 12 000, 2641 D 3 000,
 * 2440 K 15 000. Approval is where the credit action becomes available, which
 * is the right order: an invoice nobody has accepted is withdrawn, not
 * credited.
 */
import { expect } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";
import { approveForPayment } from "./supplier-invoice";

const INVOICE_TOTAL = "15000";

export const creditTheSupplierInvoice = env.test(
  "credit a registered supplier invoice",
  { dependsOn: approveForPayment },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(`${APP_URL}/supplier-invoices`);
    await b.locator("tr").filter({ hasText: "2026-4471" }).first().click();
    await expect(b.getByText(/2026-4471/).first()).toBeVisible({ timeout: 25000 });

    // Behind the overflow menu: crediting is rare next to marking paid.
    await b.getByRole("button", { name: "Fler alternativ" }).click();
    await b.getByRole("menuitem", { name: "Kreditfaktura" }).click();

    // The confirmation is blunt about what it is and is not: a reversing
    // document, and one this dialog will not take back.
    await expect(
      b.getByRole("heading", { name: "Registrera kreditfaktura" }),
    ).toBeVisible();
    await expect(
      b.getByText(/reverserar den ursprungliga fakturan/),
      "the dialog says a reversing document is created, not that the invoice is edited",
    ).toBeVisible();
    await b
      .getByRole("button", { name: "Registrera kreditfaktura", exact: true })
      .last()
      .click();

    const invoices = await ctx.poll("the credit note exists", async () => {
      const rows = await ctx.svc.supabase.sql<{
        status: string;
        total: string;
        is_credit: boolean;
      }>`
        select status, trim_scale(total)::text as total,
               coalesce(is_credit_note, false) as is_credit
        from public.supplier_invoices
        order by created_at`;
      return rows.unwrap().length === 2 ? rows : null;
    });

    // Two documents. The original is marked credited rather than altered, and
    // the credit note carries the negated total.
    expect(invoices[0]?.status, "the original is marked, not rewritten").toBe(
      "credited",
    );
    // Note the convention, which differs from the sales side: a supplier
    // credit note carries a POSITIVE total and an is_credit_note flag, where
    // a customer credit note carries a negative total. Readers of both sides
    // trip on this; the cut-off code applies the sign from the flag
    // (kontantmetod-cutoff.ts) rather than trusting the number.
    expect(invoices[1]?.is_credit).toBe(true);
    expect(invoices[1]?.total).toBe(INVOICE_TOTAL);

    // And the reversal is its own verifikat: the original's three lines plus
    // three mirrored ones.
    const net = await ctx.svc.supabase.sql<{
      account_number: string;
      net: string;
    }>`
      select account_number,
             trim_scale(sum(debit_amount) - sum(credit_amount))::text as net
      from public.journal_entry_lines
      group by account_number order by account_number`;
    expect(
      net.transform("every account nets to zero after the credit", (rows) =>
        rows.map((r) => `${r.account_number}=${r.net}`).join(" "),
      ),
      "the pair leaves the ledger where it started",
    ).toBe("2440=0 2641=0 5010=0");

    const entries = await ctx.svc.supabase.sql<{ n: number }>`
      select count(*)::int as n from public.journal_entries`;
    expect(entries[0]?.n, "the credit is a second verifikat, not an edit").toBe(2);

    return ctx.parent;
  },
);

export const undoingTheCreditKeepsBothVerifikat = env.test(
  "undoing the credit frees the invoice without deleting a verifikat",
  { dependsOn: creditTheSupplierInvoice },
  async (ctx) => {
    const b = await ctx.browser();

    // Straight to the ORIGINAL by id. Both documents carry the same invoice
    // number in the list, and the undo lives on the original: the credit
    // note's own page points back here rather than offering it.
    const original = await ctx.svc.supabase.sql<{ id: string }>`
      select id::text as id from public.supplier_invoices
      where is_credit_note is not true`;
    await b.goto(`${APP_URL}/supplier-invoices/${original[0]!.id.unwrap()}`);
    await expect(b.getByText("Krediterad").first()).toBeVisible({ timeout: 25000 });

    // Promoted to a visible button once the invoice is credited: at that
    // point undoing is the only thing left to do with it.
    await b.getByRole("button", { name: "Ångra kreditering", exact: true }).click();
    await b
      .getByRole("button", { name: "Ångra kreditering", exact: true })
      .last()
      .click();

    const invoice = await ctx.poll("the invoice is freed", async () => {
      const rows = await ctx.svc.supabase.sql<{ status: string; n: number }>`
        select status, (select count(*)::int from public.supplier_invoices) as n
        from public.supplier_invoices where is_credit_note is not true`;
      return rows.unwrap()[0]?.status !== "credited" ? rows : null;
    });
    // Back to approved, where it was before the credit. The undo restores the
    // invoice's own status rather than dropping it to a generic one.
    expect(invoice[0]?.status).toBe("approved");

    // The credit note is kept and marked reversed, not deleted. The in-app
    // help says "ta bort kreditfakturan", which reads as removal; what
    // actually happens is better than that, and better than what BFL would
    // tolerate from a delete: a registered document that produced a posted
    // verifikat stays readable.
    const credit = await ctx.svc.supabase.sql<{ status: string; number: string }>`
      select status, supplier_invoice_number as number
      from public.supplier_invoices where is_credit_note = true`;
    expect(credit[0]?.status, "the credit note is reversed, not deleted").toBe(
      "reversed",
    );
    expect(credit[0]?.number).toBe("KREDIT-2026-4471");

    // But the verifikat it produced is not. Undoing our own administrative
    // mistake is not a licence to remove a posted entry: the books show the
    // credit and its reversal, and anyone reading them can see what happened.
    // Three verifikat, not one. The undo did not remove the credit's entry:
    // it reversed it with a third. So the chain original -> credit -> reversal
    // stays readable, which is what BFL 5 kap. 5 § asks for and is more than
    // the wording "ta bort" would have led anyone to expect.
    const entries = await ctx.svc.supabase.sql<{ n: number }>`
      select count(*)::int as n from public.journal_entries`;
    expect(
      entries[0]?.n,
      "the credit's verifikat was reversed by a third, not deleted",
    ).toBe(3);

    // And the ledger is back where the original invoice left it, not at zero:
    // the invoice is live again and the debt to the supplier stands.
    const net = await ctx.svc.supabase.sql<{
      account_number: string;
      net: string;
    }>`
      select account_number,
             trim_scale(sum(debit_amount) - sum(credit_amount))::text as net
      from public.journal_entry_lines
      group by account_number order by account_number`;
    expect(
      net.transform("the ledger after the undo", (rows) =>
        rows.map((r) => `${r.account_number}=${r.net}`).join(" "),
      ),
      "the supplier debt is live again, exactly as before the credit",
    ).toBe("2440=-15000 2641=3000 5010=12000");

    return ctx.parent;
  },
);
