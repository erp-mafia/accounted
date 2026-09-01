/**
 * Inviting someone else into the company.
 *
 * Every other test in this suite runs as one person in one company, which
 * leaves the whole multi-user dimension unexercised: roles, invitations, and
 * the tenancy boundary that keeps one company's books out of another's.
 *
 * The interesting property here is that the invite link is always returned,
 * not only mailed (#1710). A self-hosted deployment may have no mail provider
 * at all, and an invitation that exists only inside an email nobody can send
 * is an invitation that does not exist. So the app hands the link over and
 * lets the inviter deliver it however they like.
 *
 * The invite secret is stored hashed, which matters more than it looks: with
 * no mail provider the link IS the credential, so a table full of usable
 * tokens would be a way into every company with an invitation outstanding.
 */
import { expect } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";
import { enrolMfa } from "./mfa";

const INVITEE = "revisorn@byra.test";

export const inviteAViewer = env.test(
  "invite someone with read-only access",
  { dependsOn: enrolMfa },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(`${APP_URL}/settings/company-profile`);
    await expect(b.getByText("Medlemmar")).toBeVisible({ timeout: 25000 });

    // One member so far: the person who signed up.
    await expect(b.getByText("(du)")).toBeVisible();

    await b.locator('input[placeholder="namn@example.com"]').fill(INVITEE);
    await b.getByRole("combobox").last().click();
    await b.getByRole("option", { name: "Läsbehörighet" }).click();
    await b.getByRole("button", { name: "Bjud in", exact: true }).click();

    const invite = await ctx.poll("the invitation exists", async () => {
      const rows = await ctx.svc.supabase.sql<{
        email: string;
        role: string;
        status: string;
        hashed: boolean;
      }>`
        select email, role, status,
               token_hash is not null and length(token_hash) = 64 as hashed
        from public.company_invitations`;
      return rows.unwrap().length === 1 ? rows : null;
    });

    expect(invite[0]?.email).toBe(INVITEE);
    expect(invite[0]?.role, "the role travels with the invitation").toBe("viewer");
    // Pending: an invitation is not a membership until someone acts on it.
    expect(invite[0]?.status).toBe("pending");

    // The token is stored HASHED, not in clear text. The link is the only way
    // in when there is no mail provider, so anyone who could read this table
    // would otherwise be able to walk into every company that had an
    // invitation outstanding.
    expect(
      invite[0]?.hashed,
      "the invite secret is stored as a hash, not recoverable from the database",
    ).toBe(true);

    // And the app offers the link rather than only promising an email.
    await expect(
      b.getByRole("button", { name: "Kopiera inbjudningslänk" }),
      "the link is handed over, so an invite works without a mail provider",
    ).toBeVisible({ timeout: 20000 });

    return ctx.parent;
  },
);

export const theInvitationCanBeRevoked = env.test(
  "an invitation can be taken back before it is accepted",
  { dependsOn: inviteAViewer },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(`${APP_URL}/settings/company-profile`);
    await expect(b.getByText(INVITEE)).toBeVisible({ timeout: 25000 });

    await b.getByRole("button", { name: "Återkalla inbjudan" }).click();

    const left = await ctx.poll("the invitation is gone", async () => {
      const rows = await ctx.svc.supabase.sql<{ n: number }>`
        select count(*)::int as n from public.company_invitations
        where status = 'pending'`;
      return rows.unwrap()[0]?.n === 0 ? rows : null;
    });
    expect(left[0]?.n).toBe(0);

    // The company still has exactly the one member it started with: revoking
    // an invitation must not touch anyone who already belongs.
    const members = await ctx.svc.supabase.sql<{ n: number }>`
      select count(*)::int as n from public.company_members`;
    expect(members[0]?.n, "revoking an invite touches no existing member").toBe(1);

    return ctx.parent;
  },
);
