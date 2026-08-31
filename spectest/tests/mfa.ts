/**
 * Two-factor enrolment and the challenge on the next sign-in.
 *
 * MFA is left switched on for the whole suite rather than disabled for
 * convenience: it is a screen every hosted user passes through, and a suite
 * that skipped it would never notice the screen breaking. The secret is read
 * off the enrolment page, exactly as a user copying it into an authenticator
 * app would, and the codes are computed from it.
 */
import { expect } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";
import { totp, nextDistinctTotp } from "../lib/totp";
import { ACCOUNT } from "./signup";
import { chooseFreshStart } from "./onboarding";

export const enrolMfa = env.test(
  "enrol a TOTP factor",
  { dependsOn: chooseFreshStart },
  async (ctx) => {
    const b = await ctx.browser();

    // The enrolment page opens on an explanation, not the QR.
    await expect(b.getByRole("heading", { name: "Aktivera tvåfaktorsautentisering" })).toBeVisible();
    await b.getByRole("button", { name: "Fortsätt", exact: true }).click();

    // The secret is offered in text for anyone who cannot scan the QR, which
    // is what an authenticator app consumes. Reading it beats decoding an
    // image, and it also checks that the fallback a real user may need is
    // actually there.
    await expect(b.getByText("Kan du inte skanna? Ange denna nyckel manuellt:")).toBeVisible();
    const secret = await b.locator("code").first().textContent();
    expect(secret, "the enrolment screen shows a base32 secret").toMatch(/^[A-Z2-7]{16,}$/);
    const rawSecret = (secret?.unwrap() ?? "").trim();

    const code = totp(rawSecret);
    await b.locator("#code").fill(code);
    await b.getByRole("button", { name: /Aktivera|Verifiera|Activate|Verify/i }).click();

    // Enrolment done, the user is let into the app. The page pushes to the
    // returnTo it was given, which defaults to "/", so wait for the URL to
    // leave /mfa rather than naming a destination. The push lands after the
    // new aal2 tokens are persisted, which takes longer than the 5s default.
    await b.waitForURL((u) => !u.pathname.startsWith("/mfa"), {
      waitUntil: "load",
      timeout: 20000,
    });
    await expect(b.getByRole("link", { name: "Hem", exact: true }).first()).toBeVisible();

    const factors = await ctx.svc.supabase.sql<{
      status: string;
      factor_type: string;
    }>`
      select status, factor_type from auth.mfa_factors
      where user_id = (select id from auth.users where email = ${ACCOUNT.email})`;
    expect(factors).toHaveLength(1);
    // Unverified would mean the factor exists but the challenge never
    // completed, which locks the user out on the next sign-in.
    expect(factors[0]?.status).toBe("verified");
    expect(factors[0]?.factor_type).toBe("totp");

    return { ...ctx.parent, secret: rawSecret, lastCode: code };
  },
);

/**
 * Signing in again. A different thing from enrolling, and a different thing
 * that can break: this path challenges an existing factor.
 */
export const signInWithMfa = env.test(
  "sign in again and answer the TOTP challenge",
  { dependsOn: enrolMfa },
  async (ctx) => {
    // A NAMED browser: a fresh session rather than the signed-in page the
    // parent left behind, which would be the wrong starting point for a login.
    const b = await ctx.browser("returning");
    const { secret, lastCode } = ctx.parent;

    await b.goto(`${APP_URL}/login`);
    await b.locator("#email").fill(ACCOUNT.email);
    await b.locator("#password").fill(ACCOUNT.password);
    await b.getByRole("button", { name: /Logga in|Sign in/i }).click();

    // The password alone must not be enough. A session that reached the app
    // from here would be an authentication bypass, not a cosmetic bug.
    await b.waitForURL(/\/mfa\/verify/, { waitUntil: "load", timeout: 30000 });

    // Supabase refuses a code already spent inside the same 30s step, which is
    // exactly what a test does when it verifies twice in quick succession.
    await b.locator("#code").fill(nextDistinctTotp(secret, lastCode));
    await b.getByRole("button", { name: /Verifiera|Verify|Fortsätt|Continue/i }).click();

    await b.waitForURL((u) => !u.pathname.startsWith("/mfa"), {
      waitUntil: "load",
      timeout: 20000,
    });
    // Really inside the app, not on a half-rendered redirect.
    await expect(b.getByRole("link", { name: "Hem", exact: true }).first()).toBeVisible();

    return ctx.parent;
  },
);
