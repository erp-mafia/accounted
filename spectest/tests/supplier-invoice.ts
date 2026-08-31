/**
 * A supplier invoice, from arrival to the payment file.
 *
 * Forks from the signed-in company alongside the customer-invoice branch, so
 * the two run in parallel and neither sees the other's ledger.
 *
 * The last step is the interesting one. Generating a pain.001 needs data that
 * onboarding never collects, and the app refuses to produce a file it knows the
 * bank would reject rather than emitting one and letting the customer discover
 * it at the counter. That refusal is what the final test pins.
 */
import { expect } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";
import { enrolMfa } from "./mfa";

const SUPPLIER = {
  name: "Hyresvärden Fastighets AB",
  bankgiro: "123-4566",
  expenseAccount: "5010",
};

const INVOICE = {
  number: "2026-4471",
  date: "2026-08-01",
  dueDate: "2026-08-31",
  net: "12000",
  vat: "3000",
  total: "15000",
};

export const registerSupplierInvoice = env.test(
  "register a supplier invoice and book it",
  { dependsOn: enrolMfa },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(`${APP_URL}/supplier-invoices`);
    await b.getByRole("button", { name: "Registrera faktura", exact: true }).first().click();

    // No suppliers yet, so the picker offers to create one inline.
    await b.getByRole("button", { name: "Välj leverantör", exact: true }).click();
    await expect(b.getByText("Inga leverantörer än")).toBeVisible();
    await b.getByText("+ Lägg till ny leverantör...").click();

    // Bankgiro and a default expense account are both set here. The bankgiro
    // is what the payment file pays to; the account is what the invoice books
    // against without the user having to pick it every time.
    const supplierDialog = b.getByRole("dialog").last();
    await supplierDialog.locator("input").first().fill(SUPPLIER.name);
    await supplierDialog.locator('input[placeholder="XXX-XXXX"]').fill(SUPPLIER.bankgiro);
    await supplierDialog
      .locator('input[placeholder="t.ex. 5010"]')
      .fill(SUPPLIER.expenseAccount);
    await b.getByRole("button", { name: "Skapa leverantör", exact: true }).click();

    // Picking the supplier fills the kontering row from its default account,
    // and the form's own next-step hint is what says that has happened. Filling
    // the amount before it does targets a field that is not there yet.
    await expect(
      b.getByText("Nästa steg: ange leverantörens fakturanummer."),
    ).toBeVisible({ timeout: 20000 });

    await b.locator("#si-invoice-number").fill(INVOICE.number);
    await b.locator("#si-invoice-date").fill(INVOICE.date);
    await b.locator("#si-due-date").fill(INVOICE.dueDate);

    // The kontering row is pre-filled from the supplier's default account, so
    // only the amount is left. 25 % is the default rate. Excluding
    // si-faktura-total from the selector matters: it shares the "0,00"
    // placeholder and is the optional check-total field, not the line amount.
    await b
      .locator('input[placeholder="0,00"]:not(#si-faktura-total)')
      .first()
      .fill(INVOICE.net);
    await expect(b.getByText("15 000 kr").first()).toBeVisible({ timeout: 15000 });

    await b.getByRole("button", { name: "Granska & registrera", exact: true }).click();

    // The verifikat is shown before it is posted, account by account.
    const review = b.getByRole("dialog").last();
    await expect(review).toContainText("Verifikation som bokförs");
    await expect(review).toContainText("Ingående moms 25%");

    await b.getByRole("button", { name: "Bekräfta & registrera", exact: true }).click();

    const lines = await ctx.poll("the supplier invoice is booked", async () => {
      const rows = await ctx.svc.supabase.sql<{
        voucher_series: string;
        voucher_number: number;
        source_type: string;
        account_number: string;
        debit: string;
        credit: string;
      }>`
        select je.voucher_series, je.voucher_number, je.source_type,
               jel.account_number,
               jel.debit_amount::text  as debit,
               jel.credit_amount::text as credit
        from public.journal_entries je
        join public.journal_entry_lines jel on jel.journal_entry_id = je.id
        order by jel.account_number`;
      return rows.unwrap().length === 3 ? rows : null;
    });

    // Cost and deductible input VAT debited, the debt to the supplier
    // credited. Booking the gross 15 000 to 5010 would inflate the cost and
    // lose 3 000 kr of reclaimable VAT.
    expect(lines[0]?.account_number).toBe("2440");
    expect(lines[0]?.credit).toBe(INVOICE.total);
    expect(lines[1]?.account_number).toBe("2641");
    expect(lines[1]?.debit).toBe(INVOICE.vat);
    expect(lines[2]?.account_number).toBe("5010");
    expect(lines[2]?.debit).toBe(INVOICE.net);
    expect(lines[0]?.source_type).toBe("supplier_invoice_registered");
    expect(lines[0]?.voucher_series).toBe("A");
    expect(lines[0]?.voucher_number).toBe(1);

    const invoice = await ctx.svc.supabase.sql<{
      supplier_invoice_number: string;
      status: string;
      total: string;
      due_date: string;
    }>`
      select supplier_invoice_number, status, total::text as total,
             due_date::text as due_date
      from public.supplier_invoices`;
    expect(invoice[0]?.supplier_invoice_number).toBe(INVOICE.number);
    expect(invoice[0]?.total).toBe(INVOICE.total);
    expect(invoice[0]?.due_date).toBe(INVOICE.dueDate);
    // Registered, not approved: booking it does not authorise paying it.
    expect(invoice[0]?.status).toBe("registered");

    return ctx.parent;
  },
);

export const approveForPayment = env.test(
  "approve the invoice for payment",
  { dependsOn: registerSupplierInvoice },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(`${APP_URL}/supplier-invoices`);
    await b.getByRole("button", { name: "Godkänn", exact: true }).click();

    await expect(b.getByText("Godkänd")).toBeVisible({ timeout: 20000 });

    const invoice = await ctx.svc.supabase.sql<{ status: string }>`
      select status from public.supplier_invoices`;
    expect(invoice[0]?.status).toBe("approved");

    return ctx.parent;
  },
);

export const paymentFileRefusesIncompleteData = env.test(
  "the payment file refuses to generate without the data the bank needs",
  { dependsOn: approveForPayment },
  async (ctx) => {
    const b = await ctx.browser();

    await b.getByRole("checkbox", { name: "Välj faktura för betalfil" }).click();
    await expect(b.getByText("1 faktura vald")).toBeVisible();
    await b.getByRole("button", { name: "Skapa betalfil", exact: true }).click();

    const dialog = b.getByRole("dialog").last();

    // What it can already fill in: who is paid, on what reference, how much.
    await expect(dialog).toContainText(`BG ${SUPPLIER.bankgiro}`);
    await expect(dialog).toContainText(INVOICE.number);
    await expect(dialog).toContainText(/15\s000 kr/);
    await expect(dialog).toContainText("ISO 20022-format (pain.001)");

    // And what it cannot. Both of these are required by the format and neither
    // is collected anywhere in onboarding, so this dialog is where a customer
    // paying their first supplier finds out.
    await expect(
      dialog,
      "the company's own IBAN is named as missing, with where to set it",
    ).toContainText("Företagets IBAN saknas");
    await expect(dialog).toContainText("Inställningar → Fakturering");
    await expect(dialog).toContainText("Ort saknas på leverantören");

    // The refusal itself. A generated-but-invalid pain.001 would be discovered
    // by the bank, after the due date, with no clue what was wrong: refusing
    // up front is the safe failure.
    await expect(
      b.getByRole("button", { name: "Skapa och ladda ner" }),
      "generating is blocked until the file would actually be payable",
    ).toBeDisabled();

    // Nothing was created.
    const batches = await ctx.svc.supabase.sql<{ n: number }>`
      select count(*)::int as n from public.supplier_payment_batches`;
    expect(batches[0]?.n).toBe(0);

    return ctx.parent;
  },
);
