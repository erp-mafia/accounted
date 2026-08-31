/**
 * Kontantmetoden: the invoice hits the books when it is paid, not when it is
 * sent.
 *
 * Every other invoice test in this suite runs on faktureringsmetoden, where
 * sending an invoice books 1510 / 3001 / 2611 and the later payment only
 * clears the receivable. Under kontantmetoden nothing happens at all until the
 * money arrives, and then the whole entry appears at once with no receivable
 * leg. Small companies are allowed the method under BFL 5 kap. 2 § and most
 * sole traders use it, so the branch is not an edge case.
 *
 * Getting it backwards moves revenue and output VAT between periods, which is
 * a momsdeklaration error rather than a display one, so both halves are
 * asserted against the ledger.
 */
import { expect } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";
import { enterTheAppAsEnskildFirma } from "./enskild-firma";

const CUSTOMER = {
  name: "Brf Solgården",
  email: "faktura@solgarden.test",
};

/** 10 000 excl. VAT at 25 %. */
const LINE = {
  description: "Konsultation augusti",
  unitPrice: "10000",
  subtotal: "10000",
  vat: "2500",
  total: "12500",
};

export const sendingBooksNothingOnTheCashMethod = env.test(
  "sending an invoice books nothing on the cash method",
  { dependsOn: enterTheAppAsEnskildFirma },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(`${APP_URL}/invoices`);
    await expect(b.getByText("Din första faktura tar två minuter.")).toBeVisible({
      timeout: 20000,
    });
    await b.getByRole("button", { name: "Ny faktura", exact: true }).click();

    await expect(b.getByText(/Betalningsuppgifter saknas/)).toBeVisible();
    await b.getByRole("button", { name: "Lägg till nu" }).click();
    await b.locator("#bankgiro").fill("123-4566");
    await b.getByRole("button", { name: "Spara & fortsätt" }).click();
    await expect(b.getByText("Betalningsuppgifter sparade")).toBeVisible();

    await b.getByRole("button", { name: "+ Skapa kund" }).click();
    await b.locator("#name").fill(CUSTOMER.name);
    await b.locator("#email").fill(CUSTOMER.email);
    await b.getByRole("button", { name: "Spara kund", exact: true }).click();
    // Wait for the selection to land before typing the line. The editor
    // re-renders when the customer is applied, and a description typed into
    // the previous render is discarded: the row then never materialises and
    // the price field that should follow it does not exist.
    await expect(b.getByText(CUSTOMER.email)).toBeVisible();

    await b.locator('input[placeholder^="Skriv fritt"]').fill(LINE.description);
    await b.keyboard.press("Enter");
    await b.locator('input[name="items.0.unit_price"]').fill(LINE.unitPrice);
    await expect(b.getByText("Moms 25%")).toBeVisible();

    await b.getByRole("button", { name: "Granska & skapa" }).click();
    await expect(b.getByText("Granska uppgifterna innan du bekräftar")).toBeVisible();
    await b.getByRole("button", { name: "Bekräfta & skapa" }).click();

    const invoices = await ctx.poll("the invoice exists", async () => {
      const rows = await ctx.svc.supabase.sql<{
        invoice_number: string;
        status: string;
        total: string;
      }>`
        select invoice_number, status, total::text as total from public.invoices`;
      return rows.unwrap().length === 1 ? rows : null;
    });
    expect(invoices[0]?.invoice_number).toBe("001");
    expect(invoices[0]?.total).toBe(LINE.total);

    // The logo prompt follows the first invoice.
    await b.getByRole("button", { name: "Hoppa över" }).click();
    await b.goto(`${APP_URL}/invoices`);
    await b.locator("tr").filter({ hasText: CUSTOMER.name }).first().click();
    await expect(b.getByText("Faktura 001")).toBeVisible({ timeout: 20000 });

    await b.getByRole("button", { name: "Fler alternativ" }).click();

    // The label itself carries the method. On faktureringsmetoden this reads
    // "Markera som skickad och bokför"; here there is nothing to book, and the
    // menu says so rather than offering an action that would be wrong.
    // The negative lookahead is the assertion: on faktureringsmetoden this item
    // reads "Markera som skickad och bokför", and matching the prefix alone
    // would pass on both methods. The accessible name carries the item's help
    // text too, so it is a prefix match rather than an exact one.
    const markSent = /^Markera som skickad(?! och bokför)/;
    await expect(
      b.getByRole("menuitem", { name: markSent }),
      "the cash method drops 'och bokför' from the action, because sending books nothing",
    ).toBeVisible();
    await b.getByRole("menuitem", { name: markSent }).click();

    // And the dialog states the rule instead of leaving the user to wonder
    // where their verifikat went.
    const confirm = b.getByRole("dialog");
    await expect(confirm).toContainText(
      "Kontantmetoden: bokföring sker vid betalning, inte vid fakturering.",
    );
    await confirm
      .getByRole("button", { name: "Markera som skickad", exact: true })
      .click();

    const invoice = await ctx.poll("the invoice is sent", async () => {
      const rows = await ctx.svc.supabase.sql<{
        status: string;
        booked: boolean;
      }>`
        select status, journal_entry_id is not null as booked from public.invoices`;
      return rows.unwrap()[0]?.status === "sent" ? rows : null;
    });
    expect(invoice[0]?.status).toBe("sent");
    expect(invoice[0]?.booked).toBe(false);

    // The point of the whole test: a sent, unpaid invoice is not yet a
    // business event under kontantmetoden, so the ledger is still empty.
    const entries = await ctx.svc.supabase.sql<{ n: number }>`
      select count(*)::int as n from public.journal_entries`;
    expect(entries[0]?.n, "nothing is booked until the money arrives").toBe(0);

    return ctx.parent;
  },
);

export const paymentBooksRevenueAndVat = env.test(
  "the payment books revenue and VAT with no receivable leg",
  { dependsOn: sendingBooksNothingOnTheCashMethod },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(`${APP_URL}/invoices`);
    await b.locator("tr").filter({ hasText: CUSTOMER.name }).first().click();
    await b.getByRole("button", { name: "Markera som betald", exact: true }).click();

    // The proposed entry, in words. Under faktureringsmetoden this dialog
    // offers 1930 against Kundfordringar; here the revenue and the output VAT
    // appear for the first time, which is the whole difference between the
    // methods expressed in three lines.
    const confirm = b.getByRole("dialog");
    await expect(confirm).toContainText("Företagskonto / checkkonto");
    await expect(confirm).toContainText("Försäljning inom Sverige, 25 % moms");
    await expect(confirm).toContainText(
      "Utgående moms försäljning inom Sverige, 25%",
    );
    await expect(confirm).not.toContainText("Kundfordringar");
    await confirm.getByRole("button", { name: "Bekräfta & bokför" }).click();

    const lines = await ctx.poll("the payment is booked", async () => {
      const rows = await ctx.svc.supabase.sql<{
        account_number: string;
        debit: string;
        credit: string;
        status: string;
        voucher_series: string;
      }>`
        select jel.account_number,
               jel.debit_amount::text  as debit,
               jel.credit_amount::text as credit,
               je.status, je.voucher_series
        from public.journal_entries je
        join public.journal_entry_lines jel on jel.journal_entry_id = je.id
        order by jel.account_number`;
      return rows.unwrap().length === 3 ? rows : null;
    });

    // Bank debited, revenue and output VAT credited, and no 1510 anywhere: the
    // receivable never existed in the books, which is the defining property of
    // the method. Three lines exactly, so a stray 1510 would fail the poll.
    expect(lines[0]?.account_number).toBe("1930");
    expect(lines[0]?.debit).toBe(LINE.total);
    expect(lines[1]?.account_number).toBe("2611");
    expect(lines[1]?.credit).toBe(LINE.vat);
    expect(lines[2]?.account_number).toBe("3001");
    expect(lines[2]?.credit).toBe(LINE.subtotal);
    expect(lines[0]?.status).toBe("posted");
    expect(lines[0]?.voucher_series).toBe("A");

    const balance = await ctx.svc.supabase.sql<{ diff: string }>`
      select (sum(debit_amount) - sum(credit_amount))::text as diff
      from public.journal_entry_lines`;
    expect(balance[0]?.diff).toBe("0");

    const invoice = await ctx.svc.supabase.sql<{ status: string }>`
      select status from public.invoices`;
    expect(invoice[0]?.status).toBe("paid");

    return ctx.parent;
  },
);

/**
 * RED ON PURPOSE, pinning #2019.
 *
 * "Markera som betald" books the entry and flips the status but never writes
 * the payment to the reskontra, so the payment exists as a verifikat and
 * nowhere else. The invoice page then says "Betalt 12 500 kr" and "Inga
 * registrerade betalningar ännu" on the same screen.
 *
 * The cost lands at bokslutet. collectKontantmetodCutoff deliberately includes
 * invoices with status 'paid', because an invoice settled in January was still
 * a fordran on 31 December, and it reads the payment DATE from this table. No
 * row means paid = 0, so a fully paid invoice is carried into the year-end
 * cut-off as outstanding: a kundfordran of 12 500 with 2 500 kr of vilande
 * moms on 2618, for revenue and VAT already booked on 3001 and 2611.
 *
 * Delete this comment and keep the test when #2019 is fixed.
 */
export const theCashPaymentIsRecordedAsAPayment = env.test(
  "the payment is recorded in the reskontra, not only in the ledger (#2019)",
  { dependsOn: paymentBooksRevenueAndVat },
  async (ctx) => {
    const payments = await ctx.svc.supabase.sql<{
      amount: string;
      payment_date: string;
      linked: boolean;
    }>`
      select amount::text as amount, payment_date::text as payment_date,
             journal_entry_id is not null as linked
      from public.invoice_payments`;

    expect(
      payments,
      "a paid invoice has a payment row, or the year-end cut-off double counts it",
    ).toHaveLength(1);
    expect(payments[0]?.amount).toBe(LINE.total);
    expect(payments[0]?.linked).toBe(true);

    return ctx.parent;
  },
);
