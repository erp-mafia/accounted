/**
 * Rättelse inside the verifikat, the other track BFL 5 kap. 5 § allows.
 *
 * `storno.ts` covers the first track: cancel the whole verifikat with a
 * mirroring entry. This is the second, which Fortnox and Visma users know as
 * "stryk rader": while the period is open and unlocked, a wrong line is struck
 * and replaced inside the same verifikat, with no new voucher number. It is
 * only lawful because the original stays readable and every correction is
 * logged immutably with who and when.
 *
 * So the assertions are about what survives, not about what changed. The
 * struck line is preserved in `journal_entry_rattelse_log.struck_lines` (the
 * RPC deletes the row and keeps the JSON, which is why "still readable" is a
 * claim about the log, not about a flag on the line). The log itself refuses
 * to be edited, which this test checks with the service role: not even a
 * privileged connection may rewrite the audit trail.
 *
 * Forks from the booked bank transaction, A2: 1630 Skattekonto D 43 120 /
 * 1930 Företagskonto K 43 120. The correction is the everyday one: the wrong
 * template was picked, and the payment was a supplier payment rather than a
 * transfer to the tax account, so the debit moves from 1630 to 2440.
 *
 * The 1930 leg is left alone, and the replacement is deliberately not another
 * 19xx account. An entry matched to a bank transaction may not have its
 * bank-account lines touched at all, in either direction, and the third test
 * covers that refusal.
 */
import { expect } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";
import { bookTransaction } from "./booking";

const AMOUNT = "43120";
/** The line that was wrong, and what replaces it. */
const WRONG_ACCOUNT = "1630";
const RIGHT_ACCOUNT = "2440";

export const strikeAndReplaceALine = env.test(
  "strike a line and replace it inside the same verifikat",
  { dependsOn: bookTransaction },
  async (ctx) => {
    const b = await ctx.browser();

    const entry = await ctx.svc.supabase.sql<{ id: string }>`
      select id::text as id from public.journal_entries
      where description = 'Inbetalning skattekonto 16556677-8899'`;
    const entryId = entry[0]!.id.unwrap();
    await b.goto(`${APP_URL}/bookkeeping/${entryId}`);

    await expect(b.getByText("Verifikat A2")).toBeVisible({ timeout: 20000 });

    // Promoted to a visible button rather than hidden behind the ⋯ menu
    // (#1554). A correction track nobody can find is a correction track that
    // does not exist: the user who asked for this had concluded the feature
    // was missing.
    await expect(
      b.getByRole("button", { name: "Stryk rader i verifikatet" }),
      "the inline track is discoverable, not buried in an icon-only menu",
    ).toBeVisible();
    await b.getByRole("button", { name: "Stryk rader i verifikatet" }).click();

    const dialog = b.getByRole("dialog");
    await expect(dialog).toContainText(
      "De strukna raderna förblir synliga (överstrukna) i verifikatet.",
    );

    // Strike the credit line and put the same amount on another bank account.
    // The debit leg. Not the credit one: that is the bank account, and the
    // test below covers what happens when you try.
    await dialog.getByRole("checkbox").nth(0).check();
    await dialog.getByRole("button", { name: "Lägg till rad" }).click();

    // The account picker is a search box that resolves an exact account
    // number as you type: filling it selects the account and prefills the line
    // description with the account's name, so there is no option to click.
    await dialog.getByPlaceholder("Sök konto…").fill(RIGHT_ACCOUNT);
    await expect(
      dialog.getByPlaceholder("Beskrivning"),
      "typing the account number resolves the account and names it",
    ).toHaveValue("Leverantörsskulder");
    await dialog.getByPlaceholder("Beskrivning").fill("Rättat: leverantörsbetalning");
    await dialog.getByPlaceholder("Debet").fill(AMOUNT);

    // The dialog does the arithmetic before it lets the user commit: a
    // rättelse that unbalances the verifikat is not a rättelse.
    await expect(dialog).toContainText("Debet efter rättelse:43 120,00");
    await expect(dialog).toContainText("Kredit efter rättelse:43 120,00");
    await expect(
      b.getByRole("button", { name: "Rätta verifikatet" }),
    ).toBeEnabled();

    await b.getByRole("button", { name: "Rätta verifikatet" }).click();

    const lines = await ctx.poll("the rättelse lands", async () => {
      const rows = await ctx.svc.supabase.sql<{
        account_number: string;
        debit: string;
        credit: string;
      }>`
        select account_number,
               -- trim_scale: the RPC writes 43120.00 where the original
               -- booking wrote 43120. Same number, different stored scale.
               trim_scale(debit_amount)::text  as debit,
               trim_scale(credit_amount)::text as credit
        from public.journal_entry_lines
        where journal_entry_id = ${entryId}::uuid
        order by account_number`;
      const r = rows.unwrap();
      return r.length === 2 && r.some((l) => l.account_number === RIGHT_ACCOUNT)
        ? rows
        : null;
    });

    // Same two lines' worth of entry, with the debit moved off 1630. The
    // bank leg is untouched, which is what keeps the reconciliation valid.
    expect(lines[0]?.account_number).toBe("1930");
    expect(lines[0]?.credit).toBe(AMOUNT);
    expect(lines[1]?.account_number).toBe(RIGHT_ACCOUNT);
    expect(lines[1]?.debit).toBe(AMOUNT);

    // Still one verifikat, still A2. This is what separates the inline track
    // from storno: no new voucher number is consumed, so the series does not
    // grow a pair of entries for a typo.
    const entries = await ctx.svc.supabase.sql<{
      voucher_number: number;
      status: string;
      n: number;
    }>`
      select voucher_number, status,
             (select count(*)::int from public.journal_entries) as n
      from public.journal_entries where id = ${entryId}::uuid`;
    expect(entries[0]?.voucher_number).toBe(2);
    expect(entries[0]?.status).toBe("posted");
    expect(entries[0]?.n, "no storno pair was created for an inline rättelse").toBe(2);

    // The entry still balances, which the trigger would have refused anyway.
    const balance = await ctx.svc.supabase.sql<{ diff: string }>`
      select trim_scale(sum(debit_amount) - sum(credit_amount))::text as diff
      from public.journal_entry_lines
      where journal_entry_id = ${entryId}::uuid`;
    expect(balance[0]?.diff).toBe("0");

    return ctx.parent;
  },
);

export const theRattelseIsLoggedAndImmutable = env.test(
  "the rättelse is logged with who and when, and the log cannot be rewritten",
  { dependsOn: strikeAndReplaceALine },
  async (ctx) => {
    const b = await ctx.browser();

    const log = await ctx.svc.supabase.sql<{
      rattelse_type: string;
      struck: string;
      added: string;
      has_actor: boolean;
      created_at: string;
    }>`
      select rattelse_type,
             struck_lines::text as struck,
             added_lines::text  as added,
             actor is not null   as has_actor,
             created_at::text    as created_at
      from public.journal_entry_rattelse_log`;

    expect(log, "one rättelse, one log row").toHaveLength(1);
    expect(log[0]?.rattelse_type).toBe("lines");

    // The struck original is preserved in the log rather than on the line
    // table: the RPC deletes the row and keeps the JSON. That is what makes
    // "the original remains readable" true after the fact, so if this is empty
    // the correction is undocumented and the books are no longer auditable.
    expect(
      log[0]?.struck,
      "the struck line is preserved with the account it was on",
    ).toContain(WRONG_ACCOUNT);
    expect(log[0]?.added).toContain(RIGHT_ACCOUNT);

    // Who and when. An audit trail without an actor answers half the question
    // BFL asks, the same point behandlingshistoriken makes.
    expect(log[0]?.has_actor).toBe(true);

    // And it cannot be rewritten. Attempted with the SERVICE ROLE, which
    // bypasses RLS: the guarantee has to hold at the table, not at the policy,
    // or a privileged code path could quietly launder a correction.
    // Plain throws rather than expect(): these are ordinary JS strings, not
    // values the assertion library can carry provenance for.
    for (const [what, run] of [
      [
        "UPDATE",
        () => ctx.svc.supabase.sql`
          update public.journal_entry_rattelse_log set rattelse_type = 'metadata'`,
      ],
      [
        "DELETE",
        () => ctx.svc.supabase.sql`delete from public.journal_entry_rattelse_log`,
      ],
    ] as const) {
      let message = "";
      try {
        await run();
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      if (!message.includes("oföränderlig")) {
        throw new Error(
          `the rättelse log accepted a service-role ${what}: the audit trail is not immutable (got ${
            message || "no error at all"
          })`,
        );
      }
    }

    // The verifikat page shows the history, so the correction is visible to
    // the person reading the books rather than only to someone with SQL.
    const entry = await ctx.svc.supabase.sql<{ id: string }>`
      select id::text as id from public.journal_entries
      where voucher_number = 2`;
    await b.goto(`${APP_URL}/bookkeeping/${entry[0]!.id.unwrap()}`);
    await expect(b.getByText("Rättelsehistorik")).toBeVisible({ timeout: 20000 });
    await expect(b.getByText("Rader strukna och ersatta")).toBeVisible();

    return ctx.parent;
  },
);

export const inlineRattelseWillNotBreakTheBankLink = env.test(
  "an inline rättelse may not move the leg the bank transaction is matched to",
  { dependsOn: bookTransaction },
  async (ctx) => {
    const b = await ctx.browser();

    const entry = await ctx.svc.supabase.sql<{ id: string }>`
      select id::text as id from public.journal_entries
      where description = 'Inbetalning skattekonto 16556677-8899'`;
    await b.goto(`${APP_URL}/bookkeeping/${entry[0]!.id.unwrap()}`);
    await expect(b.getByText("Verifikat A2")).toBeVisible({ timeout: 20000 });

    await b.getByRole("button", { name: "Stryk rader i verifikatet" }).click();
    const dialog = b.getByRole("dialog");

    // Strike the 1930 line, which is the one the imported bank transaction is
    // matched against, and put the money on another account instead.
    await dialog.getByRole("checkbox").nth(1).check();
    await dialog.getByRole("button", { name: "Lägg till rad" }).click();
    await dialog.getByPlaceholder("Sök konto…").fill("1940");
    await dialog.getByPlaceholder("Kredit").fill(AMOUNT);
    await b.getByRole("button", { name: "Rätta verifikatet" }).click();

    // Refused, and the refusal is the interesting part. The dialog's own
    // arithmetic is satisfied: debit equals credit, two lines remain. What the
    // RPC objects to is downstream: 1930 is what the bank statement is
    // reconciled against, so a rättelse that empties it would leave the books
    // disagreeing with the bank while every entry still balanced.
    await expect(
      b.getByText(/verifikationen är kopplad till en banktransaktion/),
      "the refusal names the bank link rather than failing on arithmetic",
    ).toBeVisible({ timeout: 20000 });
    await expect(b.getByText(/-43120\.00 kr/)).toBeVisible();

    // And it names the track that does work here, which is the whole point of
    // BFL 5 kap. 5 § having two of them.
    await expect(
      b.getByText(/använd rättelseverifikat \(storno\)/),
      "the refusal points at the correction track that does apply",
    ).toBeVisible();

    // Nothing moved.
    const lines = await ctx.svc.supabase.sql<{
      account_number: string;
      debit: string;
      credit: string;
    }>`
      select account_number, debit_amount::text as debit,
             credit_amount::text as credit
      from public.journal_entry_lines
      where journal_entry_id = ${entry[0]!.id.unwrap()}::uuid
      order by account_number`;
    expect(lines).toHaveLength(2);
    expect(lines[0]?.account_number).toBe("1630");
    expect(lines[1]?.account_number).toBe("1930");

    const log = await ctx.svc.supabase.sql<{ n: number }>`
      select count(*)::int as n from public.journal_entry_rattelse_log`;
    expect(log[0]?.n, "a refused rättelse is not logged as one").toBe(0);

    return ctx.parent;
  },
);
