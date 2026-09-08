/**
 * Reverse charge on the PURCHASE side: buying a service from an EU supplier.
 *
 * `reverse-charge.ts` covers selling to an EU business. This is the other
 * direction, and it is the one the VAT reference names as the single
 * highest-error-rate area in Swedish bookkeeping. Two of its listed critical
 * error patterns live here:
 *
 *   1. output VAT must go to 2614 (ruta 30), never 2611 (ruta 10)
 *   2. BOTH sides must be booked; silent netting is prohibited
 *
 * The second is what makes this worth an end-to-end test rather than a unit
 * one. The buyer self-assesses the VAT and deducts it in the same breath, so
 * the net effect on what they pay is exactly zero. A system that "optimised"
 * that into no entry at all would produce a ledger that balances, a supplier
 * debt that is right, and a momsdeklaration missing both ruta 30 and part of
 * ruta 48. Nothing would look wrong until Skatteverket compared the figure
 * with the periodiska sammanställningen the German supplier filed.
 *
 * A 10 000 kr consulting invoice at 25 %:
 *
 *   6540 Konsultarvoden          D 10 000   the actual cost
 *   4535 Inköp tjänster EU 25 %  D 10 000   statistics, feeds ruta 21
 *   4598 Motkonto beräknad moms  K 10 000   so the cost is not counted twice
 *   2645 Beräknad ing. moms      D  2 500
 *   2614 Utg. moms omvänd        K  2 500
 *   2440 Leverantörsskulder      K 10 000
 *
 * The 4535/4598 pair is the part that is easy to leave out and easy to
 * mistake for noise. Without it the VAT lands in ruta 30 and 48 correctly and
 * ruta 21 stays empty, so the return says the buyer owes VAT on an
 * acquisition it never made.
 *
 * Note the supplier debt is the NET: reverse charge means the supplier never
 * invoiced VAT, so 12 500 on 2440 would be paying them money they never asked
 * for.
 */
import { expect } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";
import { enrolMfa } from "./mfa";

const SUPPLIER = {
  name: "Berlin Analytics GmbH",
  expenseAccount: "6540",
};

const INVOICE = {
  number: "DE-2026-88",
  date: "2026-08-03",
  dueDate: "2026-09-02",
  net: "10000",
  /** Self-assessed at 25 %, both directions. */
  vat: "2500",
};

export const registerEuSupplierInvoice = env.test(
  "an EU supplier invoice self-assesses VAT on both sides",
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

    // The supplier's type is what drives the whole treatment. Getting it wrong
    // is not a labelling mistake: it decides whether Swedish VAT is charged,
    // deducted, or self-assessed.
    await supplierDialog.getByRole("combobox").first().click();
    await b.getByRole("option", { name: "EU-företag", exact: true }).click();
    await b.getByRole("button", { name: "Skapa leverantör", exact: true }).click();

    await expect(
      b.getByText("Nästa steg: ange leverantörens fakturanummer."),
    ).toBeVisible({ timeout: 20000 });

    // Picking an EU supplier turns reverse charge on by itself, and says so.
    // Leaving it to the user to remember is how a 25 % Swedish VAT deduction
    // gets claimed on an invoice that never carried any.
    await expect(
      b.getByText("Omvänd skattskyldighet").first(),
      "an EU supplier switches the treatment without being asked twice",
    ).toBeVisible();

    await b.locator("#si-invoice-number").fill(INVOICE.number);
    await b.locator("#si-invoice-date").fill(INVOICE.date);
    await b.locator("#si-due-date").fill(INVOICE.dueDate);
    await b
      .locator('input[placeholder="0,00"]:not(#si-faktura-total)')
      .first()
      .fill(INVOICE.net);

    await b.getByRole("button", { name: "Granska & registrera", exact: true }).click();
    const review = b.getByRole("dialog").last();
    await expect(review).toContainText("Verifikation som bokförs");
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

    // Six lines. Four would mean the ruta 21 statistics pair went missing;
    // three would mean one side of the self-assessment did; two would mean the
    // whole thing was netted away.
    expect(lines[0]?.account_number, "the supplier debt is the net, not the gross").toBe(
      "2440",
    );
    expect(lines[0]?.credit).toBe(INVOICE.net);

    // 2614, not 2611. They feed different boxes: ruta 30 is VAT the buyer owes
    // on an acquisition, ruta 10 is VAT on their own Swedish sales. Putting it
    // in ruta 10 would claim turnover that does not exist.
    expect(lines[1]?.account_number, "output VAT on an acquisition, not on a sale").toBe(
      "2614",
    );
    expect(lines[1]?.credit).toBe(INVOICE.vat);

    expect(lines[2]?.account_number, "the matching deduction").toBe("2645");
    expect(lines[2]?.debit).toBe(INVOICE.vat);

    // The statistics pair, which is what puts the acquisition in ruta 21.
    // They net to zero against each other, so the cost is counted once.
    expect(lines[3]?.account_number, "EU services purchase, the ruta 21 account").toBe(
      "4535",
    );
    expect(lines[3]?.debit).toBe(INVOICE.net);
    expect(lines[4]?.account_number, "and its contra, so the cost is not doubled").toBe(
      "4598",
    );
    expect(lines[4]?.credit).toBe(INVOICE.net);

    // The real cost, on the account the supplier's default put there.
    expect(lines[5]?.account_number).toBe(SUPPLIER.expenseAccount);
    expect(lines[5]?.debit).toBe(INVOICE.net);

    // The cost is counted once despite appearing on two debit lines.
    const cost = await ctx.svc.supabase.sql<{ net: string }>`
      select trim_scale(sum(debit_amount) - sum(credit_amount))::text as net
      from public.journal_entry_lines
      where account_number in ('4535', '4598')`;
    expect(cost[0]?.net, "the statistics pair nets to zero").toBe("0");

    // Both sides present and equal, which is the point: the net effect is zero
    // and it is reached by declaring both, not by declaring neither.
    const vat = await ctx.svc.supabase.sql<{ net: string }>`
      select trim_scale(sum(debit_amount) - sum(credit_amount))::text as net
      from public.journal_entry_lines
      where account_number in ('2614', '2645')`;
    expect(vat[0]?.net, "self-assessed VAT nets to zero across the two accounts").toBe(
      "0",
    );

    return ctx.parent;
  },
);

export const euPurchaseFillsRuta21And30And48 = env.test(
  "the EU purchase fills ruta 21, 30 and 48 rather than the domestic boxes",
  { dependsOn: registerEuSupplierInvoice },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(`${APP_URL}/reports/vat-declaration`);
    await expect(b.getByRole("button", { name: "Redovisningsperiod" })).toBeVisible({
      timeout: 25000,
    });
    await b.getByRole("button", { name: "Redovisningsperiod" }).click();
    await b.getByRole("option", { name: /Kvartal 3 2026/ }).click();
    await expect(b.getByText(/2026-07-01 till 2026-09-30/)).toBeVisible({
      timeout: 20000,
    });

    // Ruta 30 carries the self-assessed output VAT, and ruta 48 the matching
    // deduction. Both must appear: reporting only the deduction understates
    // the VAT owed, and reporting only the charge overstates it.
    await expect(
      b.getByRole("row", { name: /30.*2 500,00 kr/ }),
      "the self-assessed VAT is declared as owed",
    ).toBeVisible();
    await expect(
      b.getByRole("row", { name: /48.*2 500,00 kr/ }),
      "and deducted in the same return",
    ).toBeVisible();

    // Nothing in the domestic boxes. This company made no Swedish sale and
    // paid no Swedish input VAT, so 10 and 05 must be empty.
    const domestic = await ctx.svc.supabase.sql<{ n: number }>`
      select count(*)::int as n from public.journal_entry_lines
      where account_number in ('2611', '2641', '3001')`;
    expect(
      domestic[0]?.n,
      "an EU acquisition touches none of the domestic VAT accounts",
    ).toBe(0);

    // Net VAT to pay is zero: what is owed and what is deducted are the same
    // number, which is the whole design of the reverse charge.
    await expect(b.getByRole("row", { name: /Summa utgående moms 2 500,00 kr/ })).toBeVisible();

    return ctx.parent;
  },
);
