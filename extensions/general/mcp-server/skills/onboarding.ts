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

## Step 1: gather the facts (ask, never assume)

Collect these before creating anything. The order mirrors the in-app wizard.

1. **Organisationsnummer** (10 digits). Optional but strongly recommended: it
   drives the VAT number and later Skatteverket/SIE exports. An enskild firma's
   org number is the owner's personnummer; that is fine to store here.
2. **Company form**: \`aktiebolag\` or \`enskild_firma\`. Only these two are
   supported today; HB/KB/förening are not.
3. **Company name** as registered.
4. **F-skatt**: godkänd för F-skatt? Default true; a brand-new company may be
   waiting for approval (then false).
5. **Fiscal year**: for enskild firma always the calendar year (do not ask).
   For an AB ask whether it is the calendar year or another 12-month period
   (\`fiscal_year_start_month\`). For a company in its FIRST year ask for the
   exact first fiscal year start and end (BFL 3 kap.: it may be shorter than
   12 months or up to 18 months) and pass \`first_fiscal_year\`.
6. **VAT**: momsregistrerad? If yes, which period: \`monthly\`, \`quarterly\` or
   \`yearly\`. This is required when VAT-registered: without it Accounted
   generates no VAT deadlines at all, silently. If the user does not know,
   the rule of thumb: turnover under 1 MSEK may report yearly, under 40 MSEK
   quarterly, above that monthly; Skatteverket's registration decision states
   the actual period. Never guess it into the tool; ask.
7. **Accounting method**: \`accrual\` (faktureringsmetoden) or \`cash\`
   (kontantmetoden / bokslutsmetoden). Cash is only allowed under 3 MSEK
   turnover and is common for small enskild firma; AB with invoices usually
   run accrual.

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
\`connect_url\`. The user opens it in a browser where they are logged in to
Accounted, picks the bank and approves with BankID (PSD2 consent, up to 180
days). Transactions start syncing within a minute. If they prefer not to
connect a bank, they can import bank statements as files in the web app
instead; do not block on this step.

## Step 4: connect Skatteverket (optional but recommended)

Call \`gnubok_connect_skatteverket\`. Same pattern: the user opens the
\`connect_url\`, identifies with BankID as firmatecknare at Skatteverket, and
lands back in Accounted. This enables skattekonto sync and filing of
momsdeklaration and arbetsgivardeklaration from here. Filing is never
mandatory through Accounted: every declaration can be downloaded and filed
manually.

## Step 5: first bookkeeping

Once transactions arrive: \`gnubok_list_uncategorized_transactions\` and the
categorize flow (\`gnubok_suggest_categories\`, \`gnubok_categorize_transaction\`,
approval). For a company with history in another system, offer the SIE
import (\`gnubok_import_sie\` in the search catalog) before categorizing.

## Tools

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
    'Set up a company from the conversation: gather facts, preview and create with gnubok_create_company, then hand out the bank and Skatteverket connect links.',
  tags: ['onboarding', 'setup', 'company', 'bank', 'skatteverket', 'agent-first'],
  body,
  tier: 'workflow',
}
