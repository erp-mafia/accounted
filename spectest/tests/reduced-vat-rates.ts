/**
 * The 12 % and 6 % rates, and the rutor they fill.
 *
 * The rest of the suite invoices at 25 %. The reduced rates are where the
 * quiet errors live, because a 12 % sale booked as if it were 25 % still
 * balances, still foots, and still submits: it just declares the wrong amount
 * in the wrong box. Each rate has its own revenue account and its own output
 * VAT account, and each output account feeds a different ruta:
 *
 *   25 %  3001 / 2611  →  ruta 10
 *   12 %  3002 / 2621  →  ruta 11
 *    6 %  3003 / 2631  →  ruta 12
 *
 * One invoice with one line at each reduced rate: a hotel night at 12 % and a
 * book at 6 %, both still at those rates in 2026 (food moved from 12 % to 6 %
 * in April 2026, which is exactly why the line descriptions here avoid it).
 *
 * Forks from the sent invoice, so the company already carries 3 750 kr of
 * 25 % output VAT in ruta 10. That is deliberate: it means a mapping that
 * dumped the reduced-rate VAT into ruta 10 would show up as a changed number
 * rather than as a new one.
 */
import { expect } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";
import { sendInvoiceAndBookIt } from "./invoice";

const HOTEL = { description: "Hotellnatt konferens", price: "1000", vat: "120" };
const BOOK = { description: "Facklitteratur", price: "500", vat: "30" };
/** 1 000 + 120 + 500 + 30. */
const TOTAL = "1650";

export const invoiceWithReducedRates = env.test(
  "an invoice can carry 12 % and 6 % on separate lines",
  { dependsOn: sendInvoiceAndBookIt },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(`${APP_URL}/invoices`);
    await b.getByRole("button", { name: "Ny faktura", exact: true }).click();

    await b.getByRole("combobox").first().click();
    await b.getByRole("option", { name: /Nordic Design AB/ }).click();

    await b.locator('input[placeholder^="Skriv fritt"]').fill(HOTEL.description);
    await b.keyboard.press("Enter");
    await b.locator('input[name="items.0.unit_price"]').fill(HOTEL.price);
    await b.getByRole("combobox", { name: "Moms" }).first().click();
    await b.getByRole("option", { name: "12%", exact: true }).click();

    // Wait for the first line to be committed before starting the second.
    // The editor re-renders as the rate is applied, and a description typed
    // into the previous render is discarded: the row never materialises and
    // items.1.unit_price does not exist.
    await expect(b.getByText("Moms 12%")).toBeVisible();

    // The next line is added by typing into the empty row that is always
    // there, the same way the first one was: there is no "add row" button.
    await b.locator('input[placeholder^="Skriv fritt"]').fill(BOOK.description);
    await b.keyboard.press("Enter");
    await b.locator('input[name="items.1.unit_price"]').fill(BOOK.price);
    await b.getByRole("combobox", { name: "Moms" }).last().click();
    await b.getByRole("option", { name: "6%", exact: true }).click();

    // Each rate is summarised separately. One combined "Moms" line would hide
    // exactly the split the momsdeklaration needs.
    const editor = b.getByRole("dialog");
    await expect(editor, "the summary splits VAT per rate").toContainText("Moms 12%");
    await expect(editor).toContainText("Moms 6%");

    await b.getByRole("button", { name: "Granska & skapa" }).click();
    await b.getByRole("button", { name: "Bekräfta & skapa" }).click();

    const invoice = await ctx.poll("the invoice exists", async () => {
      const rows = await ctx.svc.supabase.sql<{
        invoice_number: string;
        vat_amount: string;
        total: string;
      }>`
        select invoice_number,
               trim_scale(vat_amount)::text as vat_amount,
               trim_scale(total)::text      as total
        from public.invoices where invoice_number = '002'`;
      return rows.unwrap().length === 1 ? rows : null;
    });
    // 120 + 30, not 1 500 × 25 % = 375.
    expect(invoice[0]?.vat_amount).toBe("150");
    expect(invoice[0]?.total).toBe(TOTAL);

    return ctx.parent;
  },
);

export const reducedRatesBookAndDeclareSeparately = env.test(
  "each rate books to its own accounts and lands in its own ruta",
  { dependsOn: invoiceWithReducedRates },
  async (ctx) => {
    const b = await ctx.browser();

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
      return rows.unwrap().length === 5 ? rows : null;
    });

    // Five lines: one receivable and a revenue/VAT pair per rate. Collapsing
    // the two rates onto 3001/2611 would give three lines that balanced just
    // as well and declared 375 kr of VAT that was never charged.
    expect(lines[0]?.account_number).toBe("1510");
    expect(lines[0]?.debit).toBe(TOTAL);
    expect(lines[1]?.account_number, "12 % output VAT").toBe("2621");
    expect(lines[1]?.credit).toBe(HOTEL.vat);
    expect(lines[2]?.account_number, "6 % output VAT").toBe("2631");
    expect(lines[2]?.credit).toBe(BOOK.vat);
    expect(lines[3]?.account_number, "12 % revenue").toBe("3002");
    expect(lines[3]?.credit).toBe(HOTEL.price);
    expect(lines[4]?.account_number, "6 % revenue").toBe("3003");
    expect(lines[4]?.credit).toBe(BOOK.price);

    // And the declaration. The company is on quarterly VAT and both invoices
    // are dated today, so the quarter holds 25 %, 12 % and 6 % at once.
    await b.goto(`${APP_URL}/reports/vat-declaration`);
    await expect(b.getByRole("button", { name: "Redovisningsperiod" })).toBeVisible({
      timeout: 25000,
    });
    await b.getByRole("button", { name: "Redovisningsperiod" }).click();
    await b.getByRole("option", { name: /Kvartal 3 2026/ }).click();
    await expect(b.getByText(/2026-07-01 till 2026-09-30/)).toBeVisible({
      timeout: 20000,
    });

    // Three rutor, three amounts, whole rows. Ruta 10 still holding exactly
    // 3 750 is the assertion that catches a reduced rate leaking into the
    // standard box.
    await expect(
      b.getByRole("row", { name: /10Utgående moms 25% 3 750,00 kr/ }),
      "the 25 % box is untouched by the reduced-rate sale",
    ).toBeVisible();
    await expect(
      b.getByRole("row", { name: /11Utgående moms 12% 120,00 kr/ }),
    ).toBeVisible();
    await expect(
      b.getByRole("row", { name: /12Utgående moms 6% 30,00 kr/ }),
    ).toBeVisible();

    // The taxable base is the sum of all three sales, 15 000 + 1 000 + 500.
    await expect(
      b.getByRole("row", { name: /05Momspliktig försäljning 16 500,00 kr/ }),
      "every taxable sale counts towards the base, whatever its rate",
    ).toBeVisible();

    return ctx.parent;
  },
);
