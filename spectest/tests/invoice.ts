/**
 * Sending the first customer invoice.
 *
 * Forks from the signed-in company rather than from the bank flow, so it runs
 * in parallel with it. The amounts are chosen to match a payment in the bank
 * fixture (15 000 + 25 % = 18 750), which is what a later payment-matching
 * test will need.
 *
 * What this is really checking is the accounting. An invoice that renders
 * correctly but books the VAT to the wrong account is wrong in the one place
 * the customer cannot see until Skatteverket does.
 */
import { expect } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";
import { enrolMfa } from "./mfa";

const CUSTOMER = {
  name: "Nordic Design AB",
  orgNumber: "5560123456",
  email: "faktura@nordicdesign.test",
};

/** 15 000 excl. VAT at 25 % is 18 750, the amount the bank fixture pays in. */
const LINE = {
  description: "Designarbete augusti",
  unitPrice: "15000",
  subtotal: "15000",
  vat: "3750",
  total: "18750",
};

export const createFirstInvoice = env.test(
  "create the first customer invoice",
  { dependsOn: enrolMfa },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(`${APP_URL}/invoices`);
    // Wait for the page rather than the button: the header renders before the
    // list has resolved, and clicking into it that early does nothing.
    await expect(b.getByText("Din första faktura tar två minuter.")).toBeVisible({
      timeout: 20000,
    });
    await b.getByRole("button", { name: "Ny faktura", exact: true }).click();

    // Onboarding never asks for payment details, so the first invoice is
    // blocked until they exist. The editor says so and offers the form inline,
    // which is the difference between a dead end and a detour.
    await expect(b.getByText(/Betalningsuppgifter saknas/)).toBeVisible();
    await b.getByRole("button", { name: "Lägg till nu" }).click();
    await b.locator("#bankgiro").fill("123-4566");
    await b.getByRole("button", { name: "Spara & fortsätt" }).click();
    await expect(b.getByText("Betalningsuppgifter sparade")).toBeVisible();

    await b.getByRole("button", { name: "+ Skapa kund" }).click();
    await b.locator("#name").fill(CUSTOMER.name);
    await b.locator("#org_number").fill(CUSTOMER.orgNumber);
    await b.locator("#email").fill(CUSTOMER.email);
    await b.getByRole("button", { name: "Spara kund", exact: true }).click();
    await expect(b.getByText(`Org.nr ${CUSTOMER.orgNumber}`)).toBeVisible();

    // The line description is an article search. Enter commits it as free
    // text and moves focus to the price, so the price is typed, not filled.
    await b.locator('input[placeholder^="Skriv fritt"]').fill(LINE.description);
    await b.keyboard.press("Enter");
    // Enter commits the free-text line and the editor moves focus to the price
    // field. Fill that field by name rather than typing at whatever currently
    // has focus: typing before the focus move lands sends the digits nowhere,
    // and the summary then silently stays at zero.
    await b.locator('input[name="items.0.unit_price"]').fill(LINE.unitPrice);

    // 25 % is the default rate and the summary is where the user checks it.
    await expect(b.getByText("Moms 25%")).toBeVisible();
    await expect(b.getByText("18 750 kr").first()).toBeVisible();

    await b.getByRole("button", { name: "Granska & skapa" }).click();
    await expect(b.getByText("Granska uppgifterna innan du bekräftar")).toBeVisible();
    await b.getByRole("button", { name: "Bekräfta & skapa" }).click();

    const invoices = await ctx.poll("the invoice exists", async () => {
      const rows = await ctx.svc.supabase.sql<{
        invoice_number: string;
        status: string;
        subtotal: string;
        vat_amount: string;
        total: string;
      }>`
        select invoice_number, status,
               subtotal::text   as subtotal,
               vat_amount::text as vat_amount,
               total::text      as total
        from public.invoices`;
      return rows.unwrap().length === 1 ? rows : null;
    });

    expect(invoices[0]?.invoice_number).toBe("001");
    // A draft, deliberately: nothing is booked until the invoice is sent, so
    // an unsent invoice must not appear in the books.
    expect(invoices[0]?.status).toBe("draft");
    expect(invoices[0]?.subtotal).toBe(LINE.subtotal);
    expect(invoices[0]?.vat_amount).toBe(LINE.vat);
    expect(invoices[0]?.total).toBe(LINE.total);

    const entries = await ctx.svc.supabase.sql<{ n: number }>`
      select count(*)::int as n from public.journal_entries`;
    expect(entries[0]?.n).toBe(0);

    return ctx.parent;
  },
);

export const sendInvoiceAndBookIt = env.test(
  "mark the invoice as sent and book it",
  { dependsOn: createFirstInvoice },
  async (ctx) => {
    const b = await ctx.browser();

    // The logo prompt follows the first invoice.
    await b.getByRole("button", { name: "Hoppa över" }).click();

    await b.goto(`${APP_URL}/invoices`);
    await b.locator("tr").filter({ hasText: CUSTOMER.name }).first().click();
    await expect(b.getByText("Faktura 001")).toBeVisible({ timeout: 20000 });

    // Marked as sent rather than emailed: the email path needs a configured
    // provider, and what is under test here is the bookkeeping, not Resend.
    await b.getByRole("button", { name: "Fler alternativ" }).click();
    await b.getByRole("menuitem", { name: /Markera som skickad och bokför/ }).click();

    // The verifikat is shown before it is posted, and it names the accounts in
    // words rather than numbers, which is what makes it checkable by someone
    // who is not an accountant.
    const confirm = b.getByRole("dialog");
    await expect(confirm).toContainText("Kundfordringar");
    await expect(confirm).toContainText("Försäljning inom Sverige, 25 % moms");
    await expect(confirm).toContainText("Utgående moms försäljning inom Sverige, 25%");
    // The debit/credit amounts live in editable fields rather than in the
    // dialog's text, so the balance is asserted against the posted entry
    // below instead of scraped off the preview.

    await confirm
      .getByRole("button", { name: "Markera som skickad och bokför", exact: true })
      .click();

    const lines = await ctx.poll("the invoice is booked", async () => {
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
        order by jel.account_number`;
      return rows.unwrap().length === 3 ? rows : null;
    });

    // Kundfordran debited, revenue and output VAT credited. The split matters:
    // 3001 and 2611 feed different boxes of the momsdeklaration, so booking
    // the whole 18 750 as revenue would understate the VAT owed.
    expect(lines[0]?.account_number).toBe("1510");
    expect(lines[0]?.debit).toBe("18750");
    expect(lines[1]?.account_number).toBe("2611");
    expect(lines[1]?.credit).toBe("3750");
    expect(lines[2]?.account_number).toBe("3001");
    expect(lines[2]?.credit).toBe("15000");
    expect(lines[0]?.status).toBe("posted");
    expect(lines[0]?.voucher_series).toBe("A");

    const balance = await ctx.svc.supabase.sql<{ diff: string }>`
      select (sum(debit_amount) - sum(credit_amount))::text as diff
      from public.journal_entry_lines`;
    expect(balance[0]?.diff).toBe("0");

    const invoice = await ctx.svc.supabase.sql<{
      status: string;
      booked: boolean;
    }>`
      select status, journal_entry_id is not null as booked from public.invoices`;
    expect(invoice[0]?.status).toBe("sent");
    expect(invoice[0]?.booked).toBe(true);

    return ctx.parent;
  },
);
