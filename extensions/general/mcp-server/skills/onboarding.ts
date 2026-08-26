import type { Skill } from './types'

const body = `# Onboarding: set up a company in Accounted from the conversation

From "my company is not in Accounted yet" to a working ledger without the
user opening the web app first. The only browser steps are the ones that
legally need a human with BankID: connecting (creating the account),
approving the bank consent, and authorising Skatteverket. Everything else
happens here.

**Momentum rule: one confirmation, then keep going.** The only stop in this
flow is the create-company preview ("stämmer detta? ja"). Never end a turn
with "säg till när du vill fortsätta": after the confirm, call the connect
tools immediately; when the user reports a connection done, verify it and
continue straight into import or categorization. Staged writes still go
through their normal approval, but that approval IS the conversation, not an
extra pause around it.

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

## Step 1: THREE opening questions, then look up

Open with exactly three questions, together:

1. **Organisationsnummer?** (10 digits; an enskild firma's org number is the
   owner's personnummer, fine to use here)
2. **Har du bokfört i ett annat system tidigare?** (Fortnox, Visma, Bokio,
   Björn Lundén, Briox, Wint, annat system, eller helt nytt bolag)
3. **Vilken bank har företaget?** (so the bank connect link later opens that
   bank's consent directly instead of a picker)

Then call \`gnubok_lookup_company\` with the org number. The registry answers
most of the form; present the facts as a SHORT summary to confirm ("Jag
hittade Example AB, Storgatan 1 i Stockholm, godkänd för F-skatt och
momsregistrerad. Stämmer det?") and ask ONLY what \`still_to_ask\` lists.
Never re-ask what the registry answered.

Rules baked into that split (same as the web onboarding):

- **F-skatt** from the registry is a fact, both true and false.
- **VAT** is a fact ONLY when positively registered. "No VAT registration
  found" is a question, never an assumption (ML 17 kap 24 §).
- **Moms period** and **accounting method** are ALWAYS the user's answer.
  Rules of thumb if unsure: under 1 MSEK turnover may report VAT yearly,
  under 40 MSEK quarterly, above monthly; cash method only under 3 MSEK.
- **Enskild firma name**: verksamhetsnamnet is freely choosable; suggest the
  registered name but let the user pick. An AB's registered name is a fact.
- **Fiscal year**: registry data becomes a confirm question, never an open
  one. No closed period in the registry = FIRST räkenskapsår: suggest a
  start at the registration date. The end differs by form: an enskild
  firma MUST end 31 December; an AB may pick any end within 18 months of
  the start (BFL 3 kap 3 §), with 31 December as the common default, so
  present the AB's choice rather than assuming it.

\`not_found\`/\`unavailable\`: fall back to asking the \`still_to_ask\` list and
continue. Only \`aktiebolag\` and \`enskild_firma\` are supported today.

## Step 2: preview, ONE confirm, create, keep moving

Call \`gnubok_create_company\` WITHOUT \`confirm\`. Read the preview back in
plain Swedish (form, orgnr, fiscal period dates, VAT + period, method).
After the user's "ja": call it again with \`confirm: true\`, and in the SAME
turn continue with step 3 or 4. Creation sets up chart, settings, first
fiscal period, tax deadlines, and starts the 30-day trial; the connection
uses the new company automatically.

## Step 3 (existing bookkeeping): import it FIRST

When the user had a previous system, history comes before the bank: it is
the fastest path to a ledger that shows real value, and bank history rarely
reaches far enough back anyway.

1. Tell them where to export: **Fortnox** Register → Exportera → SIE 4,
   **Visma eEkonomi** Bokföring → Export SIE, **Bokio** Inställningar →
   Exportera data → SIE, **Björn Lundén / Briox / Wint** under Export.
   Every Swedish system exports SIE4 (.se/.sie); ask them to attach the
   file here in the chat.
2. When the file arrives, call \`gnubok_sie_preflight\` with its content
   (\`file_content\` as read, or \`file_content_base64\` when exact bytes are
   available: that preserves åäö in CP437 exports). Summarize the scan:
   source system, fiscal years, verifikat count, balance status, org-number
   match, warnings. This is the "does it look correct" moment: surface
   problems BEFORE anything is written.
3. On their go-ahead: \`gnubok_import_sie\` with the same file and the
   preflight's \`mappings\`. It stages for approval; after commit verify with
   \`gnubok_get_trial_balance\`.
4. Multiple fiscal years = multiple files: import oldest first so IB/UB
   chains. If the file is very large for chat, the web wizard at
   \`/import?mode=sie\` is the fallback; Fortnox users can also run the full
   API migration (invoices, customers, documents) at
   \`/import?mode=migration&provider=fortnox\`.

## Step 4: connect bank and Skatteverket (together, no pause)

Call \`gnubok_connect_bank\` (pass \`bank\` from step 1 so the link opens that
bank's consent directly) AND \`gnubok_connect_skatteverket\` in the same
turn; on claude.ai/Desktop both render connect cards with buttons.

- Bank: BankID + PSD2 consent, then an **account selection dialog** in the
  browser: transactions start syncing when the user saves it. Banks cap
  PSD2 history (often ~90 days); older history is the SIE import's job.
- Skatteverket: BankID as firmatecknare; enables skattekonto sync and
  moms/AGI filing. Optional, never block on it.

When the user says they are done (or comes back), re-call
\`gnubok_connect_bank\` to verify \`connected\`, then go DIRECTLY to step 5.

## Step 5: first bookkeeping, immediately

Call \`gnubok_list_uncategorized_transactions\` as soon as the bank is
connected: do not ask whether to proceed. Walk the categorize flow
(\`gnubok_suggest_categories\`, \`gnubok_categorize_transaction\`, approval).
If nothing has synced yet, say so and check again on the user's next
message instead of making them ask.

## Tools

- \`gnubok_lookup_company\`: registry facts + prefill from the orgnr; call first
- \`gnubok_create_company\`: preview (no confirm) then create (confirm=true)
- \`gnubok_sie_preflight\`: scan a shared SIE file, nothing written
- \`gnubok_import_sie\`: staged import; use the preflight's mappings
- \`gnubok_connect_bank\` / \`gnubok_connect_skatteverket\`: status + connect links
- \`gnubok_list_companies\`, \`gnubok_get_agent_briefing\`: state checks
- \`gnubok_list_uncategorized_transactions\`: the first real bookkeeping step

## Pitfalls

- A VAT-registered company without a moms period is refused on purpose; do
  not work around it by claiming the company is not VAT-registered.
- Do not create a company twice on a retry: check \`gnubok_list_companies\`
  if a create call was interrupted.
- A preflight org-number mismatch means the file is another company's
  bookkeeping: stop and confirm, never import across companies.
- Bookkeeping duty starts when the company exists in Accounted with a fiscal
  period. Never create a company "to try things out" for a real
  organisation; use the sandbox in the web app for demos.
`

export const onboardingSkill: Skill = {
  slug: 'onboarding',
  name: 'Onboarding: New Company Setup',
  summary:
    'Set up a company in chat: orgnr + previous system first, prefill via gnubok_lookup_company, one confirm to create, SIE history via preflight + staged import, then bank/Skatteverket cards.',
  tags: ['onboarding', 'setup', 'company', 'bank', 'skatteverket', 'sie', 'migration', 'agent-first'],
  body,
  tier: 'workflow',
}
