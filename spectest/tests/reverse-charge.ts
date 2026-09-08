/**
 * Selling services to an EU business: omvänd skattskyldighet.
 *
 * Under huvudregeln (ML 6 kap. 34 §, Article 44 of the VAT Directive) a B2B
 * service is taxed where the buyer is established, so a Swedish seller invoices
 * a German company without Swedish VAT and the buyer accounts for it. The sale
 * lands on 3308 and in ruta 39 of the momsdeklaration instead of 3001 and ruta
 * 10, and it belongs in the periodiska sammanställningen.
 *
 * The condition that makes it lawful is a buyer VAT number verified against
 * VIES. Get that wrong and the seller owes the Swedish VAT they never charged,
 * so the interesting half of this file is the refusals: an unknown number and a
 * register that is down must both leave the invoice at 25 %.
 *
 * VIES is faked at ec.europa.eu, its real host, so the app calls the address it
 * calls in production. See spectest/fakes/vies.ts.
 */
import { expect } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";
import { sendInvoiceAndBookIt } from "./invoice";

/** Registered in the VIES fake. */
const GERMAN_CUSTOMER = {
  name: "Muster Handels GmbH",
  vatNumber: "DE811234567",
  email: "rechnung@muster.test",
  country: "Germany",
};

/** Well-formed, and not in the register. */
const UNKNOWN_VAT_NUMBER = "DE999999999";

const LINE = {
  description: "Konsultation september",
  unitPrice: "15000",
};

/** Fill the customer dialog on /customers. Shared by all three branches. */
async function createEuCustomer(
  b: Awaited<ReturnType<Parameters<Parameters<typeof env.test>[2]>[0]["browser"]>>,
  name: string,
  vatNumber: string,
  country: string = GERMAN_CUSTOMER.country,
) {
  await b.goto(`${APP_URL}/customers`);
  await b.getByRole("button", { name: /^Ny kund/ }).first().click();

  await b.getByRole("combobox").first().click();
  await b.getByRole("option", { name: "EU-företag", exact: true }).click();

  await b.locator("#name").fill(name);
  await b.locator("#email").fill(GERMAN_CUSTOMER.email);
  // The country defaults to Sweden and is never reconciled against the
  // customer type or the VAT prefix (#2025), so set it explicitly.
  await b.locator("#country").fill(country);
  // The VAT field only renders for a foreign business customer, which is the
  // first thing this proves.
  await b.locator("#vat_number").fill(vatNumber);
  await b.getByRole("button", { name: /^Spara/ }).first().click();
}

export const viesValidatesTheBuyerVatNumber = env.test(
  "creating an EU customer checks the VAT number against VIES",
  { dependsOn: sendInvoiceAndBookIt },
  async (ctx) => {
    const b = await ctx.browser();
    await createEuCustomer(b, GERMAN_CUSTOMER.name, GERMAN_CUSTOMER.vatNumber);

    const customer = await ctx.poll("the customer is created", async () => {
      const rows = await ctx.svc.supabase.sql<{
        name: string;
        customer_type: string;
        vat_number: string;
        validated: boolean | null;
      }>`
        select name, customer_type, vat_number,
               vat_number_validated as validated
        from public.customers
        where customer_type = 'eu_business'`;
      return rows.unwrap().length === 1 ? rows : null;
    });

    expect(customer[0]?.customer_type).toBe("eu_business");
    expect(customer[0]?.vat_number).toBe(GERMAN_CUSTOMER.vatNumber);
    // Validated against the register, not merely well-formed. This is the
    // condition the 0 % rate rests on.
    expect(
      customer[0]?.validated,
      "a number found in VIES is stored as validated",
    ).toBe(true);

    // And the app really asked, rather than deciding from the string's shape.
    const calls = ctx.fakes.vies.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.country).toBe("DE");
    expect(calls[0]?.number).toBe("811234567");

    return ctx.parent;
  },
);

export const reverseChargeBooksToTheEuAccount = env.test(
  "an invoice to a verified EU business carries no VAT and books to 3308",
  { dependsOn: viesValidatesTheBuyerVatNumber },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(`${APP_URL}/invoices`);
    await b.getByRole("button", { name: "Ny faktura", exact: true }).click();

    await b.getByRole("combobox").first().click();
    await b.getByRole("option", { name: new RegExp(GERMAN_CUSTOMER.name) }).click();

    await b.locator('input[placeholder^="Skriv fritt"]').fill(LINE.description);
    await b.keyboard.press("Enter");
    await b.locator('input[name="items.0.unit_price"]').fill(LINE.unitPrice);

    // The rate is locked to zero and the picker names the rule rather than
    // just showing 0 %, which is what lets the person sending the invoice
    // check it against what they believe they are doing.
    await expect(
      b.getByRole("combobox", { name: "Moms" }),
      "the line's rate is 0 % under omvänd skattskyldighet, and says so",
    ).toContainText("0% (omvänd skattskyldighet)");

    // And the summary drops the VAT row entirely rather than printing a zero:
    // subtotal and total are the same number. A "Moms 25%" row here would mean
    // the customer switch failed to snap the rate.
    await expect(b.getByRole("dialog")).not.toContainText("Moms 25%");

    await b.getByRole("button", { name: "Granska & skapa" }).click();
    await b.getByRole("button", { name: "Bekräfta & skapa" }).click();

    const invoice = await ctx.poll("the invoice exists", async () => {
      const rows = await ctx.svc.supabase.sql<{
        invoice_number: string;
        vat_treatment: string;
        vat_amount: string;
        total: string;
      }>`
        select invoice_number, vat_treatment,
               vat_amount::text as vat_amount, total::text as total
        from public.invoices
        where invoice_number = '002'`;
      return rows.unwrap().length === 1 ? rows : null;
    });
    expect(invoice[0]?.vat_treatment).toBe("reverse_charge");
    expect(invoice[0]?.vat_amount).toBe("0");
    expect(invoice[0]?.total).toBe(LINE.unitPrice);

    await b.goto(`${APP_URL}/invoices`);
    await b.locator("tr").filter({ hasText: GERMAN_CUSTOMER.name }).first().click();
    await expect(b.getByText("Faktura 002")).toBeVisible({ timeout: 20000 });

    // What the invoice has to say for itself. A reverse-charge invoice is only
    // valid with the buyer's VAT number on it and an explicit statement that
    // the buyer accounts for the VAT; the directive reference is the standard
    // wording for that statement.
    // The label and the value are separate elements, so match the value.
    await expect(b.getByText(GERMAN_CUSTOMER.vatNumber).first()).toBeVisible();
    await expect(b.getByText(/Omvänd skattskyldighet \(0%\)/)).toBeVisible();
    await expect(
      b.getByText(/Article 196, Council Directive 2006\/112\/EC/),
      "the invoice carries the statement that makes the reverse charge valid",
    ).toBeVisible();

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
               jel.debit_amount::text  as debit,
               jel.credit_amount::text as credit
        from public.journal_entries je
        join public.journal_entry_lines jel on jel.journal_entry_id = je.id
        where je.voucher_number = 2
        order by jel.account_number`;
      return rows.unwrap().length >= 2 ? rows : null;
    });

    // Two lines, and the absence of the third is the assertion. 3308 feeds
    // ruta 39; booking this to 3001 would put it in ruta 10 and invent a VAT
    // debt, and adding a 2611 line would charge the German company Swedish VAT
    // the invoice never asked for.
    expect(lines).toHaveLength(2);
    expect(lines[0]?.account_number).toBe("1510");
    expect(lines[0]?.debit).toBe(LINE.unitPrice);
    expect(lines[1]?.account_number, "EU services revenue, the ruta 39 account").toBe(
      "3308",
    );
    expect(lines[1]?.credit).toBe(LINE.unitPrice);

    const vatLines = await ctx.svc.supabase.sql<{ n: number }>`
      select count(*)::int as n from public.journal_entry_lines
      where account_number like '26%'
        and journal_entry_id in (
          select id from public.journal_entries where voucher_number = 2)`;
    expect(vatLines[0]?.n, "no output VAT on a reverse-charge sale").toBe(0);

    return ctx.parent;
  },
);

export const unknownVatNumberKeepsSwedishVat = env.test(
  "an EU customer whose VAT number is not in the register keeps Swedish VAT",
  { dependsOn: sendInvoiceAndBookIt },
  async (ctx) => {
    const b = await ctx.browser();
    await createEuCustomer(b, "Unbekannt GmbH", UNKNOWN_VAT_NUMBER);

    const customer = await ctx.poll("the customer is created", async () => {
      const rows = await ctx.svc.supabase.sql<{ validated: boolean }>`
        select coalesce(vat_number_validated, false) as validated
        from public.customers
        where customer_type = 'eu_business'`;
      return rows.unwrap().length === 1 ? rows : null;
    });

    // Not validated, and therefore not entitled to 0 %. Invoicing without VAT
    // here would leave the seller owing the VAT they never charged.
    expect(
      customer[0]?.validated,
      "a number the register does not know is not validated",
    ).toBe(false);

    await b.goto(`${APP_URL}/invoices`);
    await b.getByRole("button", { name: "Ny faktura", exact: true }).click();
    await b.getByRole("combobox").first().click();
    await b.getByRole("option", { name: /Unbekannt GmbH/ }).click();

    await b.locator('input[placeholder^="Skriv fritt"]').fill(LINE.description);
    await b.keyboard.press("Enter");
    await b.locator('input[name="items.0.unit_price"]').fill(LINE.unitPrice);

    // Falls back to the ordinary domestic rate rather than to zero.
    await expect(
      b.getByText("Moms 25%"),
      "an unverified EU customer is invoiced with Swedish VAT",
    ).toBeVisible();
    await expect(b.getByText("3 750 kr").first()).toBeVisible();

    return ctx.parent;
  },
);

export const viesOutageDoesNotCountAsValidated = env.test(
  "a VIES outage does not count as a verified VAT number",
  { dependsOn: sendInvoiceAndBookIt },
  async (ctx) => {
    const b = await ctx.browser();

    // The register is down. The number itself is a real one.
    ctx.fakes.vies.setOutage(true);
    await createEuCustomer(b, GERMAN_CUSTOMER.name, GERMAN_CUSTOMER.vatNumber);

    const customer = await ctx.poll("the customer is created", async () => {
      const rows = await ctx.svc.supabase.sql<{ validated: boolean }>`
        select coalesce(vat_number_validated, false) as validated
        from public.customers
        where customer_type = 'eu_business'`;
      return rows.unwrap().length === 1 ? rows : null;
    });

    // The customer is still created: an outage at the register is not a
    // reason to refuse the whole record. What must not happen is the number
    // being marked verified on the strength of a failed lookup, because that
    // would unlock a 0 % invoice the seller cannot defend.
    expect(
      customer[0]?.validated,
      "an unreachable register leaves the number unverified rather than trusted",
    ).toBe(false);

    // The app did try.
    expect(ctx.fakes.vies.calls()).toHaveLength(1);

    return ctx.parent;
  },
);

export const euSaleLandsInRuta39AndTheEuList = env.test(
  "the EU sale reaches ruta 39 and the periodiska sammanställningen",
  { dependsOn: reverseChargeBooksToTheEuAccount },
  async (ctx) => {
    const b = await ctx.browser();

    // The company's books now hold both kinds of sale: 15 000 domestic with
    // 3 750 VAT (invoice 001) and 15 000 to Germany with none (invoice 002).
    // That is what makes this worth asserting: the two must not land in the
    // same ruta, and 15 000 appearing in ruta 05 twice would balance perfectly
    // while overstating Swedish turnover by the whole EU sale.
    await b.goto(`${APP_URL}/reports/vat-declaration`);
    // The page opens on the last completed quarter; both invoices are dated
    // today, so pick the quarter they are in rather than trusting the default.
    await expect(b.getByRole("button", { name: "Redovisningsperiod" })).toBeVisible({
      timeout: 25000,
    });
    await b.getByRole("button", { name: "Redovisningsperiod" }).click();
    await b.getByRole("option", { name: /Kvartal 3 2026/ }).click();
    await expect(b.getByText(/2026-07-01 till 2026-09-30/)).toBeVisible({
      timeout: 20000,
    });

    // Whole rows, so the ruta and its amount are asserted together. Ruta 05
    // holding 15 000 rather than 30 000 is the real assertion here: the EU
    // sale is the same size as the domestic one, so a mapping that dropped it
    // into ruta 05 would double that row and still foot correctly.
    await expect(
      b.getByRole("row", { name: /05Momspliktig försäljning 15 000,00 kr/ }),
      "domestic turnover is the domestic sale alone",
    ).toBeVisible();
    await expect(
      b.getByRole("row", { name: /10Utgående moms 25% 3 750,00 kr/ }),
    ).toBeVisible();
    await expect(
      b.getByRole("row", {
        name: /39Tjänster EU \(omvänd skattskyldighet\) 15 000,00 kr/,
      }),
      "the EU service sale has its own ruta, separate from domestic turnover",
    ).toBeVisible();

    // And the VAT owed is the domestic VAT only: the EU sale adds turnover
    // without adding a krona of Swedish moms.
    await expect(
      b.getByRole("row", { name: /Summa utgående moms 3 750,00 kr/ }),
    ).toBeVisible();

    // Derived from the ledger rather than read off the screen, because the
    // point is which account fed which ruta.
    const boxes = await ctx.svc.supabase.sql<{
      account_number: string;
      net: string;
    }>`
      select account_number, (sum(credit_amount) - sum(debit_amount))::text as net
      from public.journal_entry_lines
      where account_number in ('3001', '2611', '3308')
      group by account_number order by account_number`;
    expect(boxes[0]?.account_number).toBe("2611");
    expect(boxes[0]?.net).toBe("3750");
    expect(boxes[1]?.account_number).toBe("3001");
    expect(boxes[1]?.net).toBe("15000");
    expect(boxes[2]?.account_number).toBe("3308");
    expect(boxes[2]?.net).toBe("15000");

    // The declaration is only half the obligation. An EU service sale also has
    // to be listed per buyer in the periodiska sammanställningen, which is
    // reconciled against ruta 39, so the same 15 000 has to appear there under
    // the buyer's VAT number.
    await b.goto(`${APP_URL}/reports/periodisk-sammanstallning`);
    await expect(
      b.getByRole("row", { name: /GERMANY 811234567 15 000/ }),
      "the buyer is listed by country and VAT number, which is what Skatteverket reconciles",
    ).toBeVisible({ timeout: 25000 });

    // Type 3 is services. Goods (type 1) and trepart (type 2) stay empty, and
    // the report reconciles itself against ruta 39 rather than leaving the two
    // numbers to be compared by hand.
    await expect(b.getByText(/Tjänster \(typ 3\)/)).toBeVisible();
    // \s rather than a literal space: Swedish thousands separators are
    // non-breaking, so " " matches text that renders identically and is not
    // the same string.
    await expect(b.getByText(/Ruta 39:\s*15\s*000 kr/)).toBeVisible();

    // The file itself is refused until the company has filled in who is
    // filing it. SKV 5740 carries the filer's name, phone and email, so
    // producing a file without them would produce one Skatteverket rejects.
    const refused = await b.evaluate(
      "download the SKV 5740 file without contact details",
      `fetch('/api/reports/periodisk-sammanstallning/csv?periodType=quarterly&year=2026&period=3')
         .then((r) => r.text())`,
    );
    expect(refused).toContain("PS_REPORT_MISSING_FILER_INFO");
    expect(refused, "the refusal says what is missing and where to fix it").toContain(
      "Fyll i namn, telefon och e-post under Inställningar",
    );

    return ctx.parent;
  },
);

/**
 * RED ON PURPOSE, pinning #2028.
 *
 * The report reads customers.country as an ISO code (periodisk-
 * sammanstallning.ts:266 uppercases it and looks it up in EU_COUNTRIES; the
 * row type at line 30 documents it as "2-char"). The customer form writes a
 * country NAME, defaulting to the English word "Sweden"
 * (CustomerForm.tsx:140), with a free-text input and no picker.
 *
 * So a correctly entered German customer reads as country GERMANY, which is
 * not an ISO code: the report raises two warnings that are both wrong, and the
 * SKV 5740 file that goes to Skatteverket carries GERMANY811234567 where the
 * buyer's VAT number belongs.
 *
 * Delete this comment and keep the test when it is fixed.
 */
export const theEuListFilesAnIsoCountryCode = env.test(
  "the periodiska sammanställningen files an ISO country code, not a name (#2028)",
  { dependsOn: euSaleLandsInRuta39AndTheEuList },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(`${APP_URL}/reports/periodisk-sammanstallning`);
    await expect(b.getByRole("row", { name: /811234567/ })).toBeVisible({
      timeout: 25000,
    });

    // Fill in who is filing, which is the only thing standing between the
    // report and a file. Set directly: the settings form is not what this
    // test is about, and the green test above already covers the refusal.
    await ctx.svc.supabase.sql`
      update public.company_settings
      set tax_contact_name = 'Signup Flow',
          tax_contact_phone = '0700000000',
          tax_contact_email = 'signup-flow@example.test'`;

    // The file that goes to Skatteverket: the VAT field is the country code
    // followed by the number, so a country NAME here is not a cosmetic
    // problem, it is what gets filed.
    const csv = await b.evaluate(
      "download the SKV 5740 file",
      `fetch('/api/reports/periodisk-sammanstallning/csv?periodType=quarterly&year=2026&period=3')
         .then((r) => r.text())`,
    );
    expect(csv, "the filed VAT number is DE811234567").toContain("DE811234567");

    // And a correctly entered German customer is a clean record. Both warnings
    // the report raises about it are false: Germany is in the EU, and DE is
    // its prefix.
    await expect(
      b.getByText(/^Varningar/),
      "a correctly entered German customer raises no warnings",
    ).not.toBeVisible();

    return ctx.parent;
  },
);

/**
 * RED ON PURPOSE, pinning #2025.
 *
 * The customer form defaults country to Sweden and never reconciles it against
 * the customer type or the VAT number's prefix, so an "EU-företag" with a
 * German VAT number and country Sweden saves without complaint. The invoice
 * editor then locks the rate to 0 % on that record, because
 * getAvailableVatRates asks only whether the number validated, not where the
 * buyer is. The contradiction surfaces at the periodiska sammanställningen,
 * after the invoice is sent and the verifikat posted.
 *
 * The assertion is deliberately the weakest useful one: the record must not be
 * storable in that state. Where the guard lives, the form or the API, is the
 * fix's business.
 *
 * Delete this comment and keep the test when #2025 is fixed.
 */
export const euCustomerCannotBeSwedish = env.test(
  "an EU customer cannot be saved with Sweden as its country (#2025)",
  { dependsOn: sendInvoiceAndBookIt },
  async (ctx) => {
    const b = await ctx.browser();

    // Everything filled the way a hurried user would: type picked, VAT number
    // pasted in, country left on its default.
    await createEuCustomer(b, GERMAN_CUSTOMER.name, GERMAN_CUSTOMER.vatNumber, "Sweden");

    // Wait for the save to settle before reading. The company already has one
    // customer from the invoice test, so two rows means the write landed;
    // reading straight after the click passes for the wrong reason.
    //
    // When the guard lands the save is refused instead, this poll times out,
    // and the test should be rewritten to assert the refusal the form shows.
    const saved = await ctx.poll("the save settles", async () => {
      const rows = await ctx.svc.supabase.sql<{
        name: string;
        customer_type: string;
        country: string | null;
      }>`
        select name, customer_type, country from public.customers
        order by created_at`;
      return rows.unwrap().length === 2 ? rows : null;
    });

    expect(
      saved[1]?.country,
      "an EU business in Sweden is a contradiction that unlocks a 0 % invoice",
    ).not.toBe("Sweden");

    return ctx.parent;
  },
);
