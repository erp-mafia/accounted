/**
 * SIE round trip: the books that came in from a file, exported back out.
 *
 * A migration is only trustworthy in both directions. A customer who imported
 * from Fortnox has to be able to hand their accountant a SIE file, or leave for
 * another system, and get the same numbers back out. This exports the year that
 * was imported and reads the file line by line.
 *
 * The character encoding gets its own assertion. The export is UTF-8 with no
 * BOM while declaring `#FORMAT PC8`, which is what most Swedish accounting
 * software emits and what the spec technically requires (PC8 is the only legal
 * value of the field). That combination is exactly where å/ä/ö turn to
 * mojibake if a reader trusts the header over the bytes, so the customer name
 * is checked character for character on the way out too.
 */
import { expect } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";
import { importSieFile } from "./sie-import";

export const exportSieRoundTrip = env.test(
  "export the imported year back to SIE unchanged",
  { dependsOn: importSieFile },
  async (ctx) => {
    const b = await ctx.browser();

    const period = await ctx.svc.supabase.sql<{ id: string }>`
      select id::text as id from public.fiscal_periods
      where period_end = '2025-12-31'`;
    const periodId = period[0]!.id.unwrap();

    // Fetched from inside the page so it carries the user's session, the same
    // way the download button does.
    await b.goto(`${APP_URL}/import?view=export`);
    const sie = await b.evaluate(
      "download the SIE export",
      `fetch('/api/reports/sie-export?period_id=${periodId}').then((r) => r.text())`,
    );

    // Header: the year, the company, and a type that carries verifications.
    expect(sie).toContain("#SIETYP 4");
    expect(sie).toContain("#RAR 0 20250101 20251231");
    expect(sie).toContain("#ORGNR 556677-8899");
    expect(sie).toContain('#FNAMN "E2E Testbolag AB"');

    // Opening balances, unchanged from the file that was imported. Sign
    // convention is SIE's own: debit positive, credit negative.
    expect(sie).toContain("#IB 0 1930 250000.00");
    expect(sie).toContain("#IB 0 1510 62500.00");
    expect(sie).toContain("#IB 0 2440 -45000.00");
    expect(sie).toContain("#IB 0 2081 -25000.00");
    expect(sie).toContain("#IB 0 2091 -242500.00");

    // All three verifications, with their original dates and amounts.
    expect(sie).toContain('#VER "A" 1 20250115');
    expect(sie).toContain('#VER "A" 2 20250210');
    expect(sie).toContain('#VER "A" 3 20250305');
    expect(sie).toContain("#TRANS 1510 {} 25000.00");
    expect(sie).toContain("#TRANS 3001 {} -20000.00");
    expect(sie).toContain("#TRANS 2611 {} -5000.00");
    expect(sie).toContain("#TRANS 2440 {} -15000.00");

    // Closing balances, which are IB plus the year's movements. 1930 went from
    // 250 000 to 275 000 on the customer payment; 2440 from -45 000 to -60 000
    // on the supplier invoice.
    expect(sie).toContain("#UB 0 1930 275000.00");
    expect(sie).toContain("#UB 0 1510 62500.00");
    expect(sie).toContain("#UB 0 2440 -60000.00");
    expect(sie).toContain("#UB 0 2611 -5000.00");
    expect(sie).toContain("#UB 0 2641 3000.00");

    // Result accounts for the year, which is what a #RES record is for.
    expect(sie).toContain("#RES 0 3001 -20000.00");
    expect(sie).toContain("#RES 0 5010 12000.00");

    // The encoding, end to end. Imported as UTF-8-with-BOM, stored, and
    // written back out as UTF-8-without-BOM under a PC8 header: if any step in
    // that chain trusted the header over the bytes, this is where it shows.
    expect(
      sie,
      "Swedish characters survive the whole import-store-export chain",
    ).toContain("Kundfaktura 2025-001 Nordströms Måleri AB");

    // #FORMAT is compulsory and PC8 is its only legal value, so it is emitted
    // regardless of the actual bytes. Asserted so that a future change to the
    // export encoding is a deliberate one rather than a silent drift.
    expect(sie).toContain("#FORMAT PC8");

    return ctx.parent;
  },
);
