/**
 * The onboarding journey, end to end.
 *
 * Seven questions across five stations (FÖRETAGET, RÄKENSKAPSÅRET, MOMSEN,
 * BOKFÖRINGEN, KLART), then a summary and the "where was the bookkeeping
 * before?" branch. The reducer behind it has 41 unit tests; what those cannot
 * tell you is whether the screens render, whether Enter advances, and whether
 * the company that comes out the far end is the one the user described.
 *
 * The wizard has no test ids, so the selectors here are the questions
 * themselves and the answer chips — the same things a user reads. That makes
 * them readable, and it makes a failure say which question broke.
 */
import { expect } from "@specific.dev/spectest";
import { env } from "../index";
import { signUp } from "./signup";

/** What the test tells the wizard, and therefore what it asserts came out. */
export const COMPANY = {
  orgNumber: "5566778899",
  name: "E2E Testbolag AB",
  street: "Storgatan 1",
  postalCode: "11122",
  city: "Stockholm",
};

export const completeOnboarding = env.test(
  "complete onboarding and create the company",
  { dependsOn: signUp },
  async (ctx) => {
    const b = await ctx.browser();

    // Station 1: FÖRETAGET. One field at a time, Enter to advance.
    await expect(b.getByText("Vad är ert organisationsnummer?")).toBeVisible();
    await b.locator("input").first().fill(COMPANY.orgNumber);
    await b.keyboard.press("Enter");

    await expect(b.getByText("Vilken företagsform har ni?")).toBeVisible();
    await b.getByRole("button", { name: "Aktiebolag", exact: true }).click();

    await expect(b.getByText("Vad heter bolaget?")).toBeVisible();
    await b.locator("input").first().fill(COMPANY.name);
    await b.keyboard.press("Enter");

    // Three fields on one screen, so fill by placeholder rather than by index.
    await expect(b.getByText("Vad är bolagets adress?")).toBeVisible();
    await b.getByPlaceholder("Gatuadress").fill(COMPANY.street);
    await b.getByPlaceholder("Postnummer").fill(COMPANY.postalCode);
    await b.getByPlaceholder("Ort").fill(COMPANY.city);
    await b.keyboard.press("Enter");

    await expect(b.getByText("Har bolaget F-skatt?")).toBeVisible();
    await b.getByRole("button", { name: "Ja", exact: true }).click();

    // Station 2: RÄKENSKAPSÅRET.
    await expect(b.getByText("Vilket räkenskapsår har ni?")).toBeVisible();
    await b.getByRole("button", { name: "Kalenderår", exact: true }).click();

    // Station 3: MOMSEN.
    await expect(b.getByText("Är bolaget momsregistrerat?")).toBeVisible();
    await b.getByRole("button", { name: "Ja", exact: true }).click();

    await expect(b.getByText("Hur ofta redovisar ni moms?")).toBeVisible();
    await b.getByRole("button", { name: "Varje kvartal", exact: true }).click();

    // Station 4: BOKFÖRINGEN.
    await expect(b.getByText("Hur vill ni bokföra?")).toBeVisible();
    await b.getByRole("button", { name: "Faktureringsmetoden", exact: true }).click();

    // Station 5: KLART. The summary is the user's receipt for what they just
    // told us, so it is worth checking it says the right things back.
    await expect(b.getByRole("button", { name: "Fortsätt", exact: true })).toBeVisible({
      timeout: 15000,
    });
    await expect(b.getByText(COMPANY.name).first()).toBeVisible();
    await expect(b.getByText(COMPANY.orgNumber)).toBeVisible();
    await expect(b.getByText("Faktureringsmetoden").first()).toBeVisible();

    // The company is what actually matters, and the summary is only a
    // rendering of it. Read the row.
    const companies = await ctx.svc.supabase.sql<{
      id: string;
      name: string;
      entity_type: string;
      org_number: string;
    }>`select id, name, entity_type, org_number from public.companies`;

    expect(companies).toHaveLength(1);
    expect(companies[0]?.name).toBe(COMPANY.name);
    expect(companies[0]?.entity_type).toBe("aktiebolag");
    // Stored canonical: the user may type 556677-8899 or 5566778899 and both
    // have to land as the same ten digits.
    expect(companies[0]?.org_number).toBe(COMPANY.orgNumber);

    // Every remaining answer lands in company_settings, and each one changes
    // how the ledger behaves later: the VAT period drives the declaration
    // schedule, and the accounting method decides whether an invoice books on
    // issue or on payment. A wizard that renders correctly but persists the
    // wrong method here would only surface months later, in the books.
    const settings = await ctx.svc.supabase.sql<{
      address_line1: string | null;
      postal_code: string | null;
      city: string | null;
      f_skatt: boolean | null;
      vat_registered: boolean | null;
      moms_period: string | null;
      accounting_method: string | null;
      fiscal_year_start_month: number | null;
    }>`
      select address_line1, postal_code, city, f_skatt, vat_registered,
             moms_period, accounting_method, fiscal_year_start_month
      from public.company_settings
      where company_id = ${companies[0]!.id.unwrap()}`;

    expect(settings).toHaveLength(1);
    expect(settings[0]?.address_line1).toBe(COMPANY.street);
    expect(settings[0]?.postal_code).toBe(COMPANY.postalCode);
    expect(settings[0]?.city).toBe(COMPANY.city);
    expect(settings[0]?.f_skatt).toBe(true);
    expect(settings[0]?.vat_registered).toBe(true);
    expect(settings[0]?.moms_period).toBe("quarterly");
    expect(settings[0]?.accounting_method).toBe("accrual");
    // Kalenderår: January.
    expect(settings[0]?.fiscal_year_start_month).toBe(1);

    // The creator has to be a member, or every RLS-scoped query the app makes
    // next comes back empty and the dashboard looks broken for its owner.
    const members = await ctx.svc.supabase.sql<{ n: number }>`
      select count(*)::int as n from public.company_members
      where company_id = ${companies[0]!.id.unwrap()}`;
    expect(members[0]?.n).toBe(1);

    return { companyId: companies[0]!.id.unwrap() };
  },
);

/**
 * The one routing decision the journey asks for, at the moment the user is
 * most motivated: where the bookkeeping lived before. A new business skips
 * import entirely.
 */
export const chooseFreshStart = env.test(
  "choose a fresh start at the branch question",
  { dependsOn: completeOnboarding },
  async (ctx) => {
    const b = await ctx.browser();

    await b.getByRole("button", { name: "Fortsätt", exact: true }).click();

    await expect(b.getByText("Var fanns bokföringen innan?")).toBeVisible();
    // Every provider Accounted can migrate from is offered here. If one of
    // these disappears, a migration path disappeared with it.
    for (const provider of ["Fortnox", "Visma", "Bokio", "Björn Lundén", "Briox", "SIE-fil"]) {
      await expect(b.getByRole("button", { name: provider, exact: true })).toBeVisible();
    }

    await b.getByRole("button", { name: "Det här är ny verksamhet", exact: true }).click();

    // The company now exists, so the middleware's "still setting up" exemption
    // no longer applies and the next navigation forces MFA enrolment. This is
    // the assertion that pins the ordering described in signup.ts.
    await b.waitForURL(/\/mfa\/enroll/, { waitUntil: "load" });

    return ctx.parent;
  },
);
