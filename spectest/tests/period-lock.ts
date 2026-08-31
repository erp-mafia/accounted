/**
 * Locking a fiscal year, and what the lock is worth.
 *
 * `year-end.ts` covers whether the app lets you close a year blind. This is
 * the act itself. A lock is only meaningful if every write path respects it,
 * and it is only lawful if lifting it leaves a trace: BFL 5 kap. 11 § wants
 * the processing history to show who did what, and unlocking a closed period
 * is exactly the kind of thing an auditor asks about.
 *
 * So the chain is: lock, then be refused, then unlock and find the unlocking
 * in the behandlingshistorik. Runs on the SIE-migrated company, whose 2025 is
 * a finished year with real entries in it.
 */
import { expect } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";
import { importSieFile } from "./sie-import";

export const lockTheMigratedYear = env.test(
  "lock the finished fiscal year",
  { dependsOn: importSieFile },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(`${APP_URL}/settings/bookkeeping`);
    // The years are a list, newest first, each with its own Lås button. Gate
    // on the row's text before reaching for the button, and let the database
    // assertion below catch a mis-click: it names the period explicitly.
    await expect(b.getByText(/Räkenskapsår 20252025-01-01/)).toBeVisible({
      timeout: 25000,
    });
    await b.getByRole("button", { name: "Lås", exact: true }).nth(1).click();

    // The confirmation says what the lock costs, in the terms the user cares
    // about: no more bookkeeping in the period until it is lifted again.
    await expect(b.getByText("Lås räkenskapsår?")).toBeVisible();
    await expect(
      b.getByText(/Inga nya verifikationer kan bokföras i perioden/),
      "the dialog states the consequence rather than asking for a blind yes",
    ).toBeVisible();
    await b.getByRole("button", { name: "Lås", exact: true }).last().click();

    const period = await ctx.poll("the year is locked", async () => {
      const rows = await ctx.svc.supabase.sql<{ locked: boolean }>`
        select locked_at is not null as locked
        from public.fiscal_periods where period_end = '2025-12-31'`;
      return rows.unwrap()[0]?.locked ? rows : null;
    });
    expect(period[0]?.locked).toBe(true);

    return ctx.parent;
  },
);

export const theLockRefusesANewVerifikat = env.test(
  "the lock refuses a verifikat dated inside the closed year",
  { dependsOn: lockTheMigratedYear },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(`${APP_URL}/bookkeeping`);
    await b.getByRole("button", { name: /^Tomt verifikat/ }).first().click();

    const dialog = b.getByRole("dialog", { name: "Ny verifikation" });
    await dialog.getByPlaceholder("Verifikationstext...").fill("Efterhandsjustering");
    // Inside the locked year. The date is the whole point: the same entry a
    // day later would be fine.
    await dialog.locator('input[type="date"]:visible').first().fill("2025-06-30");

    const account = dialog.locator('input[placeholder="Sök konto…"]:visible');
    const money = dialog.locator('input[placeholder="0,00"]:visible');
    await account.nth(0).fill("1930");
    await money.nth(0).fill("1000");
    await account.nth(1).fill("3001");
    await money.nth(3).fill("1000");

    await dialog.getByRole("button", { name: "Granska & skapa" }).click();
    await b.getByRole("button", { name: "Bokför utan underlag" }).click();

    // Refused, and the reason names the lock. The DB trigger is the actual
    // guard, so this also proves the trigger is reached rather than the UI
    // deciding on its own.
    await expect(
      b.getByText(/låst|stängd/).first(),
      "the refusal names the lock rather than failing generically",
    ).toBeVisible({ timeout: 25000 });

    const entries = await ctx.svc.supabase.sql<{ n: number }>`
      select count(*)::int as n from public.journal_entries
      where description = 'Efterhandsjustering'`;
    expect(entries[0]?.n, "nothing was written into the locked year").toBe(0);

    return ctx.parent;
  },
);

export const unlockingIsRecordedInTheHistory = env.test(
  "unlocking the year is recorded in the behandlingshistorik",
  { dependsOn: theLockRefusesANewVerifikat },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(`${APP_URL}/settings/bookkeeping`);
    await expect(b.getByText(/Räkenskapsår 20252025-01-01/)).toBeVisible({
      timeout: 25000,
    });
    await b.getByRole("button", { name: "Lås upp", exact: true }).first().click();

    // The dialog says the unlocking is logged, which is the honest thing to
    // tell someone before they do it.
    await expect(b.getByText("Lås upp räkenskapsår?")).toBeVisible();
    await expect(
      b.getByText(/loggas i behandlingshistoriken/),
      "the user is told the act is recorded before they perform it",
    ).toBeVisible();
    await b.getByRole("button", { name: "Lås upp", exact: true }).last().click();

    const period = await ctx.poll("the year is unlocked", async () => {
      const rows = await ctx.svc.supabase.sql<{ locked: boolean }>`
        select locked_at is not null as locked
        from public.fiscal_periods where period_end = '2025-12-31'`;
      return rows.unwrap()[0]?.locked === false ? rows : null;
    });
    expect(period[0]?.locked).toBe(false);

    // And it is really in the history, with an actor. BFL 5 kap. 11 § asks
    // what was done, when and by whom; an unlocking that left no trace would
    // be the one event an auditor most wants to see and could not.
    await b.goto(`${APP_URL}/reports/behandlingshistorik`);
    await expect(b.getByRole("button", { name: "Räkenskapsår" })).toBeVisible({
      timeout: 25000,
    });
    await b.getByRole("button", { name: "Räkenskapsår" }).click();
    await b.getByRole("option", { name: "Räkenskapsår 2026" }).click();

    // Both events by name, not a family of words: "Räkenskapsår låst" and
    // "Räkenskapsår upplåst" are what the report emits, and asserting the
    // exact labels is what stops this passing on the word "Lås" appearing
    // somewhere else on the page.
    await expect(b.getByText("Räkenskapsår låst").first()).toBeVisible({
      timeout: 20000,
    });
    await expect(
      b.getByText("Räkenskapsår upplåst").first(),
      "the unlocking is in the history, which is the event an auditor asks about",
    ).toBeVisible();
    await expect(b.getByText("flow@example.test").first()).toBeVisible();

    return ctx.parent;
  },
);
