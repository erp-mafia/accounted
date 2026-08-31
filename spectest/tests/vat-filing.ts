/**
 * Filing the momsdeklaration at Skatteverket.
 *
 * `vat.ts` builds the declaration and books it to 2650. This is the step
 * after, and the one where a mistake costs money rather than tidiness: what
 * leaves the building is what Skatteverket acts on.
 *
 * The chain is three calls, and the order is the safety property
 * (lib/skatteverket vat-submit.ts):
 *
 *   POST /kontrollera  validate, saving nothing
 *   POST /utkast       save the draft to Eget utrymme
 *   PUT  /las          lock for signing, returns the BankID link
 *
 * Signing happens at Skatteverket, on Skatteverket's own page, so the app can
 * never claim a declaration is filed. It can only say it is locked and hand
 * over the link. That distinction is what the last test pins: a receipt exists
 * only once a human has signed.
 *
 * Runs on the SIE-migrated company, whose Q1 2025 is the small, fully asserted
 * quarter from vat.ts: 2 000 kr to pay.
 */
import { expect } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";
import { vatDeclarationForQ1 } from "./vat";

/** Skatteverket's own identifiers: 12-digit org number, year + period. */
const REDOVISARE = "165566778899";
const PERIOD = "202503";

/** Connect, then open the filing step for Q1 2025. */
async function openFilingStep(
  b: Awaited<ReturnType<Parameters<Parameters<typeof env.test>[2]>[0]["browser"]>>,
) {
  await b.goto(`${APP_URL}/reports/vat-declaration`);
  await b.getByRole("button", { name: "Redovisningsperiod" }).click();
  await b.getByRole("option", { name: /Kvartal 1 2025/ }).click();
  await b.getByRole("tab", { name: /Lämna in till Skatteverket/ }).click();
}

export const connectForFiling = env.test(
  "connect this company to Skatteverket too",
  { dependsOn: vatDeclarationForQ1 },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(
      `${APP_URL}/api/extensions/ext/skatteverket/authorize?return_to=/reports/vat-declaration`,
    );
    await b.getByRole("button", { name: "Öppna BankID" }).click();
    await b.waitForURL((u) => u.hostname === "app.test", {
      waitUntil: "load",
      timeout: 30000,
    });

    await openFilingStep(b);
    await expect(b.getByText("Ansluten").first()).toBeVisible({ timeout: 25000 });

    return ctx.parent;
  },
);

export const aValidationErrorStopsBeforeAnythingIsSaved = env.test(
  "a validation error at Skatteverket stops before any draft exists",
  { dependsOn: connectForFiling },
  async (ctx) => {
    const b = await ctx.browser();

    // Skatteverket disagrees with the arithmetic. This is the whole reason
    // kontrollera comes first: it validates without saving, so a rejected
    // declaration leaves nothing behind at the authority to clean up.
    ctx.fakes.skatteverket.setKontroll([
      { kod: "49", status: "ERROR", beskrivning: "Ruta 49 stämmer inte med 10 minus 48." },
    ]);

    await openFilingStep(b);
    await b.getByRole("button", { name: "Skicka till Skatteverket" }).click();

    await expect(
      b.getByText(/valideringsfel/),
      "the refusal names validation, not a generic failure",
    ).toBeVisible({ timeout: 25000 });

    // And nothing was saved. A draft left behind after a failed validation
    // would be a half-filed declaration nobody knows about.
    const calls = ctx.fakes.skatteverket.calls();
    expect(
      calls.transform("the momsdeklaration calls", (cs) =>
        cs
          .filter((c) => c.path.includes("/momsdeklaration/"))
          .map((c) => c.path.split("/")[3])
          .join(", "),
      ),
      "validation ran and the chain stopped there",
    ).toBe("kontrollera");

    expect(ctx.fakes.skatteverket.declaration(PERIOD)).toBe(null);

    ctx.fakes.skatteverket.setKontroll([]);
    return ctx.parent;
  },
);

export const theDeclarationIsDraftedAndLockedForSigning = env.test(
  "a clean declaration is drafted and locked, and the app stops there",
  { dependsOn: connectForFiling },
  async (ctx) => {
    const b = await ctx.browser();

    await openFilingStep(b);
    await b.getByRole("button", { name: "Skicka till Skatteverket" }).click();

    // Locked, not filed. The app is precise about this because it cannot sign:
    // signing is a BankID act by a named person on Skatteverket's own page.
    await expect(
      b.getByText(/Utkastet är låst och redo att signeras/),
      "the app says locked and ready, never filed",
    ).toBeVisible({ timeout: 30000 });
    await expect(b.getByText(/Öppna länken|signeringslänk/).first()).toBeVisible();

    const calls = ctx.fakes.skatteverket.calls();
    expect(
      calls.transform("the momsdeklaration calls, in order", (cs) =>
        cs
          .filter((c) => c.path.includes("/momsdeklaration/"))
          .map((c) => `${c.method} ${c.path.split("/")[3]}`)
          .join(", "),
      ),
      "validate, then save, then lock: in that order and once each",
    ).toBe("POST kontrollera, POST utkast, PUT las");

    // Sent for the right company and the right quarter. Q1 2025 is period
    // 202503 in Skatteverket's numbering, the month the quarter ends.
    expect(
      calls.transform("who and when it was filed for", (cs) => {
        const c = cs.find((x) => x.path.includes("/las/"));
        return c ? `${c.org} ${c.path.split("/").pop()}` : null;
      }),
    ).toBe(`${REDOVISARE} ${PERIOD}`);

    // Skatteverket's own view agrees: a locked draft, no receipt.
    const state = ctx.fakes.skatteverket.declaration(PERIOD);
    expect(state?.stage).toBe("locked");
    expect(state?.kvittensnummer ?? null).toBe(null);

    return ctx.parent;
  },
);

export const theReceiptArrivesOnlyAfterAHumanSigns = env.test(
  "the kvittens appears only after someone has signed",
  { dependsOn: theDeclarationIsDraftedAndLockedForSigning },
  async (ctx) => {
    const b = await ctx.browser();

    // Before signing, Skatteverket holds a locked draft and no receipt: a
    // fetch of /inlamnat answers 404. The app must not present the locked
    // draft as filed on the strength of having locked it.
    expect(ctx.fakes.skatteverket.declaration(PERIOD)?.stage).toBe("locked");
    await openFilingStep(b);

    // The user signs with BankID at Skatteverket, which is the one step this
    // system deliberately cannot perform on their behalf.
    ctx.fakes.skatteverket.sign(PERIOD);

    // The receipt check lives behind the overflow menu: it is a rarely-used
    // action next to the one button that matters.
    await b.getByRole("button", { name: "Fler åtgärder" }).click();
    await b.getByRole("menuitem", { name: /[Kk]ontrollera inlämning|kvittens/ }).click();

    // Now there is a receipt, and it is the receipt that proves the filing.
    await expect(
      b.getByText(new RegExp(`KV-${PERIOD}-1`)),
      "the kvittens number is shown: it is the evidence the declaration was filed",
    ).toBeVisible({ timeout: 25000 });

    return ctx.parent;
  },
);
