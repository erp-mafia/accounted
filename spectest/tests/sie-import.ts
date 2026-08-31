/**
 * Migrating in from another system with a SIE4 file.
 *
 * A sibling of the fresh-start branch: the same onboarding, answered the other
 * way at "Var fanns bokföringen innan?". This is the path a customer leaving
 * Fortnox or Bokio actually walks, and the one where their history either
 * arrives intact or quietly does not.
 *
 * The fixture is authored in spectest/tests/fixtures/foretaget-2025.se and is
 * deliberately awkward in two ways that match reality:
 *
 * - It is UTF-8 with a BOM while declaring `#FORMAT PC8`, which is what cloud
 *   exporters emit. Getting that wrong is the single most common SIE failure
 *   and shows up as garbled å/ä/ö, so the customer name in the voucher
 *   description is checked character for character after import.
 * - It carries LAST year's books, 2025, which is what a migration actually
 *   brings across, and its verifications cover January to March while the
 *   fiscal year runs to December. The app is
 *   expected to notice and say so rather than silently produce a wrong
 *   omföringsverifikation.
 */
import { expect } from "@specific.dev/spectest";
import { env } from "../index";
import { totp } from "../lib/totp";
import { completeOnboarding } from "./onboarding";

const FIXTURE = "spectest/tests/fixtures/foretaget-2025.se";

/** The customer name in the fixture, with the characters that matter. */
const SWEDISH_DESCRIPTION = "Kundfaktura 2025-001 Nordströms Måleri AB";

export const chooseSieImport = env.test(
  "choose the SIE migration path out of onboarding",
  { dependsOn: completeOnboarding },
  async (ctx) => {
    const b = await ctx.browser();

    await b.getByRole("button", { name: "Fortsätt", exact: true }).click();
    await expect(b.getByText("Var fanns bokföringen innan?")).toBeVisible();
    await b.getByRole("button", { name: "SIE-fil", exact: true }).click();

    // The company now exists, so MFA enrolment intercepts. The destination has
    // to survive that detour: losing it would drop a migrating customer on the
    // dashboard with no idea where their import went.
    await b.waitForURL(/\/mfa\/enroll/, { waitUntil: "load" });
    await expect(b).toHaveURL(/returnTo=%2Fimport%3Fmode%3Dsie/);

    await b.getByRole("button", { name: "Fortsätt", exact: true }).click();
    const secret = await b.locator("code").first().textContent();
    const rawSecret = (secret?.unwrap() ?? "").trim();
    await b.locator("#code").fill(totp(rawSecret));
    await b.getByRole("button", { name: /Aktivera|Verifiera/i }).click();

    await b.waitForURL(/\/import/, { waitUntil: "load", timeout: 20000 });
    await expect(b.getByText("Ladda upp SIE-fil")).toBeVisible();

    return ctx.parent;
  },
);

export const importSieFile = env.test(
  "import a year of books from a SIE4 file",
  { dependsOn: chooseSieImport },
  async (ctx) => {
    const b = await ctx.browser();

    await b.locator("input[type=file]").setInputFiles(FIXTURE);

    // The preview is the customer's chance to see whether their history came
    // across before anything is written. Every number here is read out of the
    // file, so a parser regression shows up as a wrong count rather than as a
    // silent partial import.
    await expect(b.getByText("Företagsinformation")).toBeVisible({ timeout: 30000 });
    await expect(b.getByText("556677-8899")).toBeVisible();
    await expect(b.getByText("2025-01-01")).toBeVisible();
    await expect(b.getByText("2025-12-31")).toBeVisible();
    // IB totals 312 500 kr on both sides, so the file's own balance survived
    // parsing. Rendered twice, as debit and as credit.
    await expect(b.getByText("312 500 kr").first()).toBeVisible();
    await expect(b.getByText("Balanserar").first()).toBeVisible();
    await expect(b.getByText("Alla konton skapade och automatiskt kopplade")).toBeVisible();

    await b.getByRole("button", { name: "Fortsätt", exact: true }).click();

    // SIE carries no VAT codes, so the app has to ask rather than guess. 3001
    // is proposed as Försäljning Sverige 25 % (ruta 05), which is the box it
    // feeds in the momsdeklaration.
    await expect(b.getByText("1 momskoder att granska").first()).toBeVisible();
    await expect(b.getByText("Försäljning Sverige, 25 % (ruta 05)")).toBeVisible();
    await b.getByRole("button", { name: /Bekräfta alla föreslagna/ }).click();
    await expect(b.getByText("0 momskoder att granska").first()).toBeVisible();

    await b.getByRole("button", { name: "Fortsätt till granskning" }).click();
    await b.getByRole("button", { name: "Starta import", exact: true }).click();

    // The result screen leads with the thing the customer cares about.
    await expect(b.getByText("4 verifikat · 9 konton · 0 motparter")).toBeVisible({
      timeout: 60000,
    });
    await expect(b.getByText("Varje år balanserar: 0,00 kr i diff")).toBeVisible();

    // The mid-year warning. The fixture's #UB covers three months while the
    // fiscal year runs to December, and the app is expected to say so: a
    // silent import here would produce a wrong omföringsverifikation at
    // year-end, months later, with nothing pointing back at this moment.
    await expect(
      b.getByText(/ofullständigt räkenskapsår/),
      "the app warns that the file's vouchers do not cover the whole year",
    ).toBeVisible();

    const entries = await ctx.svc.supabase.sql<{
      voucher_series: string;
      voucher_number: number;
      entry_date: string;
      description: string;
      status: string;
    }>`
      select voucher_series, voucher_number, entry_date::text as entry_date,
             description, status
      from public.journal_entries
      order by voucher_series, voucher_number`;

    expect(entries).toHaveLength(4);

    // The three vouchers from the file, in their own series, dated as in the
    // file rather than as of the import.
    expect(entries[0]?.voucher_series).toBe("A");
    expect(entries[0]?.entry_date).toBe("2025-01-15");
    expect(entries[2]?.entry_date).toBe("2025-03-05");

    // Opening balances arrive as their own verifikat, dated at the start of
    // the fiscal year, in a separate series so they are distinguishable from
    // the imported vouchers.
    expect(entries[3]?.voucher_series).toBe("M");
    expect(entries[3]?.entry_date).toBe("2025-01-01");
    expect(entries[3]?.description).toBe("Ingående balanser från SIE-import");
    expect(entries[3]?.status).toBe("posted");

    // The encoding check. The file is UTF-8 with a BOM but declares
    // `#FORMAT PC8`; read as CP437 this would come back as mojibake. Asserting
    // the exact string is the only way to catch that, because a garbled name
    // is still a valid string and every count above would still pass.
    expect(
      entries[0]?.description,
      "Swedish characters survive the encoding detection",
    ).toBe(SWEDISH_DESCRIPTION);

    // Everything balances: the file's own invariant, carried into the ledger.
    const totals = await ctx.svc.supabase.sql<{ diff: string; lines: number }>`
      select (sum(debit_amount) - sum(credit_amount))::text as diff,
             count(*)::int as lines
      from public.journal_entry_lines`;
    expect(totals[0]?.diff).toBe("0");
    // 8 rows from the vouchers plus 5 opening-balance rows.
    expect(totals[0]?.lines).toBe(13);

    // Spot-check the balances the customer would recognise: the bank account
    // and the equity they started the year with.
    const bank = await ctx.svc.supabase.sql<{ net: string }>`
      select (sum(debit_amount) - sum(credit_amount))::text as net
      from public.journal_entry_lines where account_number = '1930'`;
    expect(bank[0]?.net).toBe("275000");

    return ctx.parent;
  },
);
