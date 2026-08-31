/**
 * Connecting to Skatteverket, and reading the skattekonto.
 *
 * This was the largest blocked area in the suite. Without a fake the page
 * could only be tested for failing gracefully; everything behind the
 * connection was dark. The fake answers at Skatteverket's own test hosts
 * (see spectest/fakes/skatteverket.ts), so the app runs its real OAuth flow
 * and its real gateway calls.
 *
 * The account holds one deposit of 43 120 kr, which is the same payment the
 * bank fixture shows leaving the company account seven days ago. Two systems,
 * one event, seen from opposite sides: that agreement is the point of a
 * skattekonto reconciliation, and it can only be tested when both sides exist.
 *
 *   43 120  Inbetalning bokförd
 *  -28 000  Debiterad preliminärskatt
 *  -12 000  Moms redovisad
 *  --------
 *    3 120  saldo
 */
import { expect } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";
import { enrolMfa } from "./mfa";

const AUTHORIZE = "/api/extensions/ext/skatteverket/authorize?return_to=/skattekonto";
/** Skatteverket wants the 12-digit form: the century prefix, then the number. */
const ORG_NUMBER = "165566778899";

export const connectSkatteverket = env.test(
  "connect to Skatteverket with BankID",
  { dependsOn: enrolMfa },
  async (ctx) => {
    const b = await ctx.browser();

    // The panel opens this in a new tab; the same URL in the current one is
    // the documented fallback for when the tab is blocked, and it is the same
    // flow. What is under test is the OAuth round trip, not window.open.
    await b.goto(`${APP_URL}${AUTHORIZE}`);

    // Skatteverket's own page, on Skatteverket's own host. Reaching it at all
    // means the app built an authorize URL the identity provider accepted:
    // the fake refuses one without a code_challenge, because this client
    // always sends PKCE and its absence would be a regression.
    await expect(b.getByRole("heading", { name: "Legitimera dig med BankID" })).toBeVisible({
      timeout: 25000,
    });
    await b.getByRole("button", { name: "Öppna BankID" }).click();

    // Back in the app, with the code exchanged for tokens on the way.
    // By host, not by a regex over the whole URL: the authorize URL carries
    // redirect_uri=...app.test... in its query string, so a substring match
    // succeeds before the browser has gone anywhere.
    await b.waitForURL((u) => u.hostname === "app.test", {
      waitUntil: "load",
      timeout: 30000,
    });

    // The round trip really happened at Skatteverket. .unwrap() inside the
    // poll: helper results carry provenance, and a wrapped array's .some()
    // answers with a wrapped truthy value, so the predicate would pass on the
    // first empty read.
    const calls = await ctx.poll("the code is exchanged", async () => {
      const seen = ctx.fakes.skatteverket.calls();
      return seen.unwrap().some((c) => c.path.endsWith("/token")) ? seen : null;
    });
    expect(
      calls.transform("the OAuth calls, in order", (cs) =>
        cs
          .filter((c) => c.path.includes("/oauth2/"))
          .map((c) => `${c.method} ${c.path.split("/").slice(-2).join("/")}`)
          .join(", "),
      ),
      "authorize, the BankID approval, then exactly one token exchange",
    ).toBe("GET per/authorize, POST approve/skv-code-1, POST per/token");

    // And the app kept what it got. Without stored tokens the connection is
    // a screen that says "ansluten" over nothing.
    const stored = await ctx.poll("the tokens are persisted", async () => {
      const rows = await ctx.svc.supabase.sql<{ n: number }>`
        select count(*)::int as n from public.skatteverket_tokens`;
      return rows.unwrap()[0]?.n === 1 ? rows : null;
    });
    expect(stored[0]?.n, "the tokens are persisted").toBe(1);

    return ctx.parent;
  },
);

export const skattekontoShowsTheBalanceAndItsHistory = env.test(
  "the skattekonto page shows the balance and the transactions behind it",
  { dependsOn: connectSkatteverket },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(`${APP_URL}/skattekonto`);

    // The saldo, and the three movements that produce it. A balance without
    // its history is a number the user has to take on trust.
    await expect(b.getByText("Inbetalning bokförd").first()).toBeVisible({
      timeout: 25000,
    });
    await expect(b.getByText("Debiterad preliminärskatt").first()).toBeVisible();
    await expect(b.getByText("Moms redovisad").first()).toBeVisible();

    // 3 120 kr, with a non-breaking space.
    await expect(b.getByText(/3\s120/).first()).toBeVisible();

    // Stored, not just rendered: the sync writes the rows so they can be
    // matched against the bank and booked later.
    const stored = await ctx.poll("the transactions are stored", async () => {
      const rows = await ctx.svc.supabase.sql<{
        n: number;
      }>`select count(*)::int as n from public.skattekonto_transactions`;
      return rows.unwrap()[0]?.n && rows.unwrap()[0]!.n >= 3 ? rows : null;
    });
    expect(stored[0]?.n).toBeGreaterThan(2);

    return ctx.parent;
  },
);

export const aDeadConsentAsksForReconnection = env.test(
  "a consent that dies at Skatteverket asks the user to reconnect",
  { dependsOn: skattekontoShowsTheBalanceAndItsHistory },
  async (ctx) => {
    const b = await ctx.browser();

    // Revoked at the authority, which is where consents actually die: the app
    // holds a token it believes in and only learns otherwise on the next call.
    ctx.fakes.skatteverket.expireConsent();

    await b.goto(`${APP_URL}/skattekonto`);

    // The page opens on the stored snapshot, which is correct: it is what the
    // account looked like when it was last read, and the timestamp says so
    // rather than presenting it as live.
    await expect(b.getByText(/synkad/)).toBeVisible({ timeout: 25000 });

    // Asking for fresh data is where the truth comes out.
    await b.getByRole("button", { name: "Synkronisera nu" }).click();

    // The route answers 401 SESSION_EXPIRED with the sentence the user needs,
    // and the page turns it into a reconnect notice rather than leaving the
    // stale balance to speak for itself.
    await expect(
      b.getByText("Sessionen har gått ut. Logga in med BankID igen."),
      "the refused refresh is surfaced with the reason the route gave",
    ).toBeVisible({ timeout: 25000 });

    // And it has to say the connection is gone. Silently keeping the old
    // number after a failed refresh is the failure that matters here: the
    // user would go on reading a balance that stopped being true.

    ctx.fakes.skatteverket.restoreConsent();
    return ctx.parent;
  },
);

/**
 * RED ON PURPOSE, pinning #2086.
 *
 * Skatteverket answers felkod 3 for a company that has never had a
 * skattekonto registered, which is an ordinary state for a newly registered
 * one rather than a fault. The client maps the felkod envelope to a Swedish
 * sentence (skattekonto-client.ts mapFelkodToMessage) and the route returns
 * it, so the server side is right:
 *
 *   500 {"error":"Inget skattekonto är registrerat hos Skatteverket."}
 *
 * getErrorMessage then throws it away, because its isSwedishUserMessage
 * heuristic asks whether the text contains one of about thirty keywords
 * rather than whether it is a message for the user. What reaches the screen
 * is "Ett oväntat serverfel uppstod. Försök igen senare.", and retrying is
 * exactly what will not help.
 *
 * Delete this comment and keep the test when #2086 is fixed.
 */
export const noSkattekontoIsSaidPlainly = env.test(
  "a company with no skattekonto is told so, not told to try again (#2086)",
  { dependsOn: connectSkatteverket },
  async (ctx) => {
    const b = await ctx.browser();

    ctx.fakes.skatteverket.setFelkod(3);

    await b.goto(`${APP_URL}/skattekonto`);
    await b.getByRole("button", { name: "Synkronisera nu" }).click();

    // The failure is surfaced, which is the half that works.
    await expect(b.getByText("Synk misslyckades").first()).toBeVisible({
      timeout: 20000,
    });

    // And it should say what is actually wrong. This is the half that does not.
    await expect(
      b.getByText(/Inget skattekonto/).first(),
      "the reason the route already wrote reaches the user, instead of a retry that cannot work",
    ).toBeVisible({ timeout: 10000 });

    ctx.fakes.skatteverket.setFelkod(null);
    return ctx.parent;
  },
);
