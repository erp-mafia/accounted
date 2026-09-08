/**
 * The other kind of company.
 *
 * Everything else in this suite is an aktiebolag on the invoice method with
 * quarterly VAT. A sole trader is a different customer with different law
 * behind them, and the wizard branches on it: the org number is a
 * personnummer, the fiscal year is not a choice, and the questions are asked
 * in the second person singular rather than to a company.
 *
 * This branch also picks kontantmetoden and yearly VAT, which no other test
 * covers. Between them that is three dimensions the aktiebolag path never
 * touches.
 */
import { expect } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";
import { totp } from "../lib/totp";
import { signUp } from "./signup";

export const SOLE_TRADER = {
  // A sole trader's org number is their personnummer, Luhn-valid.
  orgNumber: "8501010006",
  name: "Anna Andersson Design",
  street: "Storgatan 1",
  postalCode: "11122",
  city: "Stockholm",
};

export const onboardAsEnskildFirma = env.test(
  "onboard a sole trader",
  { dependsOn: signUp },
  async (ctx) => {
    const b = await ctx.browser();

    await expect(b.getByText("Vad är ert organisationsnummer?")).toBeVisible();
    await b.locator("input").first().fill(SOLE_TRADER.orgNumber);
    await b.keyboard.press("Enter");

    await b.getByRole("button", { name: "Enskild firma", exact: true }).click();

    // From here the wizard speaks to a person, not to a company. The wording
    // is the visible half of a branch that also decides the chart of accounts,
    // the tax return and what "eget kapital" even means.
    await expect(b.getByText("Vad ska verksamheten heta?")).toBeVisible();
    await b.locator("input").first().fill(SOLE_TRADER.name);
    await b.keyboard.press("Enter");

    await expect(b.getByText("Vad är firmans adress?")).toBeVisible();
    await b.getByPlaceholder("Gatuadress").fill(SOLE_TRADER.street);
    await b.getByPlaceholder("Postnummer").fill(SOLE_TRADER.postalCode);
    await b.getByPlaceholder("Ort").fill(SOLE_TRADER.city);
    await b.keyboard.press("Enter");

    await expect(b.getByText("Har du F-skatt?")).toBeVisible();
    await b.getByRole("button", { name: "Ja", exact: true }).click();

    // No choice of fiscal year, and the wizard says why. A sole trader must
    // use the calendar year, so offering the aktiebolag question here would be
    // offering something the law does not allow.
    await expect(b.getByText("Är det ditt första räkenskapsår?")).toBeVisible();
    await expect(
      b.getByText(/Enskild firma följer kalenderåret/),
      "the wizard states the constraint rather than asking a question with one legal answer",
    ).toBeVisible();
    await b.getByRole("button", { name: "Nej, pågående", exact: true }).click();

    await expect(b.getByText("Är du momsregistrerad?")).toBeVisible();
    await b.getByRole("button", { name: "Ja", exact: true }).click();

    // Yearly VAT, which the aktiebolag branch never exercises.
    await expect(b.getByText("Hur ofta redovisar du moms?")).toBeVisible();
    await b.getByRole("button", { name: "En gång om året", exact: true }).click();

    // And kontantmetoden, where an invoice books on payment rather than on
    // issue. Nothing else in the suite covers it.
    await expect(b.getByText("Hur vill du bokföra?")).toBeVisible();
    await b.getByRole("button", { name: "Kontantmetoden", exact: true }).click();

    await expect(b.getByRole("button", { name: "Fortsätt", exact: true })).toBeVisible({
      timeout: 20000,
    });
    // The summary calls it a personnummer, not an organisationsnummer.
    await expect(b.getByText("Personnummer")).toBeVisible();
    await expect(b.getByText("Enskild firma").first()).toBeVisible();

    const companies = await ctx.svc.supabase.sql<{
      id: string;
      name: string;
      entity_type: string;
      org_number: string;
    }>`select id, name, entity_type, org_number from public.companies`;
    expect(companies).toHaveLength(1);
    expect(companies[0]?.entity_type).toBe("enskild_firma");
    expect(companies[0]?.org_number).toBe(SOLE_TRADER.orgNumber);

    const settings = await ctx.svc.supabase.sql<{
      accounting_method: string;
      moms_period: string;
      vat_registered: boolean;
      f_skatt: boolean;
      fiscal_year_start_month: number;
    }>`
      select accounting_method, moms_period, vat_registered, f_skatt,
             fiscal_year_start_month
      from public.company_settings
      where company_id = ${companies[0]!.id.unwrap()}`;

    // Cash method: an invoice hits the ledger when it is paid, not when it is
    // sent, which changes both the books and the VAT period it lands in.
    expect(settings[0]?.accounting_method).toBe("cash");
    expect(settings[0]?.moms_period).toBe("yearly");
    expect(settings[0]?.vat_registered).toBe(true);
    expect(settings[0]?.f_skatt).toBe(true);
    // January, and not because it was chosen.
    expect(settings[0]?.fiscal_year_start_month).toBe(1);

    return ctx.parent;
  },
);

export const enterTheAppAsEnskildFirma = env.test(
  "finish onboarding and enrol MFA as a sole trader",
  { dependsOn: onboardAsEnskildFirma },
  async (ctx) => {
    const b = await ctx.browser();

    // Out of onboarding the same way the aktiebolag branch goes, so everything
    // downstream compares like for like. Split out from the tests that follow
    // because more than one of them needs a signed-in sole trader, and a fork
    // of this state is free where re-walking the wizard is not.
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

    return ctx.parent;
  },
);

export const neBilagaReplacesInk2 = env.test(
  "a sole trader gets the NE-bilaga, not INK2",
  { dependsOn: enterTheAppAsEnskildFirma },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(`${APP_URL}/reports`);
    await b.locator("tr").filter({ hasText: "NE-bilaga" }).first().click();

    // INK2 is the aktiebolag return; a sole trader files NE as an attachment
    // to their own income tax return instead. Serving the wrong one would be
    // a filing error, not a cosmetic one.
    await expect(b.getByText("NE-bilaga (Enskild firma)")).toBeVisible({
      timeout: 25000,
    });
    await expect(b.getByText(SOLE_TRADER.name).first()).toBeVisible();
    // R11 is the result line of the NE form.
    await expect(b.getByText("R11")).toBeVisible();
    await expect(b.getByText("Ladda ner SRU-fil")).toBeVisible();

    // And it is honest about what it is built on. The books are empty and the
    // year is open, and it says both rather than presenting zeros as final.
    await expect(b.getByText(/Räkenskapsåret är inte stängt/)).toBeVisible();
    await expect(
      b.getByText(/Inga bokförda intäkter eller kostnader hittades/),
    ).toBeVisible();

    return ctx.parent;
  },
);
