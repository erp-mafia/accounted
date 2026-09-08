/**
 * Representation: the one expense whose VAT deduction is capped by law.
 *
 * Since the 2017 reform a representation meal is not deductible for income tax
 * at all, but the VAT on it still is, up to a base of 300 kr per person and
 * occasion (ML 13 kap. 24-25 §§). A 2 240 kr dinner for two is therefore an
 * ordinary cost with an extraordinary rule attached, and the rule depends on
 * something no bank feed can know: how many people were there.
 *
 * So the app cannot compute the cap, and does not pretend to. What it can do
 * is put the rule in front of the person booking it, which is what this test
 * asserts. A template that carries the law in a field nobody reads is not
 * compliance, it is documentation.
 */
import { expect } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";
import { connectBank } from "./bank";

const RESTAURANT = "Kortköp RESTAURANG STRANDV";

export const representationSurfacesItsCap = env.test(
  "booking a restaurant charge as representation states the VAT cap",
  { dependsOn: connectBank },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(`${APP_URL}/transactions`);
    const row = b.locator("tr").filter({ hasText: RESTAURANT }).first();
    await expect(row).toBeVisible({ timeout: 45000 });
    await row.getByRole("button", { name: "Bokför", exact: true }).click({
      timeout: 20000,
    });

    // The merchant category code carries it: mcc 5812 is a restaurant, and
    // the representation template lists 5812 among the codes it answers to.
    // Nothing else about "RESTAURANG STRANDV" would tell the app what kind of
    // expense this is.
    await b
      .getByRole("button", { name: /[Rr]epresentation/ })
      .first()
      .click();

    // The rule, before the booking rather than after it. Both numbers matter
    // and neither is derivable from the amount: 300 kr is the base the VAT
    // may be claimed on, 46 kr the schablon when food and alcohol are mixed.
    const review = b.getByRole("dialog");
    await expect(
      review,
      "the cap is stated where the decision is made, not filed in a template",
    ).toContainText("300 kr");
    await expect(review).toContainText("46 kr");

    return ctx.parent;
  },
);
