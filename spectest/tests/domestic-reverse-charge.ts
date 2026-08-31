/**
 * Byggtjänster: omvänd skattskyldighet between two Swedish companies.
 *
 * `purchase-reverse-charge.ts` covers the EU case. This is the domestic one,
 * and it is a different rule with a different account. Since 2007 a
 * construction service sold between businesses in the building trade carries
 * no VAT on the invoice: the buyer self-assesses it, exactly as with an EU
 * acquisition, but the deductible leg lands on 2647 rather than 2645.
 *
 * Getting 2645 here instead would put a domestic purchase in the box for
 * foreign acquisitions. The amounts would be identical and the ledger would
 * balance; only the momsdeklaration would be wrong, which is the failure this
 * whole area specialises in.
 *
 * An 80 000 kr subcontractor invoice at 25 %:
 *
 *   4600 Underentreprenader    D 80 000   the actual cost
 *   4425 Inköp tjänster i SE    D 80 000   statistics, the domestic RC box
 *   4598 Motkonto               K 80 000   so the cost is not counted twice
 *   2647 Beräknad ing. moms     D 20 000   the domestic deductible leg
 *   2614 Utg. moms omvänd       K 20 000
 *   2440 Leverantörsskulder     K 80 000
 *
 * Throwing the switch is what moves the purchase onto 4425: the account the
 * supplier's default put there, 4600, stays as the cost, and the restatement
 * rides alongside it. Same shape as 4535/4598 on the EU side.
 */
import { expect } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";
import { enrolMfa } from "./mfa";

const SUPPLIER = {
  name: "Byggpartner Syd AB",
  expenseAccount: "4600",
};

const INVOICE = {
  number: "BP-2026-311",
  date: "2026-08-04",
  dueDate: "2026-09-03",
  net: "80000",
  vat: "20000",
};

export const domesticReverseChargeUses2647 = env.test(
  "a Swedish byggtjänst self-assesses VAT on 2647, not 2645",
  { dependsOn: enrolMfa },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(`${APP_URL}/supplier-invoices`);
    await b
      .getByRole("button", { name: "Registrera faktura", exact: true })
      .first()
      .click();

    await b.getByRole("button", { name: "Välj leverantör", exact: true }).click();
    await b.getByText("+ Lägg till ny leverantör...").click();

    const supplierDialog = b.getByRole("dialog").last();
    await supplierDialog.locator("input").first().fill(SUPPLIER.name);
    await supplierDialog
      .locator('input[placeholder="t.ex. 5010"]')
      .fill(SUPPLIER.expenseAccount);
    // A Swedish supplier, deliberately: this is what separates the domestic
    // rule from the EU one, and it is why the switch below has to be thrown
    // by hand rather than derived from the counterparty's country.
    await b.getByRole("button", { name: "Skapa leverantör", exact: true }).click();

    await expect(
      b.getByText("Nästa steg: ange leverantörens fakturanummer."),
    ).toBeVisible({ timeout: 20000 });

    await b.locator("#si-invoice-number").fill(INVOICE.number);
    await b.locator("#si-invoice-date").fill(INVOICE.date);
    await b.locator("#si-due-date").fill(INVOICE.dueDate);
    await b
      .locator('input[placeholder="0,00"]:not(#si-faktura-total)')
      .first()
      .fill(INVOICE.net);

    // Nothing about a Swedish supplier says "byggtjänst", so the app cannot
    // and does not guess: the user states it. The switch lives under the
    // defaults, which is the right place for something most invoices never
    // touch, and the help text names both cases it covers.
    await b.getByRole("button", { name: /Ändra förval/ }).click();
    await expect(
      b.getByText(/Köp inom EU eller byggtjänster/),
      "the switch explains when it applies rather than assuming",
    ).toBeVisible();
    await b.locator("#reverse_charge").click();

    await b.getByRole("button", { name: "Granska & registrera", exact: true }).click();
    await b.getByRole("button", { name: "Bekräfta & registrera", exact: true }).click();

    const lines = await ctx.poll("the invoice is booked", async () => {
      const rows = await ctx.svc.supabase.sql<{
        account_number: string;
        debit: string;
        credit: string;
      }>`
        select account_number,
               trim_scale(debit_amount)::text  as debit,
               trim_scale(credit_amount)::text as credit
        from public.journal_entry_lines
        order by account_number`;
      return rows.unwrap().length === 6 ? rows : null;
    });


    // The supplier debt is the net: no VAT was ever invoiced, so 100 000 on
    // 2440 would be paying the subcontractor money they did not ask for.
    expect(lines[0]?.account_number).toBe("2440");
    expect(lines[0]?.credit).toBe(INVOICE.net);

    expect(lines[1]?.account_number, "self-assessed output VAT").toBe("2614");
    expect(lines[1]?.credit).toBe(INVOICE.vat);

    // 2647, the domestic leg. 2645 is for acquisitions from abroad, and using
    // it here would file a Swedish purchase as a foreign one.
    expect(
      lines[2]?.account_number,
      "the deductible leg is the domestic account, not the foreign one",
    ).toBe("2647");
    expect(lines[2]?.debit).toBe(INVOICE.vat);

    // The statistics pair, the domestic counterpart of 4535/4598 in the EU
    // case. Turning the switch on moved the purchase onto 4425, which is what
    // puts it in the box for domestic reverse-charge purchases; the contra
    // keeps the cost from being counted twice against 4600.
    expect(
      lines[3]?.account_number,
      "the purchase is restated on the domestic reverse-charge account",
    ).toBe("4425");
    expect(lines[3]?.debit).toBe(INVOICE.net);
    expect(lines[4]?.account_number).toBe("4598");
    expect(lines[4]?.credit).toBe(INVOICE.net);

    // And the real cost, on the account the supplier's default put there.
    expect(lines[5]?.account_number).toBe(SUPPLIER.expenseAccount);
    expect(lines[5]?.debit).toBe(INVOICE.net);

    const cost = await ctx.svc.supabase.sql<{ net: string }>`
      select trim_scale(sum(debit_amount) - sum(credit_amount))::text as net
      from public.journal_entry_lines
      where account_number in ('4425', '4598')`;
    expect(cost[0]?.net, "the statistics pair nets to zero").toBe("0");

    // Both sides declared, netting to zero, which is the design of the
    // reverse charge and not an excuse to declare neither.
    const vat = await ctx.svc.supabase.sql<{ net: string }>`
      select trim_scale(sum(debit_amount) - sum(credit_amount))::text as net
      from public.journal_entry_lines
      where account_number in ('2614', '2647')`;
    expect(vat[0]?.net).toBe("0");

    // And no 2645 anywhere: that is the assertion the account numbers above
    // only imply.
    const foreign = await ctx.svc.supabase.sql<{ n: number }>`
      select count(*)::int as n from public.journal_entry_lines
      where account_number = '2645'`;
    expect(foreign[0]?.n, "nothing was booked as a foreign acquisition").toBe(0);

    return ctx.parent;
  },
);
