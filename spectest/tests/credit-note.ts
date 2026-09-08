/**
 * Crediting an invoice that is already in the books.
 *
 * A posted invoice cannot be edited. BFL 5 kap. 5 § allows a correction only
 * as a separate document that points back at the verifikat it corrects, and a
 * credit note is that document on the sales side. What makes it worth testing
 * is that the app has to get three things right at once: the credit note is a
 * new numbered document rather than a change to the old one, the reversal is
 * booked as its own verifikat with the debit and credit sides swapped, and the
 * new verifikat names the old one.
 *
 * Forks from the sent and booked invoice (1510 D 18 750, 3001 K 15 000,
 * 2611 K 3 750), so the expected reversal is exactly that entry mirrored.
 */
import { expect } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";
import { sendInvoiceAndBookIt } from "./invoice";

const ORIGINAL = {
  number: "001",
  subtotal: "15000",
  vat: "3750",
  total: "18750",
};

export const createCreditNote = env.test(
  "credit a booked invoice with a separate document",
  { dependsOn: sendInvoiceAndBookIt },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(`${APP_URL}/invoices`);
    await b.locator("tr").filter({ hasText: "Nordic Design AB" }).first().click();
    await expect(b.getByText(`Faktura ${ORIGINAL.number}`)).toBeVisible({
      timeout: 20000,
    });

    await b.getByRole("button", { name: "Fler alternativ" }).click();
    await b.getByRole("menuitem", { name: /^Skapa kreditfaktura/ }).click();

    await expect(b.getByText("Kreditfakturan skapas som utkast")).toBeVisible({
      timeout: 20000,
    });

    // The rest of the explanation sits behind the help button rather than in
    // the page, so open it: what matters is that the answer is reachable, not
    // that the string exists in the translation file.
    await b.getByRole("button", { name: "Hjälp" }).first().click();
    await expect(
      b.getByText(/Originalfakturan markeras som krediterad först när/),
      "the help explains that the original changes only once the credit note is sent",
    ).toBeVisible();
    await expect(b.getByText(/Alla belopp blir negativa/)).toBeVisible();
    await b.keyboard.press("Escape");

    // Its own number in its own series, not a reuse of the original's.
    await expect(b.getByText(/Kreditfakturanummer: KR-/)).toBeVisible();

    // The preview negates the quantity rather than the price, which is what
    // keeps the à-pris on the credit note equal to the à-pris on the original
    // and makes the two documents readable side by side.
    await expect(b.getByRole("cell", { name: "-1", exact: true })).toBeVisible();

    // Typing the invoice number is the confirmation. Deliberate friction:
    // crediting is not undoable and the number is the thing the user has to
    // have actually looked at.
    await b.locator("#confirm-invoice-number").fill(ORIGINAL.number);
    await b
      .getByRole("button", { name: "Skapa kreditfaktura", exact: true })
      .click();

    const invoices = await ctx.poll("the credit note exists", async () => {
      const rows = await ctx.svc.supabase.sql<{
        invoice_number: string;
        status: string;
        total: string;
        credits: string | null;
      }>`
        select i.invoice_number, i.status, i.total::text as total,
               o.invoice_number as credits
        from public.invoices i
        left join public.invoices o on o.id = i.credited_invoice_id
        order by i.created_at`;
      return rows.unwrap().length === 2 ? rows : null;
    });

    // Two documents, not one edited one. The original is untouched and still
    // sent; the credit note is a draft carrying the negated amounts.
    expect(invoices[0]?.invoice_number).toBe(ORIGINAL.number);
    expect(invoices[0]?.status, "the original is untouched until the credit note is sent").toBe(
      "sent",
    );
    expect(invoices[1]?.status).toBe("draft");
    expect(invoices[1]?.total).toBe(`-${ORIGINAL.total}`);
    expect(invoices[1]?.credits, "the credit note points at the invoice it credits").toBe(
      ORIGINAL.number,
    );

    // And nothing new is booked yet: the original's three lines, unchanged.
    const lines = await ctx.svc.supabase.sql<{ n: number }>`
      select count(*)::int as n from public.journal_entry_lines`;
    expect(lines[0]?.n).toBe(3);

    return ctx.parent;
  },
);

export const sendingTheCreditNoteReversesTheEntry = env.test(
  "sending the credit note books the reversal and names the original verifikat",
  { dependsOn: createCreditNote },
  async (ctx) => {
    const b = await ctx.browser();

    const creditNote = await ctx.svc.supabase.sql<{ id: string }>`
      select id::text as id from public.invoices
      where credited_invoice_id is not null`;
    await b.goto(`${APP_URL}/invoices/${creditNote[0]!.id.unwrap()}`);

    await b.getByRole("button", { name: "Fler alternativ" }).click();
    await b.getByRole("menuitem", { name: /^Markera som skickad/ }).click();
    const confirm = b.getByRole("dialog");
    await confirm
      .getByRole("button", { name: /^Markera som skickad/ })
      .click();

    const lines = await ctx.poll("the reversal is booked", async () => {
      const rows = await ctx.svc.supabase.sql<{
        account_number: string;
        debit: string;
        credit: string;
        voucher_number: number;
        description: string;
      }>`
        select jel.account_number,
               jel.debit_amount::text  as debit,
               jel.credit_amount::text as credit,
               je.voucher_number, je.description
        from public.journal_entries je
        join public.journal_entry_lines jel on jel.journal_entry_id = je.id
        where je.voucher_number = 2
        order by jel.account_number`;
      return rows.unwrap().length === 3 ? rows : null;
    });

    // The original mirrored: revenue and output VAT debited back, the
    // receivable credited away. Booking this as a negative copy of the
    // original entry instead would leave the verifikat unbalanced and the
    // momsdeklaration short by 3 750.
    expect(lines[0]?.account_number).toBe("1510");
    expect(lines[0]?.credit).toBe(ORIGINAL.total);
    expect(lines[1]?.account_number).toBe("2611");
    expect(lines[1]?.debit).toBe(ORIGINAL.vat);
    expect(lines[2]?.account_number).toBe("3001");
    expect(lines[2]?.debit).toBe(ORIGINAL.subtotal);

    // BFL 5 kap. 5 §: the correction points back at the verifikat it corrects.
    // The invoice number alone would not do it, because it does not identify
    // an entry in the verifikationsserie.
    expect(
      lines[0]?.description,
      "the correcting verifikat names the verifikat it corrects, not just the invoice",
    ).toContain("avser verifikation A-1");

    // Nothing was deleted or rewritten: the original entry is still there,
    // still posted, and the books now hold both sides of the correction.
    const entries = await ctx.svc.supabase.sql<{
      voucher_number: number;
      status: string;
    }>`
      select voucher_number, status from public.journal_entries
      order by voucher_number`;
    expect(entries).toHaveLength(2);
    expect(entries[0]?.voucher_number).toBe(1);
    expect(entries[0]?.status).toBe("posted");
    expect(entries[1]?.status).toBe("posted");

    const balance = await ctx.svc.supabase.sql<{ diff: string }>`
      select (sum(debit_amount) - sum(credit_amount))::text as diff
      from public.journal_entry_lines`;
    expect(balance[0]?.diff).toBe("0");

    // Revenue and VAT net to zero across the pair, which is the point of the
    // whole exercise: the sale is undone in the books without either document
    // being touched.
    const net = await ctx.svc.supabase.sql<{ net: string }>`
      select (sum(credit_amount) - sum(debit_amount))::text as net
      from public.journal_entry_lines
      where account_number in ('3001', '2611')`;
    expect(net[0]?.net).toBe("0");

    // The document itself renders. Negative amounts are where an invoice PDF
    // breaks in ways unit tests do not reach: the whole react-pdf tree runs
    // here, not just the number formatter. Fetched from inside the page so it
    // carries the session, the way the download button does.
    const pdf = await b.evaluate(
      "download the credit note PDF",
      `fetch('/api/invoices/${creditNote[0]!.id.unwrap()}/pdf')
         .then((r) => r.ok ? r.blob() : Promise.reject(new Error('HTTP ' + r.status)))
         .then((blob) => blob.type + ' ' + (blob.size > 1000 ? 'nonempty' : 'tiny:' + blob.size))`,
    );
    expect(pdf, "the credit note renders as a real PDF document").toBe(
      "application/pdf nonempty",
    );

    const original = await ctx.poll("the original is marked credited", async () => {
      const rows = await ctx.svc.supabase.sql<{ status: string }>`
        select status from public.invoices where credited_invoice_id is null`;
      return rows.unwrap()[0]?.status === "credited" ? rows : null;
    });
    expect(original[0]?.status).toBe("credited");

    return ctx.parent;
  },
);
