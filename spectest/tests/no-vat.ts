/**
 * A company that is not momsregistrerad.
 *
 * Below 120 000 kr in annual turnover a Swedish business may stay outside the
 * VAT system (ML 18 kap., the omsättningsgräns), and plenty of small
 * aktiebolag and föreningar do. For them VAT is not "0 %" on an invoice that
 * otherwise looks the same: there is no output VAT to charge, none to deduct,
 * and no momsdeklaration to file.
 *
 * That makes it a whole branch rather than a setting. The wizard stops asking
 * about periods, the invoice editor drops the Moms column, and the ledger must
 * never see a 26xx line. Charging VAT you are not registered for is money you
 * have to hand over and cannot recover from the customer, so the assertion
 * that no 2611 line exists is the one that matters.
 *
 * A third company forked from the same sign-up, alongside the aktiebolag on
 * faktureringsmetoden and the enskild firma on kontantmetoden.
 */
import { expect } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";
import { totp } from "../lib/totp";
import { signUp } from "./signup";

const COMPANY = {
  // Luhn-valid: the wizard refuses to advance on a bad check digit.
  orgNumber: "5590123450",
  name: "Lilla Verkstaden AB",
  street: "Verkstadsgatan 3",
  postalCode: "41250",
  city: "Göteborg",
};

const LINE = {
  description: "Reparation av cykel",
  unitPrice: "2000",
};

export const onboardWithoutVatRegistration = env.test(
  "onboard a company that is not momsregistrerad",
  { dependsOn: signUp },
  async (ctx) => {
    const b = await ctx.browser();

    await expect(b.getByText("Vad är ert organisationsnummer?")).toBeVisible();
    await b.locator("input").first().fill(COMPANY.orgNumber);
    await b.keyboard.press("Enter");

    await b.getByRole("button", { name: "Aktiebolag", exact: true }).click();
    await expect(b.getByText("Vad heter bolaget?")).toBeVisible();
    await b.locator("input").first().fill(COMPANY.name);
    await b.keyboard.press("Enter");

    await expect(b.getByText("Vad är bolagets adress?")).toBeVisible();
    await b.getByPlaceholder("Gatuadress").fill(COMPANY.street);
    await b.getByPlaceholder("Postnummer").fill(COMPANY.postalCode);
    await b.getByPlaceholder("Ort").fill(COMPANY.city);
    await b.keyboard.press("Enter");

    await b.getByRole("button", { name: "Ja", exact: true }).click();
    await expect(b.getByText("Vilket räkenskapsår har ni?")).toBeVisible();
    await b.getByRole("button", { name: "Kalenderår", exact: true }).click();

    await expect(b.getByText("Är bolaget momsregistrerat?")).toBeVisible();
    await b.getByRole("button", { name: "Nej", exact: true }).click();

    // The period question is not asked, because there is nothing to report.
    // Asking it and storing an answer would leave the company carrying a moms
    // period it must never file, which is how a deadline reminder for a return
    // that does not exist gets created.
    await expect(
      b.getByText("Hur ofta redovisar ni moms?"),
      "no reporting period is asked of a company with nothing to report",
    ).not.toBeVisible();
    await expect(b.getByText("Hur vill ni bokföra?")).toBeVisible();
    await b.getByRole("button", { name: "Faktureringsmetoden", exact: true }).click();

    await expect(b.getByRole("button", { name: "Fortsätt", exact: true })).toBeVisible({
      timeout: 20000,
    });

    const settings = await ctx.svc.supabase.sql<{
      vat_registered: boolean;
      moms_period: string | null;
      name: string;
    }>`
      select cs.vat_registered, cs.moms_period, c.name
      from public.company_settings cs
      join public.companies c on c.id = cs.company_id`;
    expect(settings[0]?.name).toBe(COMPANY.name);
    expect(settings[0]?.vat_registered).toBe(false);

    return ctx.parent;
  },
);

export const invoiceCarriesNoVatAtAll = env.test(
  "an invoice from a company outside the VAT system carries no VAT",
  { dependsOn: onboardWithoutVatRegistration },
  async (ctx) => {
    const b = await ctx.browser();

    await b.getByRole("button", { name: "Fortsätt", exact: true }).click();
    await b.getByRole("button", { name: "Det här är ny verksamhet", exact: true }).click();
    await b.waitForURL(/\/mfa\/enroll/, { waitUntil: "load" });
    await b.getByRole("button", { name: "Fortsätt", exact: true }).click();
    const secret = await b.locator("code").first().textContent();
    await b.locator("#code").fill(totp((secret?.unwrap() ?? "").trim()));
    await b.getByRole("button", { name: /Aktivera|Verifiera/i }).click();
    await b.waitForURL((u) => !u.pathname.startsWith("/mfa"), {
      waitUntil: "load",
      timeout: 25000,
    });

    await b.goto(`${APP_URL}/invoices`);
    await expect(b.getByText("Din första faktura tar två minuter.")).toBeVisible({
      timeout: 20000,
    });
    await b.getByRole("button", { name: "Ny faktura", exact: true }).click();

    await b.getByRole("button", { name: "Lägg till nu" }).click();
    await b.locator("#bankgiro").fill("123-4566");
    await b.getByRole("button", { name: "Spara & fortsätt" }).click();
    await expect(b.getByText("Betalningsuppgifter sparade")).toBeVisible();

    await b.getByRole("button", { name: "+ Skapa kund" }).click();
    await b.locator("#name").fill("Cykelhandlaren i Majorna");
    await b.locator("#email").fill("faktura@cykelhandlaren.test");
    await b.getByRole("button", { name: "Spara kund", exact: true }).click();
    await expect(b.getByText("faktura@cykelhandlaren.test")).toBeVisible();

    await b.locator('input[placeholder^="Skriv fritt"]').fill(LINE.description);
    await b.keyboard.press("Enter");
    await b.locator('input[name="items.0.unit_price"]').fill(LINE.unitPrice);

    // The Moms column is gone from the editor, not set to zero. A visible 0 %
    // picker would invite someone to change it, and the answer to "which rate"
    // is that the question does not apply.
    const editor = b.getByRole("dialog");
    await expect(
      editor,
      "the rate picker is absent, not zeroed: there is no rate to pick",
    ).not.toContainText("Moms 25%");
    await expect(editor).toContainText("2 000 kr");

    await b.getByRole("button", { name: "Granska & skapa" }).click();
    await b.getByRole("button", { name: "Bekräfta & skapa" }).click();

    const invoice = await ctx.poll("the invoice exists", async () => {
      const rows = await ctx.svc.supabase.sql<{
        invoice_number: string;
        vat_amount: string;
        subtotal: string;
        total: string;
      }>`
        select invoice_number,
               trim_scale(vat_amount)::text as vat_amount,
               trim_scale(subtotal)::text   as subtotal,
               trim_scale(total)::text      as total
        from public.invoices`;
      return rows.unwrap().length === 1 ? rows : null;
    });
    expect(invoice[0]?.vat_amount).toBe("0");
    // Total equals subtotal: nothing was added on top for the customer to pay.
    expect(invoice[0]?.subtotal).toBe(LINE.unitPrice);
    expect(invoice[0]?.total).toBe(LINE.unitPrice);

    return ctx.parent;
  },
);

export const theLedgerNeverSeesOutputVat = env.test(
  "booking the invoice produces no output VAT line and no VAT return",
  { dependsOn: invoiceCarriesNoVatAtAll },
  async (ctx) => {
    const b = await ctx.browser();

    await b.getByRole("button", { name: "Hoppa över" }).click();
    await b.goto(`${APP_URL}/invoices`);
    await b.locator("tr").filter({ hasText: "Cykelhandlaren i Majorna" }).first().click();
    await expect(b.getByText("Faktura 001")).toBeVisible({ timeout: 20000 });

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
        select account_number,
               trim_scale(debit_amount)::text  as debit,
               trim_scale(credit_amount)::text as credit
        from public.journal_entry_lines
        order by account_number`;
      return rows.unwrap().length >= 2 ? rows : null;
    });

    // Two lines, and the missing third is the assertion. 3004 is the
    // momsfri revenue account for an aktiebolag; 3001 here would be a claim
    // that the sale carried 25 % that was never charged.
    expect(lines).toHaveLength(2);
    expect(lines[0]?.account_number).toBe("1510");
    expect(lines[0]?.debit).toBe(LINE.unitPrice);
    expect(lines[1]?.account_number, "momsfri revenue, not the 25 % account").toBe(
      "3004",
    );
    expect(lines[1]?.credit).toBe(LINE.unitPrice);

    const vatLines = await ctx.svc.supabase.sql<{ n: number }>`
      select count(*)::int as n from public.journal_entry_lines
      where account_number like '26%'`;
    expect(
      vatLines[0]?.n,
      "a company outside the VAT system never books output VAT",
    ).toBe(0);

    // And the momsdeklaration refuses rather than rendering an empty return.
    // The page stays reachable, because registration can change, but it says
    // why there is nothing here and where to change it. A zeroed declaration
    // would look like something to file.
    await b.goto(`${APP_URL}/reports/vat-declaration`);
    await expect(
      b.getByText("Företaget är inte momsregistrerat"),
      "the VAT return says why it is empty instead of showing zeros to file",
    ).toBeVisible({ timeout: 25000 });
    await expect(
      b.getByRole("button", { name: "Öppna skatteinställningar" }),
      "and points at the setting that would change the answer",
    ).toBeVisible();

    return ctx.parent;
  },
);
