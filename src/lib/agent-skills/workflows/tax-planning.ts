import type { Skill } from '../types'

const body = `# Tax Planning Before Year-End (Skatteplanering): Accounted

Before the räkenskapsår ends, work out the owner's options and what each one does to tax, result and cash. You compute and explain. You never book anything in this skill: every figure is an estimate, and the owner decides. Dispositions the owner chooses are booked later through the \`year-end-close\` skill (\`gnubok_load_skill({ slug: "year-end-close" })\`).

## When to use

- "Hur mycket skatt blir det i år?", "Ska jag sätta av till periodiseringsfond?", "Lön eller utdelning?", "Vad kan jag göra innan årsskiftet?"
- Two to three months before the fiscal year ends, when there is still time to change salary, timing of purchases or dispositions.

Not this skill: booking the bokslut (\`year-end-close\`), the monthly close (\`month-end-close\`), payroll mechanics (\`payroll-monthly\`), VAT (\`quarterly-vat-review\`).

## Where the numbers come from

Every rate and threshold below comes from Accounted's Swedish tax rule pack, with the year it applies to. **Never use a rate, threshold or percentage that is not in this table or in a tool result.** If you need one that is missing (brytpunkt for statlig skatt, municipal tax, the 8 IBB year in the 2026 3:12 löneavdrag, pension rules, anything for a year not listed), do not estimate it: say it is outside what you can compute and hand over (see Stop conditions). Always cite the year when you quote a figure ("bolagsskatt 20.6 % (2026)").

| Parameter | 2025 | 2026 |
|---|---|---|
| Bolagsskatt (AB) | 20.6 % | 20.6 % |
| Inkomstbasbelopp (IBB) | 80 600 | 83 400 |
| Prisbasbelopp (PBB) | 58 800 | 59 200 |
| Statslåneränta (SLR, 30 Nov prior year) | 1.96 % | 2.55 % |
| Arbetsgivaravgifter (standard) | 31.42 % | 31.42 % |
| Periodiseringsfond max, AB | 25 % of skattemässigt överskott before the avsättning | same |
| Periodiseringsfond max, EF | 30 % of result | same |
| Schablonintäkt on periodiseringsfonder (AB) | SLR, floor 0.5 % | same |
| Egenavgifter, full rate | 28.97 % | 28.97 % |
| Egenavgifter, pensioners born 1938-1958 | 10.21 % | 10.21 % |
| Schablonavdrag egenavgifter (active) | 25 % | 25 % |
| Positiv räntefördelning (SLR + 6) | 7.96 % | 8.55 % |
| Negativ räntefördelning (SLR + 1), mandatory below kapitalunderlag -500 000 | 2.96 % | 3.55 % |
| Expansionsfond max / skatt | 125.94 % of kapitalunderlag / 20.6 % | same |

Year to use: the year the fiscal period ends (\`period_end\` from \`gnubok_list_fiscal_periods\`). If the company has a brutet räkenskapsår and you are unsure which year's figures apply to a parameter, say so and hand over instead of picking one.

## Step 0: Orient before computing

1. **Company.** \`gnubok_list_companies\`. Several: ask which one and pass that \`company_id\` on every call. Then \`gnubok_get_agent_briefing\`: \`company.entity_type\` decides everything below. \`aktiebolag\` follows the AB track, \`enskild_firma\` the EF track. Anything else (handelsbolag, ideell förening, null): stop, this skill does not cover it; ask the user to set the legal form or hand over.
2. **Fiscal year.** \`gnubok_list_fiscal_periods\`. Take the period whose \`period_start\`/\`period_end\` contain today (or the one the user names). Note its \`status\`: \`active\` is what you want. \`closed\`: the year is already done, planning is too late; say so. \`locked\`: fine for reading, but tell the user any disposition needs it unlocked later in \`year-end-close\`. No period at all: stop and point to the \`onboarding\` skill.
3. **How far through the year are we.** Count months elapsed from \`period_start\` to today. This drives how rough the projection is.
4. **Are the books up to date.** This is the most common reason an estimate is wrong.
   - \`gnubok_list_uncategorized_transactions({ limit: 100 })\`: unbooked bank transactions, with dates. Page with \`offset\` if there are more.
   - \`gnubok_get_kpi_report({ period_id })\`: the monthly trend. A month with no revenue and no costs where the business normally has both usually means it is not booked yet, or the bank is not connected.
   - \`gnubok_year_end_readiness({ fiscal_period_id })\`: read-only here; \`unbooked_transactions\` and \`draft_entries\` tell you how much is missing.
   If anything is missing, tell the user before you give numbers: "The books are booked through [month]. [N] bank transactions from [months] are not booked yet. The estimate below will move when they are." If most of the year is unbooked, offer to run the \`bookkeep\` or \`month-end-close\` skill first and give only a rough range now.

## Step 1: Questions to ask the owner

Ask these at the start, in one message, with what you already found filled in. Do not ask what a tool already told you.

1. **Expected result for the full year.** "Booked so far this year: a result of about X kr through [month]. Do you expect the rest of the year to look the same, or are there big invoices, purchases or one-offs coming?" If they cannot say, project from the booked months (see Step 2) and label it as a straight-line estimate.
2. **Owner's other income** (salary from another employer, pension, capital income). It changes the owner's marginal tax, which you cannot compute: note it and use it only to flag that the comparison may shift.
3. **Planned owner salary** for the rest of the year (AB), or planned private withdrawals (EF). Check \`gnubok_list_employees\` first: if the owner is an employee, you see \`monthly_salary\`; confirm it with them.
4. **Liquidity needs.** "Do you need cash out of the company this year or next, or is a planned investment coming?" Cash position is in \`gnubok_get_kpi_report\`.
5. **Prior periodiseringsfonder and when they must be reversed.** AB: read them (Step 2). EF: they are declaration-only and not in the books, so ask for last year's NE-bilaga figures.
6. **Planned asset purchases** before year-end (they affect överavskrivningar).
7. **EF only:** age category for egenavgifter (full, pensioner, passive business), and kapitalunderlag from last year's NE-bilaga (needed for räntefördelning and expansionsfond; it is not the same as the equity line in the balance sheet).

Along the way, ask one precise question when a number surprises you: "The result jumped by 400 000 kr in June. Is that a one-off, or will it repeat?"

## Step 2: Gather the figures

- \`gnubok_get_income_statement({ period_id })\`: booked result so far. Use \`from_date\`/\`to_date\` to split by month if you need the run rate.
- \`gnubok_get_balance_sheet({ period_id })\`: equity, cash, obeskattade reserver.
- \`gnubok_get_general_ledger({ period_id, account_from: "2110", account_to: "2139" })\` (AB): existing periodiseringsfonder, one account per year. Account 2150 is överavskrivningar, not periodiseringsfond: never mix them.
- \`gnubok_propose_dispositioner({ fiscal_period_id })\` (AB): Accounted's own calculation of mandatory återföring, överavskrivningar, periodiseringsfond avsättning, SLP and bolagsskatt. It is based on what is **booked so far**, so mid-year it is a floor, not the full-year answer. Read \`warnings\` and \`completedDispositions\`.
- \`gnubok_preview_ef_declaration({ fiscal_period_id, category, kapitalunderlag, prior_year_schablonavdrag, prior_year_actual_charged, pfond_desired_amount })\` (EF): egenavgifter, räntefördelning, periodiseringsfond, expansionsfond. Pass only values the owner gave you; leave the rest out rather than guessing. It also works on booked-so-far figures.
- \`gnubok_list_assets\` if the owner plans purchases or asks about avskrivningar.

**Projection.** If the year is not over: full-year result estimate = booked result / months booked x months in the year, adjusted for what the owner told you. Round every money figure to whole öre (never with toFixed), then present in whole kronor. Account numbers are strings.

## Step 3: Compute the options (AB)

Follow the rule pack's order, because each step changes the base for the next:

1. **Mandatory återföring.** Each periodiseringsfond must be reversed no later than the 6th tax year after the avsättning year, oldest first. A fond reaching that limit this year adds to taxable income whether the owner wants it or not. Say which fond and the amount.
2. **Överavskrivningar.** Limited by the inventarier base (30-regeln or 20-regeln, whichever gives the larger deduction). Use the \`gnubok_propose_dispositioner\` figure; do not compute the pool yourself. Note the rule-pack warning: booking more than the tax maximum systematically for more than one year forfeits räkenskapsenlig avskrivning.
3. **Periodiseringsfond avsättning.** Up to 25 % of skattemässigt överskott before the avsättning. Show: amount, tax deferred (amount x 20.6 %), and the cost of the schablonintäkt next year (fund x SLR, floor 0.5 %, taxed at 20.6 %). Explain it is a deferral: the tax comes back when the fond is reversed, at the latest in year 6, and the cash stays in the company meanwhile. If the company is heading for a loss year, a reversal against that loss is where the saving becomes permanent.
4. **Bolagsskatt estimate.** 20.6 % of the estimated taxable result after the above. Say that non-deductible costs (e.g. representation over the limit, böter) and a prior-year underskott change the base, and that \`gnubok_propose_dispositioner\` includes the tax adjustments registered in Accounted.
5. **Lön vs utdelning (fåmansföretag).** Only the structure the rule pack gives:
   - Combined company-plus-owner burden (rule pack, approximate): utdelning within gränsbelopp about 36.5 %; lön below brytpunkt about 47-52 % including arbetsgivaravgifter; lön above brytpunkt about 58-63 %; utdelning above gränsbelopp about 52-58 %.
   - Salary is a deductible company cost plus 31.42 % arbetsgivaravgifter (2026), and builds SGI and pension. The rule pack's common pattern: salary up to the pension ceiling, 8.07 x IBB (about 673 000 kr for 2026), then utdelning within gränsbelopp.
   - Gränsbelopp, inkomstår 2026 (reformed rules): grundbelopp 4 x IBB (2025) = 322 400 kr, plus lönebaserat utrymme 50 % x (ägarandel x löneunderlag - 8 IBB), plus ränta on omkostnadsbelopp above 100 000 kr at SLR + 9 %. The 4 %-spärr and the lönekrav are abolished from 2026; the 50x cap remains. Sparat utdelningsutrymme carries forward without uppräkning.
   - 3:12 is the owner's personal tax (K10 with INK1), not the company's. You may show the grundbelopp and the arithmetic of the formula with the owner's figures. You do not decide whether the owner's shares are kvalificerade, compute the full K10, or say what the owner will pay in personal tax: that depends on facts and rates outside this skill. Hand over for that.

## Step 3: Compute the options (EF)

An enskild firma is not a skattesubjekt: the owner pays tax personally. Only överavskrivningar are booked; periodiseringsfond, expansionsfond, räntefördelning and the egenavgifter schablonavdrag exist only in the NE-bilaga and are **never booked**.

- **Egenavgifter.** Use \`gnubok_preview_ef_declaration\` with the right \`category\`. Explain the 25 % schablonavdrag and that it is reconciled against actual egenavgifter the following year.
- **Räntefördelning.** Positive räntefördelning (8.55 % for 2026) moves part of the surplus from näringsverksamhet to kapital, where the rule pack says it is taxed at 30 %. It needs a positive kapitalunderlag from the owner. Negative räntefördelning is mandatory when kapitalunderlag is below -500 000 kr.
- **Periodiseringsfond EF.** Up to 30 % of the result, same 6-year reversal, no schablonintäkt.
- **Expansionsfond.** Up to 125.94 % of kapitalunderlag; 20.6 % expansionsfondsskatt on the avsättning, credited when it is reversed; no 6-year limit.
- You cannot give the owner's final personal tax: municipal tax and statlig skatt are not in the rule pack. Show the effect on the taxable surplus instead, and say so.

## Step 4: Present and let the owner decide

Show a short comparison, one line per option: what it is, estimated amount, estimated tax effect this year, what it costs or brings back later, effect on cash. Label every number "uppskattning" / "estimate", and say which months the estimate rests on. Then ask the owner which options they want. Do not recommend one as "the right answer" when it depends on facts you do not have (other income, personal tax, plans); say what it depends on.

When the owner has decided:

- Record the decision if they agree: \`gnubok_remember_fact({ content: "...", kind: "preference" })\`, e.g. "Ägaren vill sätta av 25 % till periodiseringsfond för 2026."
- Tell them the booking happens at bokslut through the \`year-end-close\` skill, after all transactions for the year are booked. Salary changes go through \`payroll-monthly\`. Nothing is booked now.

## When a tool call fails

- **Validation error / unknown argument:** fix the arguments from the tool description and try once more. \`gnubok_get_kpi_report\` takes \`period_id\`, optional \`from_date\`/\`to_date\` and \`metrics\` (its output keys).
- **"Fiscal period not found" / "No fiscal periods found":** re-read \`gnubok_list_fiscal_periods\` and use a real \`id\`; if none exists, stop (Step 0.2).
- **\`EF_DECLARATION_WRONG_LEGAL_FORM\`:** the company is not an enskild firma. Go back to Step 0.1; do not force the EF track.
- **\`gnubok_propose_dispositioner\` returns empty \`proposals\`:** for an EF this is expected (no corporate dispositions). For an AB, check that the result is positive and the books are up to date before concluding there is nothing to do.
- **Permission or scope error:** tell the user which tool was refused; do not look for a way around it.

## Stop conditions: hand over to an accountant

Say "this needs a human: here is what I found", list the figures you gathered, and stop, when:

- A rate, threshold or rule you need is not in the table above or a tool result.
- The owner asks for their final personal tax, K10, whether shares are kvalificerade, or anything about närstående, holding structures, koncernbidrag, kapitalförsäkring, ränteavdragsbegränsningar or company sale.
- A periodiseringsfond from before 2019 is being reversed (it needs an uppräkning the tool does not show).
- The fiscal year is already closed, or the legal form is not AB or EF.
- The owner describes a plan whose main purpose is avoiding tax (e.g. a large December bonus only to hit a threshold): the rule pack flags these as audit triggers and skatteflyktslagen risk.

## Rules

- Read-only. No vouchers, no dispositions, no salary changes in this skill. Never book, never stage a disposition, never edit or reverse posted entries.
- Every figure is an estimate and says so, with the months it is based on and the rate year.
- Never invent a rate. Never mix periodiseringsfond (2110-2139) with överavskrivningar (2150).
- The owner decides; you explain what each choice depends on.

## Report format

- **Underlag:** company, legal form, fiscal year, booked through [month], what is missing
- **Estimates:** the comparison table, each line marked as an estimate with rate year
- **Needs your answer:** the open questions from Step 1
- **Could not compute (and why):** items outside the rule pack, handed to an accountant
- **Next step:** book the rest of the year, then \`year-end-close\` for the dispositions the owner chose

## Tools

- \`gnubok_list_companies\`, \`gnubok_get_agent_briefing\`: company and legal form
- \`gnubok_list_fiscal_periods\`: fiscal year and status
- \`gnubok_list_uncategorized_transactions\`, \`gnubok_year_end_readiness\`: how complete the books are (read-only here)
- \`gnubok_get_income_statement\`, \`gnubok_get_balance_sheet\`, \`gnubok_get_kpi_report\`, \`gnubok_get_general_ledger\`: result, equity, cash, monthly trend, existing fonder
- \`gnubok_propose_dispositioner\`: AB dispositions and bolagsskatt on booked figures (read-only)
- \`gnubok_preview_ef_declaration\`: EF egenavgifter, räntefördelning, periodiseringsfond, expansionsfond (read-only)
- \`gnubok_list_employees\`, \`gnubok_list_assets\`: owner salary and asset base
- \`gnubok_remember_fact\`: record the owner's decision, with their consent
- \`gnubok_load_skill\`: \`year-end-close\` for booking, \`payroll-monthly\` for salary

An unlisted read in your client (gnubok_search_tools shows callable_via "call_tool") goes through \`gnubok_call_tool({ tool, arguments })\`. No widget is needed for this skill; present the comparison as a plain table in chat.
`

export const taxPlanningSkill: Skill = {
  slug: 'tax-planning',
  name: 'Skatteplanering',
  summary: 'Before year-end: estimate the owner\'s tax options (periodiseringsfond, överavskrivningar, lön vs utdelning, EF egenavgifter and räntefördelning). Read-only; the owner decides.',
  tags: ['yearly', 'tax', 'skatteplanering', 'periodiseringsfond', '3:12', 'planning'],
  body,
  tier: 'workflow',
  applicability: { entity_type: 'both' },
}
