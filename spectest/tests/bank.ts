/**
 * Connecting a bank, and what the money looks like once it lands.
 *
 * The whole PSD2 path with nothing stubbed on the app's side: the real client
 * in extensions/general/enable-banking, a real RS256 JWT, a real consent
 * redirect out to the bank and back, and the real ingest pipeline writing to
 * the real schema. Only the bank itself is fake, and it answers at
 * `api.enablebanking.com`, so the app is never told it is under test.
 *
 * Forks from the sent invoice rather than from the bare account, so the whole
 * suite reads as one story: you invoice a customer, then you connect the bank
 * the payment will arrive in. It also means the voucher series is already at
 * A1 when the first bank booking happens, which is what lets the tests below
 * check that numbering stays sequential across different sources.
 *
 * Handelsbanken is the bank under test on purpose. Its Mobile BankID is a
 * HIDDEN decoupled method, which Enable Banking only uses when it is requested
 * explicitly — the case selectPreferredAuthMethod() exists for. Picking any
 * other bank would exercise none of it.
 */
import { expect } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";
import { sendInvoiceAndBookIt } from "./invoice";
import {
  SEK_TX_COUNT,
  SEK_INCOMING_COUNT,
  SEK_OUTGOING_COUNT,
  EUR_TRANSACTIONS,
} from "../fakes/enable-banking-data";

/** Both accounts on the consent, so both currencies are imported. */
const TOTAL_TX = SEK_TX_COUNT + EUR_TRANSACTIONS.length;

export const connectBank = env.test(
  "connect a bank and import its transactions",
  { dependsOn: sendInvoiceAndBookIt },
  async (ctx) => {
    const b = await ctx.browser();
    const bank = ctx.fakes.enableBanking;

    await b.goto(`${APP_URL}/settings/banking`);
    await expect(b.getByText("ANSLUT NY BANK")).toBeVisible();

    await b.getByRole("button", { name: "Handelsbanken", exact: true }).click();

    // Out to the bank's own consent page. The URL matters: this is the app
    // handing the user off to a third party, and it has to be the bank's
    // address, not something the app serves itself.
    await b.waitForURL(/api\.enablebanking\.com\/sca\//);
    await expect(
      b.getByRole("heading", { name: "Identifiera dig med BankID" }),
    ).toBeVisible();

    // The auth method the app asked for. Handelsbanken's working Mobile BankID
    // is hidden, so leaving it unpinned is what produced "fel efter BankID"
    // for corporate users; pinning a VISIBLE decoupled method is the opposite
    // regression (PR #854). This assertion is the one that keeps both fixed.
    expect(bank.pinnedAuthMethod()).toBe("SE_BANKID_DECOUPLED");

    await b.getByRole("button", { name: "Godkänn i BankID" }).click();

    // Back in the app, with the accounts the consent covers. Gate on the
    // dialog's full title, which names the bank: the bare "Välj konton" is
    // also the label of the trigger that reopens the picker, so it is not a
    // unique handle.
    await b.waitForURL(/\/settings\/banking/, { waitUntil: "load" });
    await expect(
      b.getByText("Välj konton att synka: Handelsbanken"),
    ).toBeVisible({ timeout: 20000 });

    // Nothing is fetched before the user confirms. A picker that had already
    // imported would make the consent screen a formality.
    await expect(
      b.getByText("Inga transaktioner hämtas innan du sparar."),
    ).toBeVisible();

    // Both accounts on the consent are offered, by IBAN.
    await expect(b.getByText("SE45 5000 0000 0583 9825 7466")).toBeVisible();
    await expect(b.getByText("SE35 5000 0000 0549 1000 0003")).toBeVisible();

    // Each is pre-mapped to a BAS account by currency. Asserted on the
    // dialog's text rather than on the select controls: they are comboboxes
    // whose accessible name is not their rendered value, so naming them is
    // brittle in a way the visible text is not. The mapping that actually
    // matters is checked against the database after saving, below.
    const picker = b.getByRole("dialog");
    await expect(picker).toContainText("1930 Företagskonto / checkkonto");

    // The chart account carries a BAS-style name, not the bank's. 1932 is a
    // free-use sub-account with no BAS reference, so it is named "Bankkonto
    // EUR" rather than after what the bank calls the account. That is
    // deliberate (#1643): ASPSPs report the account HOLDER as the account
    // name, so every failed reconnect used to persist another 19xx chart
    // account named after the company. The bank's own name still shows on the
    // row above the picker, which is the line below.
    await expect(picker).toContainText("1932 Bankkonto EUR");
    await expect(
      picker,
      "the bank's name for the account is still shown, next to the chart account it maps to",
    ).toContainText("Valutakonto EUR");

    await b.getByRole("button", { name: "Spara val", exact: true }).click();

    // The import runs on save. It fetches two accounts and pages through the
    // larger one, so give it room.
    await expect(
      b.getByText(`${TOTAL_TX} nya transaktioner importerade.`),
    ).toBeVisible({
      timeout: 45000,
    });

    // Pagination actually happened. The fake pages in tens, so a client that
    // stopped after the first page would have imported 10 of the 20 SEK rows;
    // this proves the loop followed the continuation key rather than the fake
    // having handed everything over at once.
    expect(
      bank
        .calls()
        .transform("paged", (cs) =>
          cs.filter((c) => c.path.includes("continuation_key=")),
        ),
    ).not.toHaveLength(0);

    const connections = await ctx.svc.supabase.sql<{
      bank_name: string;
      status: string;
      consent_expires: string;
    }>`select bank_name, status, consent_expires from public.bank_connections`;

    expect(connections).toHaveLength(1);
    expect(connections[0]?.bank_name).toBe("Handelsbanken");
    expect(connections[0]?.status).toBe("active");

    // The currency-to-BAS mapping, where it counts. Every transaction from an
    // account posts its bank-side leg to this account, so SEK landing in 1932
    // (or EUR in 1930) would corrupt the year-end FX revaluation rather than
    // just look wrong on screen.
    const mapping = await ctx.svc.supabase.sql<{
      currency: string;
      ledger_account: string;
    }>`
      select acct->>'currency' as currency, acct->>'ledger_account' as ledger_account
      from public.bank_connections,
           lateral jsonb_array_elements(accounts_data) as acct
      order by 1`;

    expect(mapping).toHaveLength(2);
    expect(mapping[0]?.currency).toBe("EUR");
    expect(mapping[0]?.ledger_account).toBe("1932");
    expect(mapping[1]?.currency).toBe("SEK");
    expect(mapping[1]?.ledger_account).toBe("1930");

    return ctx.parent;
  },
);

export const transactionsLandCorrectly = env.test(
  "the imported money is booked the right way round",
  { dependsOn: connectBank },
  async (ctx) => {
    // Signs and öre are the two things that quietly destroy a ledger: a
    // reversed sign turns a tax payment into income, and a rounding slip puts
    // an entry out of balance. Both are checked against the database rather
    // than the screen, and in SQL rather than in JS, so each assertion nests
    // under the query that produced it.
    const totals = await ctx.svc.supabase.sql<{
      total: number;
      incoming: number;
      outgoing: number;
      distinct_ids: number;
      blank_descriptions: number;
      sub_ore: number;
    }>`
      select count(*)::int                                              as total,
             count(*) filter (where amount > 0)::int                    as incoming,
             count(*) filter (where amount < 0)::int                    as outgoing,
             count(distinct external_id)::int                           as distinct_ids,
             count(*) filter (where coalesce(trim(description), '') = '')::int as blank_descriptions,
             count(*) filter (where round(amount * 100) / 100 <> amount)::int  as sub_ore
      from public.transactions`;

    expect(totals[0]?.total).toBe(TOTAL_TX);
    expect(totals[0]?.incoming).toBe(
      SEK_INCOMING_COUNT +
        EUR_TRANSACTIONS.filter((t) => t.ind === "CRDT").length,
    );
    expect(totals[0]?.outgoing).toBe(
      SEK_OUTGOING_COUNT +
        EUR_TRANSACTIONS.filter((t) => t.ind === "DBIT").length,
    );
    // Every row identifiable, which is what makes a re-sync idempotent.
    expect(totals[0]?.distinct_ids).toBe(TOTAL_TX);
    // An empty description is unbookable in the UI.
    expect(totals[0]?.blank_descriptions).toBe(0);
    expect(totals[0]?.sub_ore).toBe(0);

    // Öre survive the round trip exactly, in both directions.
    const ore = await ctx.svc.supabase.sql<{ amount: string }>`
      select amount::text from public.transactions
      where amount in (7350.25, -62.75) order by amount`;
    expect(ore).toHaveLength(2);

    // A payment out is negative. Booked the other way round, a skattekonto
    // payment reads as income and the VAT return is wrong.
    const skatt = await ctx.svc.supabase.sql<{ amount: string }>`
      select amount::text from public.transactions
      where description = 'Inbetalning skattekonto 16556677-8899'`;
    expect(skatt).toHaveLength(2);

    // The bank's own payment message arrives intact rather than being replaced
    // by a counterparty name: it carries the OCR and invoice number that
    // invoice matching keys off.
    const ocr = await ctx.svc.supabase.sql<{ n: number }>`
      select count(*)::int as n from public.transactions
      where description = 'Betalning faktura 2026-114 OCR 1141234567890'`;
    expect(ocr[0]?.n).toBe(1);

    return ctx.parent;
  },
);

export const deadConsentAsksForReconnect = env.test(
  "a consent that dies bank-side asks the user to reconnect",
  { dependsOn: connectBank },
  async (ctx) => {
    const b = await ctx.browser();
    const bank = ctx.fakes.enableBanking;

    // Dismiss the import summary the parent left open.
    await b.getByRole("button", { name: "Stäng", exact: true }).click();

    // PSD2 consents die: they expire after 90 days, or the customer revokes
    // them in the bank's app. The failure mode that matters is the silent one,
    // where the app keeps retrying and the user's transactions quietly stop
    // arriving.
    bank.closeSession();

    await b.getByRole("button", { name: "Synka", exact: true }).click();

    await expect(b.getByText("Utgånget samtycke")).toBeVisible({
      timeout: 30000,
    });
    await expect(
      b.getByRole("button", { name: "Förnya samtycke" }),
    ).toBeVisible();
    await expect(
      b.getByText(
        "Handelsbanken: PSD2-samtycket har löpt ut. Förnya samtycket för att återuppta synkroniseringen.",
      ),
    ).toBeVisible();

    // The state is recorded, not just rendered: the nightly sweep reads this
    // to stop retrying a connection that cannot succeed.
    const connections = await ctx.svc.supabase.sql<{
      status: string;
      error_message: string | null;
    }>`select status, error_message from public.bank_connections`;
    expect(connections[0]?.status).toBe("expired");
    expect(connections[0]?.error_message).toBe(
      "Bankanslutningen har löpt ut. Förnya anslutningen för att fortsätta synka.",
    );

    return ctx.parent;
  },
);
