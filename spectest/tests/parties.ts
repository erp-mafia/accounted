/**
 * Förslag från bokföringen: the register learns its counterparts from the
 * vouchers, and SCB fills in the rest.
 *
 * The vouchers are the awkward kind: written by the assistant and the
 * transaction inbox as "<counterpart> · <note>", with bank memos, long
 * references and foreign suppliers. That is what a real company's books look
 * like after a year of assisted booking (Arcim, 2026-09-03), and it is where
 * the queue used to show sentence-long names and search SCB on a whole
 * verifikat. They are seeded straight into the ledger: the point of this
 * branch is what the register makes of the books, not how the books were
 * written, and the manual voucher form has its own tests.
 */
import { expect, expectRaw } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";
import { enrolMfa } from "./mfa";
import { ACCOUNT } from "./signup";
import { COMPANY } from "./onboarding";

const YEAR = new Date().getFullYear();

const VOUCHERS = [
  { date: `${YEAR}-02-03`, description: "1511768101 · Visma Spcs AB, faktura 2025-10-02, programvarulicens/abonnemang", account: "6540", amount: 3578 },
  { date: `${YEAR}-02-17`, description: "TIC identity     BG 0000005786439 Bg-bet. via internet · Faktura 20250746, The Intelligence Company AB (publ). TIC Identity-abonnemang.", account: "6540", amount: 2385 },
  { date: `${YEAR}-03-10`, description: "Utbetalning leverantörsfaktura 20250928, The Intelligence Company AB (publ)", account: "6540", amount: 2385 },
  { date: `${YEAR}-03-24`, description: "Utlägg Framer · Framer B.V. (NL), webbdesignverktyg. Säljaren debiterat svensk moms via OSS (NL VAT NL853695386B01 på fakturan).", account: "6540", amount: 545 },
  { date: `${YEAR}-04-21`, description: "Framer Oktober · Framer B.V. (NL), webbdesignverktyg. Säljaren debiterat svensk moms via OSS (NL VAT NL853695386B01 på fakturan).", account: "6540", amount: 545 },
  { date: `${YEAR}-05-05`, description: "Claude Maj H Överföring via internet · Anthropic Ireland, faktura 22,5 EUR inkl 4,5 EUR VAT-Sweden 25% via OSS.", account: "6540", amount: 250 },
  { date: `${YEAR}-05-19`, description: "Registeringsavgift Finansinspektionen", account: "6991", amount: 1500 },
  { date: `${YEAR}-06-02`, description: "Hotel at Booking.com K3667 Kortköp/uttag · Hotell, svenskt boende, 12% moms", account: "5831", amount: 1277 },
];

/** What the queue should read out of those eight vouchers. */
const EXPECTED_NAMES = [
  "Anthropic Ireland",
  "Framer B.V.",
  "Hotel at Booking.com",
  "The Intelligence Company AB (publ)",
  "Visma Spcs AB",
];

export const suggestionsFromBooks = env.test(
  "parties suggestions from books",
  { dependsOn: enrolMfa },
  async (ctx) => {
    const db = ctx.svc.supabase;
    const who = await db.sql<{ company_id: string; user_id: string }>`
      select c.id as company_id, u.id as user_id
      from public.companies c, auth.users u
      where c.org_number = ${COMPANY.orgNumber} and u.email = ${ACCOUNT.email}`;
    expect(who).toHaveLength(1);
    const companyId = who[0]!.company_id.unwrap();
    const userId = who[0]!.user_id.unwrap();

    // The wizard opened the current fiscal year; every voucher lands in it.
    const period = await db.sql<{ id: string }>`
      select id from public.fiscal_periods
      where company_id = ${companyId} and ${`${YEAR}-01-01`}::date between period_start and period_end
      limit 1`;
    expect(period, "onboarding opened a fiscal year for the current calendar year").toHaveLength(1);
    const periodId = period[0]!.id.unwrap();

    // Entry and lines in one statement: the ledger's balance check is a
    // deferred constraint, so an entry that commits without its lines is
    // rejected as having zero total.
    let n = 0;
    for (const v of VOUCHERS) {
      n += 1;
      await db.sql`
        with e as (
          insert into public.journal_entries
            (user_id, company_id, fiscal_period_id, voucher_number, voucher_series, entry_date, description, source_type, status)
          values (${userId}, ${companyId}, ${periodId}, ${n}, 'A', ${v.date}::date, ${v.description}, 'manual', 'posted')
          returning id
        )
        insert into public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
        select e.id, ${v.account}, ${v.amount}, 0 from e
        union all
        select e.id, '1930', 0, ${v.amount} from e`;
    }

    // First visit: the queue builds itself from the books, no button.
    const b = await ctx.browser();
    await b.goto(`${APP_URL}/parties`);
    await expect(b.getByRole("heading", { name: "Förslag från bokföringen" })).toBeVisible();

    const names = await ctx.poll("the queue is built from the books", async () => {
      const rows = await db.sql<{ display_name: string; alias_keys: string[] }>`
        select display_name, alias_keys from public.parties
        where company_id = ${companyId} and status = 'suggested' and merged_into is null
        order by display_name`;
      return rows.unwrap().length >= EXPECTED_NAMES.length ? rows : null;
    });
    // Sentence-long names are gone; the legal person named in the text is the name.
    expect(names.map((r) => r.display_name)).toEqual(EXPECTED_NAMES);
    // Two keys naming the same legal person are one suggestion with both
    // keys (rows come back in EXPECTED_NAMES order).
    expect(names[3]?.display_name).toBe("The Intelligence Company AB (publ)");
    expect(names[3]?.alias_keys).toHaveLength(2);
    expect(names[1]?.display_name).toBe("Framer B.V.");
    expect(names[1]?.alias_keys).toHaveLength(2);
    // A fee to an authority is not a counterpart.
    expect(names.map((r) => r.display_name)).not.toContain("Registeringsavgift Finansinspektionen");

    // The same on screen, one row each.
    for (const name of EXPECTED_NAMES) {
      await expect(b.getByRole("row", { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) })).toHaveCount(1);
    }
    // The foreign VAT number read out of the Framer text is a hard key already.
    const framerVat = await db.sql<{ vat_number: string | null }>`
      select vat_number from public.parties where company_id = ${companyId} and display_name = 'Framer B.V.'`;
    expect(framerVat[0]?.vat_number).toBe("NL853695386B01");

    return { ...ctx.parent, companyId, userId };
  },
);

export const pickInScb = env.test(
  "parties pick in scb",
  { dependsOn: suggestionsFromBooks },
  async (ctx) => {
    const b = await ctx.browser();
    const scb = ctx.fakes.scb;
    await b.goto(`${APP_URL}/parties`);

    const row = b.getByRole("row", { name: /Visma Spcs AB/ });
    await row.getByRole("button", { name: "Hitta i företagsregistret" }).click();

    // The search is planned from the name in the text ("Visma Spcs", the
    // legal form stripped), not the whole verifikat. One company matches
    // that prefix, and even a single match is shown, never auto-picked.
    const dialog = b.getByRole("dialog");
    await expect(dialog).toContainText("SCB hittar 1 företag som liknar Visma Spcs");
    await expect(dialog.getByRole("button", { name: "Välj ett företag" })).toBeDisabled();
    await dialog.getByRole("option", { name: /Visma Spcs AB/ }).click();
    await dialog.getByRole("button", { name: "Välj Visma Spcs AB" }).click();

    const party = await ctx.poll("the org number and the registry facts land on the party", async () => {
      const rows = await ctx.svc.supabase.sql<{ org_number: string | null; facts: string }>`
        select p.org_number,
               (select count(*) from public.party_facts f where f.party_id = p.id and f.source = 'registry_scb')::text as facts
        from public.parties p
        where p.company_id = ${ctx.parent.companyId} and p.display_name = 'Visma Spcs AB'`;
      return rows[0]?.org_number?.unwrap() && Number(rows[0]?.facts.unwrap()) > 0 ? rows : null;
    });
    expect(party[0]?.org_number).toBe("5562529155");

    // What SCB was actually asked: the count and the rows for the planned
    // name, then the row for the chosen org number. Never the verifikat text.
    const calls = scb.calls();
    expect(calls).toHaveLength(3);
    expect(calls[0]?.endpoint).toBe("RaknaForetag");
    expect(calls[0]?.variable).toBe("Namn");
    expect(calls[0]?.value).toBe("Visma Spcs");
    expect(calls[1]?.endpoint).toBe("HamtaForetag");
    expect(calls[2]?.variable).toBe("OrgNr (10 siffror)");
    expect(calls[2]?.value).toBe("5562529155");

    // The dossier shows the register's facts under one source line.
    await b.getByRole("button", { name: "Öppna Visma Spcs AB", exact: true }).click();
    await expect(b.getByText("Från SCB")).toBeVisible();
    await expect(b.getByText("556252-9155")).toBeVisible();
    await b.keyboard.press("Escape");

    return ctx.parent;
  },
);

export const foreignIsNotSearched = env.test(
  "parties foreign not searched",
  { dependsOn: suggestionsFromBooks },
  async (ctx) => {
    const b = await ctx.browser();
    const scb = ctx.fakes.scb;
    await b.goto(`${APP_URL}/parties`);

    // The queue says so on the row itself; no search is offered there.
    const framerRow = b.getByRole("row", { name: /Framer B\.V\./ });
    await expect(framerRow).toContainText("Utländskt bolag (Nederländerna), finns inte i SCB");
    await expect(framerRow.getByRole("button", { name: "Hitta i företagsregistret" })).toHaveCount(0);
    // The Irish one has no legal form in the text; the country word is enough.
    await expect(b.getByRole("row", { name: /Anthropic Ireland/ })).toContainText("Utländskt bolag (Irland), finns inte i SCB");

    // From the dossier the search is still reachable, and it explains instead of searching.
    await b.getByRole("button", { name: "Öppna Framer B.V.", exact: true }).click();
    await expect(b.getByText("Nederländerna", { exact: true })).toBeVisible();
    await b.getByRole("button", { name: "Fler åtgärder", exact: true }).click();
    await b.getByRole("menuitem", { name: "Hitta i företagsregistret" }).click();
    const dialog = b.getByRole("dialog").last();
    await expect(dialog).toContainText("Framer B.V. ser ut att vara ett utländskt bolag (Nederländerna)");
    await expect(dialog).toContainText("SCB:s register täcker bara svenska företag");
    expect(scb.calls(), "no SCB query for a company the register cannot hold").toHaveLength(0);
    await b.keyboard.press("Escape");
  },
);

export const reviewList = env.test(
  "parties review list",
  { dependsOn: suggestionsFromBooks },
  async (ctx) => {
    const b = await ctx.browser();
    const scb = ctx.fakes.scb;
    await b.goto(`${APP_URL}/parties`);

    // Three rows SCB could hold lack an org number: Visma, TIC and the hotel.
    // The two foreign ones are not offered.
    await b.getByRole("button", { name: "Hitta org.nr (3)", exact: true }).click();
    const dialog = b.getByRole("dialog");
    await expect(dialog).toContainText("Hitta org.nr i företagsregistret");

    // Rows are asked one at a time; wait for the last to land.
    await expect(dialog.getByRole("button", { name: /^Godkänn \d+$/ })).toBeEnabled({ timeout: 30000 });
    await expect(dialog).toContainText("SCB frågades med namnet i verifikatet");

    // Exactly one match each: shown ticked, not yet saved.
    await expect(dialog.getByRole("row", { name: /Visma Spcs AB/ })).toContainText("556252-9155");
    await expect(dialog.getByRole("row", { name: /The Intelligence Company AB \(publ\)/ })).toContainText("559487-1682");
    // No match: listed underneath with the per-row picker still reachable.
    await expect(dialog).toContainText("Hotel at Booking.com");
    await expect(dialog).toContainText("Ingen träff");

    // Nothing has been written yet.
    const before = await ctx.svc.supabase.sql<{ n: string }>`
      select count(*)::text as n from public.parties where company_id = ${ctx.parent.companyId} and org_number is not null`;
    expect(before[0]?.n).toBe("0");

    await dialog.getByRole("button", { name: "Godkänn 2", exact: true }).click();

    const saved = await ctx.poll("both org numbers land on the parties", async () => {
      const rows = await ctx.svc.supabase.sql<{ display_name: string; org_number: string | null }>`
        select display_name, org_number from public.parties
        where company_id = ${ctx.parent.companyId} and org_number is not null
        order by display_name`;
      return rows.unwrap().length === 2 ? rows : null;
    });
    expect(saved[0]?.display_name).toBe("The Intelligence Company AB (publ)");
    expect(saved[0]?.org_number).toBe("5594871682");
    expect(saved[1]?.display_name).toBe("Visma Spcs AB");
    expect(saved[1]?.org_number).toBe("5562529155");

    // Each approval was one lookup by org number after the name searches.
    const byOrg = scb.calls().unwrap().filter((c) => c.variable.startsWith("OrgNr"));
    expectRaw(byOrg.length, "one org-number lookup per approved row").toBe(2);
  },
);

export const promoteToSuppliers = env.test(
  "parties promote to suppliers",
  { dependsOn: pickInScb },
  async (ctx) => {
    const b = await ctx.browser();
    const db = ctx.svc.supabase;
    await b.goto(`${APP_URL}/parties`);

    await b.getByRole("button", { name: "Markera alla", exact: true }).click();
    await b.getByRole("button", { name: /^Lägg upp \d+$/ }).click();

    // The dialog says what will happen, and which rows SCB cannot complete.
    const dialog = b.getByRole("dialog");
    await expect(dialog).toContainText("Lägg upp 5 i registret?");
    // Hotel at Booking.com and The Intelligence Company could be completed
    // from SCB but lack an org number; Framer and Anthropic never can.
    await expect(dialog).toContainText("2 av 5 saknar org.nr");
    await expect(dialog).toContainText("2 av 5 är utländska bolag");
    await dialog.getByRole("button", { name: /^Lägg upp/ }).click();

    const suppliers = await ctx.poll("five suppliers exist, one per suggestion", async () => {
      const rows = await db.sql<{ name: string; org_number: string | null; vat_number: string | null }>`
        select s.name, s.org_number, s.vat_number
        from public.suppliers s
        where s.company_id = ${ctx.parent.companyId}
        order by s.name`;
      return rows.unwrap().length === EXPECTED_NAMES.length ? rows : null;
    });
    expect(suppliers.map((s) => s.name)).toEqual(EXPECTED_NAMES);

    // The picked one got its registry facts; the VAT number is derived from
    // the org number and lands on the supplier without another click.
    expect(suppliers[4]?.name).toBe("Visma Spcs AB");
    expect(suppliers[4]?.org_number).toBe("5562529155");
    await ctx.poll("SCB facts are fetched for the promoted legal person", async () => {
      const rows = await db.sql<{ vat_number: string | null }>`
        select vat_number from public.suppliers where company_id = ${ctx.parent.companyId} and name = 'Visma Spcs AB'`;
      return rows[0]?.vat_number?.unwrap() ? rows : null;
    });
    const vismaAfter = await db.sql<{ vat_number: string | null }>`
      select vat_number from public.suppliers where company_id = ${ctx.parent.companyId} and name = 'Visma Spcs AB'`;
    expect(vismaAfter[0]?.vat_number).toBe("SE556252915501");

    // The foreign supplier keeps the VAT number read out of the voucher text.
    expect(suppliers[1]?.name).toBe("Framer B.V.");
    expect(suppliers[1]?.vat_number).toBe("NL853695386B01");
    expect(suppliers[1]?.org_number).toBe(null);

    // Every party behind them is confirmed and linked to its supplier row.
    const parties = await db.sql<{ status: string; linked: string }>`
      select p.status, (select count(*) from public.suppliers s where s.party_id = p.id)::text as linked
      from public.parties p where p.company_id = ${ctx.parent.companyId} and p.merged_into is null`;
    expect(parties).toHaveLength(EXPECTED_NAMES.length);
    for (let i = 0; i < EXPECTED_NAMES.length; i += 1) {
      expect(parties[i]?.status).toBe("confirmed");
      expect(parties[i]?.linked).toBe("1");
    }

    // The queue is empty now, and says so instead of showing a blank table.
    await expect(b.getByText(/^0 förslag/)).toBeVisible();

    // The supplier page shows what the register knows, where people look
    // for it: legal name, org number, VAT number and the SCB facts under one
    // source line, with a refresh action.
    const vismaId = await db.sql<{ id: string }>`
      select id from public.suppliers where company_id = ${ctx.parent.companyId} and name = 'Visma Spcs AB'`;
    await b.goto(`${APP_URL}/suppliers/${vismaId[0]!.id.unwrap()}`);
    await expect(b.getByRole("heading", { name: "Visma Spcs AB" })).toBeVisible();
    await expect(b.getByText("Företagsuppgifter")).toBeVisible();
    await expect(b.getByText("556252-9155")).toBeVisible();
    // The VAT number shows both under Kontaktuppgifter and Företagsuppgifter.
    await expect(b.getByText("SE556252915501").first()).toBeVisible();
    await expect(b.getByText("Utgivning av annan programvara")).toBeVisible();
    await expect(b.getByText(/^Från SCB · hämtat/)).toBeVisible();
    await expect(b.getByRole("button", { name: "Uppdatera från SCB", exact: true })).toBeVisible();

    // A foreign supplier says so instead of offering a search.
    const framerId = await db.sql<{ id: string }>`
      select id from public.suppliers where company_id = ${ctx.parent.companyId} and name = 'Framer B.V.'`;
    await b.goto(`${APP_URL}/suppliers/${framerId[0]!.id.unwrap()}`);
    await expect(b.getByText("Företagsuppgifter")).toBeVisible();
    await expect(b.getByText(/Utländskt bolag \(Nederländerna\)/)).toBeVisible();
    await expect(b.getByRole("button", { name: "Hitta i företagsregistret" })).toHaveCount(0);
  },
);
