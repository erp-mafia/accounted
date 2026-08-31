/**
 * Creating an account.
 *
 * The root of the DAG. Everything else forks from the state this leaves
 * behind, so the sign-up cost is paid once.
 *
 * Note what does NOT happen here: MFA. Hosted requires it
 * (NEXT_PUBLIC_REQUIRE_MFA=true) but lib/supabase/middleware.ts deliberately
 * skips forced enrolment while the user has no company — "still setting up".
 * A brand-new account therefore goes straight into onboarding, and enrolment
 * is forced on the first navigation after a company exists. That ordering is
 * asserted here and in mfa.ts rather than assumed, because getting it
 * backwards is the kind of thing a refactor changes silently.
 */
import { expect } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";

/**
 * Fixed values, not generated ones. A restored snapshot hands every run and
 * every parallel fork the same `crypto.randomUUID()`, so a "unique" value
 * would not be unique anyway, and a stable one keeps the run diff readable.
 */
export const ACCOUNT = {
  email: "signup-flow@example.test",
  password: "Testlosenord1!",
};

export const signUp = env.test("create an account", async (ctx) => {
  const b = await ctx.browser();

  await b.goto(`${APP_URL}/register`);

  // Ids rather than labels: they survive the sv/en split, so a translation
  // change does not break the suite.
  await b.locator("#email").fill(ACCOUNT.email);
  await b.locator("#password").fill(ACCOUNT.password);
  await b.locator("#confirm_password").fill(ACCOUNT.password);
  await b.getByRole("button", { name: /Skapa konto|Create account/i }).click();

  // Straight into onboarding: no company yet, so MFA enrolment is not forced.
  await b.waitForURL(/\/onboarding/, { waitUntil: "load" });
  await expect(b.getByText("Vad är ert organisationsnummer?")).toBeVisible();

  const users = await ctx.svc.supabase.sql<{
    id: string;
    email: string;
  }>`select id, email from auth.users where email = ${ACCOUNT.email}`;
  expect(users).toHaveLength(1);

  // The account exists but owns nothing yet. A company appearing here would
  // mean the onboarding test asserts against one it did not create.
  const companies = await ctx.svc.supabase.sql<{
    n: number;
  }>`select count(*)::int as n from public.companies`;
  expect(companies[0]?.n).toBe(0);

  // And no second factor, which is what makes the middleware's "still setting
  // up" exemption observable rather than a claim about the code.
  const factors = await ctx.svc.supabase.sql<{ n: number }>`
    select count(*)::int as n from auth.mfa_factors
    where user_id = (select id from auth.users where email = ${ACCOUNT.email})`;
  expect(factors[0]?.n).toBe(0);

  return { email: ACCOUNT.email };
});
