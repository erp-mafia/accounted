import type { Skill } from './types'

const body = `# Onboarding: set up a company in Accounted from the conversation

From "my company is not in Accounted yet" to a working ledger without the
user opening the web app first. The only browser steps are the ones that
legally need a human with BankID: connecting (creating the account),
approving the bank consent, and authorising Skatteverket. Everything else
happens here.

## When to use

- "Sätt upp bokföring för mitt AB / min enskilda firma"
- "Jag har precis startat bolag, hur kommer jag igång?"
- "Lägg till ett nytt bolag" (an existing user adding a second company)
- A byrå/consultant onboarding a new client company (pass \`team_id\`)

## Step 0: connect

If this session is not connected yet, the first company-scoped call (for
example \`gnubok_create_company\`) returns an authentication challenge that the
client shows as a Connect prompt. Tell the user: "Klicka på Connect; har du
inget konto skapar du det där (BankID eller e-post), det tar en minut." The
call is retried automatically once connected. Do not send the user to the web
app to sign up first.

## Step 1: ask for the organisationsnummer, then look it up

Ask for ONE thing first: the **organisationsnummer** (10 digits; an enskild
firma's org number is the owner's personnummer, fine to use here). Then call
\`gnubok_lookup_company\` with it. This mirrors the in-app wizard: the public
registry answers most of the questions, so the user confirms facts instead of
filling in a form.

The result carries three parts; use them exactly as intended:

- \`company\`: the registry facts. Present them as a SHORT summary for the
  user to confirm: "Jag hittade Example AB, Storgatan 1 i Stockholm,
  godkänd för F-skatt och momsregistrerad. Stämmer det?" Do NOT re-ask
  what the registry already answered.
- \`suggested_create_company_input\`: prefilled arguments for
  \`gnubok_create_company\`. Merge the user's remaining answers into it.
- \`still_to_ask\`: the questions the registry could not answer. Ask exactly
  these and nothing more.

Rules baked into that split (same as the web onboarding):

- **F-skatt** from the registry is a fact, both true and false.
- **VAT** is a fact ONLY when positively registered. "No VAT registration
  found" is a question, never an assumption (ML 17 kap 24 §).
- **Moms period** (\`monthly\`/\`quarterly\`/\`yearly\`) and **accounting
  method** (\`accrual\`/\`cash\`) are ALWAYS the user's answer. Rules of
  thumb if they are unsure: turnover under 1 MSEK may report VAT yearly,
  under 40 MSEK quarterly, above that monthly (Skatteverket's registration
  decision states the actual period); cash method is only allowed under
  3 MSEK turnover and is common for small enskild firma, AB with invoices
  usually run accrual.
- **Enskild firma name**: the verksamhetsnamn is freely choosable; suggest
  the registered name but let the user pick. An AB's registered name is a
  fact.
- **Fiscal year**: when the registry shows one, confirm it ("Ert
  räkenskapsår är 1 januari till 31 december, stämmer det?") instead of
  asking openly. For a company registered within the last 12 months,
  suggest a first fiscal year from the registration date and pass
  \`first_fiscal_year\` (BFL 3 kap.: it may be shorter than 12 months or up
  to 18 months). Enskild firma is always calendar-year and its first year
  always ends 31 December.

If the lookup returns \`not_found\` or \`unavailable\`, fall back to asking
each question in \`still_to_ask\` (the full list) and continue; the flow is
the same, just without prefill. A brand-new registration can take days to
appear in the registry.

Only \`aktiebolag\` and \`enskild_firma\` are supported today; HB/KB/förening
are not. A company marked CEASED in the registry: surface the warning, but
the user may continue (they know their company best).

## Step 2: preview, confirm, create

Call \`gnubok_create_company\` WITHOUT \`confirm\` first. Read the preview back
to the user in plain Swedish: company form, org number, the fiscal period
dates, VAT setup (registered + period), method. Only after an explicit "ja"
call it again with the same arguments and \`confirm: true\`.

What creation does in one step: company + owner membership, BAS chart of
accounts for the company form, settings, the first fiscal period, and the
automatic tax deadlines (moms, F-skatt, AGI, inkomstdeklaration). The 30-day
trial with bank sync, Skatteverket, AI and e-mail starts immediately. This
connection uses the new company automatically from the next call; no
re-authentication.

## Step 3: connect the bank

Call \`gnubok_connect_bank\`. It reports existing connections and returns a
\`connect_url\`; on claude.ai/Claude Desktop a connect card with an
open-in-browser button renders automatically. The user opens the link in a
browser where they are logged in to Accounted, picks the bank and approves
with BankID (PSD2 consent, up to 180 days). Transactions start syncing
within a minute. If they prefer not to connect a bank, they can import bank
statements as files in the web app instead; do not block on this step.

## Step 4: connect Skatteverket (optional but recommended)

Call \`gnubok_connect_skatteverket\`. Same pattern: the user opens the
connect link (card button on claude.ai/Desktop), identifies with BankID as
firmatecknare at Skatteverket, and lands back in Accounted. This enables
skattekonto sync and filing of momsdeklaration and arbetsgivardeklaration
from here. Filing is never mandatory through Accounted: every declaration
can be downloaded and filed manually.

## Step 5: first bookkeeping

Once transactions arrive: \`gnubok_list_uncategorized_transactions\` and the
categorize flow (\`gnubok_suggest_categories\`, \`gnubok_categorize_transaction\`,
approval). For a company with history in another system, offer the SIE
import (\`gnubok_import_sie\` in the search catalog) before categorizing.

## Tools

- \`gnubok_lookup_company\`: registry facts + prefill from the orgnr; call first
- \`gnubok_create_company\`: preview (no confirm) then create (confirm=true)
- \`gnubok_list_companies\`: see which companies this connection can reach
- \`gnubok_connect_bank\`: status + connect link for PSD2 bank consent
- \`gnubok_connect_skatteverket\`: status + connect link for Skatteverket
- \`gnubok_get_agent_briefing\`: the company's settings and state once created
- \`gnubok_list_uncategorized_transactions\`: the first real bookkeeping step

## Pitfalls

- A VAT-registered company without a moms period is refused on purpose; do
  not work around it by claiming the company is not VAT-registered.
- Do not create a company twice on a retry: check \`gnubok_list_companies\`
  if a create call was interrupted.
- Bookkeeping duty starts when the company exists in Accounted with a fiscal
  period. Never create a company "to try things out" for a real
  organisation; use the sandbox in the web app for demos.
`

export const onboardingSkill: Skill = {
  slug: 'onboarding',
  name: 'Onboarding: New Company Setup',
  summary:
    'Set up a company from the conversation: ask for the orgnr, prefill facts with gnubok_lookup_company, preview and create with gnubok_create_company, then the bank and Skatteverket connect links.',
  tags: ['onboarding', 'setup', 'company', 'bank', 'skatteverket', 'agent-first'],
  body,
  tier: 'workflow',
}
