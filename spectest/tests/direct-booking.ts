/**
 * Direct booking: a decision the company already made does not need a
 * review. A mapping rule of the company's own that matches the row books
 * from the row's Bokför, the toast says what and why, and Ångra sits on
 * it. Everything the rule did not decide (a catalog keyword match, a
 * rule the system only proposed) still opens Granska bokföring, which the
 * representation test covers.
 */
import { expect } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";
import { connectBank } from "./bank";
import { ACCOUNT } from "./signup";

const TELIA = "Autogiro Telia 4471028";

export const ruleBooksFromTheRow = env.test(
  "a matched rule books from the row, with Ångra on the toast",
  { dependsOn: connectBank },
  async (ctx) => {
    // The company's own rule: anything with "telia" in the bank text is the
    // mobile subscription template. Not a system default (company_id set),
    // not asking for a review.
    await ctx.svc.supabase.sql`insert into public.mapping_rules
      (user_id, company_id, rule_name, rule_type, description_pattern, template_id, is_active, requires_review, confidence_score, source, priority)
      select u.id, c.id, 'Telia', 'description_pattern', 'telia', 'telecom_mobile', true, false, 0.9, 'user_description', 200
      from public.companies c, auth.users u where u.email = ${ACCOUNT.email} limit 1`;

    const b = await ctx.browser();
    await b.goto(`${APP_URL}/transactions`);

    const row = b.locator("tr").filter({ hasText: TELIA }).first();
    await expect(row).toBeVisible({ timeout: 45000 });
    // The chip is the rule's template, not a keyword guess.
    await expect(row.locator('button[class*="max-w-[16rem]"]')).toHaveText(/Mobilabonnemang/);

    await row.getByRole("button", { name: "Bokför", exact: true }).click({ timeout: 20000 });

    // No review: the toast names the booking and why it happened, and
    // offers the way back.
    await expect(b.getByText("Bokförd")).toBeVisible({ timeout: 20000 });
    await expect(b.getByText(/Mobilabonnemang · enligt din regel/i)).toBeVisible();
    await expect(b.getByRole("button", { name: "Ångra" })).toBeVisible();
    await expect(b.getByRole("dialog").filter({ hasText: "Granska bokföring" })).toHaveCount(0);

    // The verifikat is the template's: 6211 against the bank, VAT split out.
    const lines = await ctx.poll("the verifikat is posted", async () => {
      const rows = await ctx.svc.supabase.sql<{ account_number: string; status: string }>`
        select jel.account_number, je.status
        from public.journal_entries je
        join public.journal_entry_lines jel on jel.journal_entry_id = je.id
        where je.description = ${TELIA}
        order by jel.account_number`;
      return rows.unwrap().length === 3 ? rows : null;
    });
    // Ordered by account: the bank leg, the input VAT, the subscription.
    expect(lines).toHaveLength(3);
    expect(lines[0]?.account_number).toBe("1930");
    expect(lines[1]?.account_number).toBe("2641");
    expect(lines[2]?.account_number).toBe("6211");
    expect(lines[0]?.status).toBe("posted");

    return ctx.parent;
  },
);
