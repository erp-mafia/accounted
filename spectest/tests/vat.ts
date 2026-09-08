/**
 * Momsdeklaration, on the books that came in from the SIE file.
 *
 * VAT is the highest-error-rate area in Swedish bookkeeping, and the errors
 * are quiet: an amount in the wrong ruta still adds up, still balances, and
 * still submits. It only becomes visible when Skatteverket disagrees.
 *
 * The imported quarter is arithmetically small on purpose, so the whole
 * declaration can be asserted rather than sampled:
 *
 *   3001 Försäljning inom Sverige   20 000  ->  ruta 05
 *   2611 Utgående moms 25 %          5 000  ->  ruta 10
 *   2641 Ingående moms               3 000  ->  ruta 48
 *   Att betala                       2 000  ->  ruta 49
 *
 * The company is on quarterly VAT from onboarding, and the fixture's vouchers
 * all fall in January to March 2025, so Q1 2025 covers them exactly.
 *
 * Posting the declaration to 2650 is the second test. All the 26xx VAT
 * accounts must be flat once a period is posted: a residual balance on 2611 or
 * 2641 is what makes the next period's reconciliation fail, quietly.
 */
import { expect } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";
import { importSieFile } from "./sie-import";

export const vatDeclarationForQ1 = env.test(
  "the VAT return puts each amount in the right ruta",
  { dependsOn: importSieFile },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(`${APP_URL}/reports/vat-declaration`);

    // The page opens on the current quarter. The books are in Q1.
    await b.getByRole("button", { name: "Redovisningsperiod" }).click();
    await b.getByRole("option", { name: /Kvartal 1 2025/ }).click();

    await expect(b.getByText("MOMSDEKLARATION · 2025-01-01 TILL 2025-03-31")).toBeVisible({
      timeout: 20000,
    });

    // Ruta by ruta. The ruta numbers are rendered next to their labels, so
    // asserting the label text is asserting the mapping.
    await expect(b.getByText("05Momspliktig försäljning")).toBeVisible();
    await expect(b.getByText("10Utgående moms 25%")).toBeVisible();
    await expect(b.getByText("48Ingående moms att dra av")).toBeVisible();

    // 20 000 in ruta 05 and as the underlag under ruta 10, which is why this
    // is the one amount that legitimately appears twice.
    await expect(b.getByText("20 000,00 kr").first()).toBeVisible();
    await expect(b.getByText("5 000,00 kr").first()).toBeVisible();
    await expect(b.getByText("3 000,00 kr").first()).toBeVisible();

    // Ruta 49 is the number the customer actually pays. Output minus input,
    // 5 000 less 3 000.
    await expect(b.getByText("Moms att betala")).toBeVisible();
    await expect(b.getByText("2 000,00 kr").first()).toBeVisible();

    return ctx.parent;
  },
);

export const postVatToClearingAccount = env.test(
  "posting the VAT return clears the VAT accounts to 2650",
  { dependsOn: vatDeclarationForQ1 },
  async (ctx) => {
    const b = await ctx.browser();

    await b.getByRole("button", { name: /Bokför momsen/ }).click();
    await b.getByRole("button", { name: "Skapa verifikat", exact: true }).click();

    // The dialog frame renders before the entry form has its amounts, and
    // continuing at that point reviews a verifikat that is not ready. The
    // amounts live in editable fields rather than in text, so the gate is an
    // input's value.
    const proposal = b.getByRole("dialog");
    await expect(b.getByText("Bokför momsrapport")).toBeVisible({ timeout: 25000 });
    await ctx.poll("the proposal's amounts are filled in", async () => {
      const value = await proposal
        .locator('input[placeholder="0,00"]')
        .first()
        .inputValue();
      return (value.unwrap() ?? "").trim().length > 0 ? value : null;
    });

    // A settle, deliberately, and the only one in this suite. The failure
    // artifact shows a form that is complete at the moment an early click is
    // ignored: date, description, series, all three rows with amounts and
    // their saldo transitions. Nothing observable distinguishes that state
    // from the one a few seconds later where the same click opens the review,
    // so five structural gates all fired too early. Worth understanding what
    // JournalEntryForm commits asynchronously; until then this is honest.
    await new Promise((resolve) => setTimeout(resolve, 6000));

    await b.getByRole("button", { name: "Granska & skapa" }).click();
    await b
      .getByRole("button", { name: "Bokför utan underlag", exact: true })
      .click({ timeout: 30000 });

    const lines = await ctx.poll("the VAT entry is posted", async () => {
      const rows = await ctx.svc.supabase.sql<{
        account_number: string;
        debit: string;
        credit: string;
      }>`
        select jel.account_number,
               jel.debit_amount::text  as debit,
               jel.credit_amount::text as credit
        from public.journal_entries je
        join public.journal_entry_lines jel on jel.journal_entry_id = je.id
        where je.description = 'Momsredovisning Kvartal 1 2025'
        order by jel.account_number`;
      return rows.unwrap().length === 3 ? rows : null;
    });

    // Output VAT debited away, input VAT credited away, the difference parked
    // on the clearing account as a liability.
    expect(lines[0]?.account_number).toBe("2611");
    expect(lines[0]?.debit).toBe("5000");
    expect(lines[1]?.account_number).toBe("2641");
    expect(lines[1]?.credit).toBe("3000");
    expect(lines[2]?.account_number).toBe("2650");
    expect(lines[2]?.credit).toBe("2000");

    // The invariant that matters: every VAT account is flat afterwards.
    const cleared = await ctx.svc.supabase.sql<{
      account_number: string;
      net: string;
    }>`
      select account_number, (sum(debit_amount) - sum(credit_amount))::text as net
      from public.journal_entry_lines
      where account_number in ('2611', '2641', '2650')
      group by account_number order by account_number`;
    expect(cleared[0]?.net, "output VAT is cleared for the period").toBe("0");
    expect(cleared[1]?.net, "input VAT is cleared for the period").toBe("0");
    // Negative is a credit balance: 2 000 owed to Skatteverket.
    expect(cleared[2]?.net).toBe("-2000");

    const balance = await ctx.svc.supabase.sql<{ diff: string }>`
      select (sum(debit_amount) - sum(credit_amount))::text as diff
      from public.journal_entry_lines`;
    expect(balance[0]?.diff).toBe("0");

    return ctx.parent;
  },
);
