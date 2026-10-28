import type { Skill } from '../types'

/**
 * The onboarding import: the user's own AI (Claude, ChatGPT, Grok, a local
 * agent) tells Accounted what it already remembers about the business, so
 * every agent that opens the company starts from it instead of asking again.
 *
 * One body for every client: what differs between them is their own memory,
 * which the skill only asks them to read. The list is shown before anything
 * is saved (the user confirms), and each confirmed fact is saved as plain
 * text with origin onboarding_import, so the import can be told apart and
 * undone fact by fact (gnubok_forget_fact).
 */
const body = `# Tell Accounted what you already know about this company

The user asked you to share what you remember about their business, so that
every AI working in Accounted starts from it. You write it down, the user
confirms, Accounted keeps it. Nothing is saved before the user says yes.

## Step 1: see what Accounted already knows

Call \`gnubok_get_agent_briefing\`. Confirm \`company\` is the business the user
means (with several companies, ask which one). Read \`memory\`: those facts are
already saved, each with its \`fact_id\`.

## Step 2: write down what you remember

From your own memory and earlier conversations with this user, list what
affects money, bookings or tax. Go through:

- what the company sells, to whom, and how it gets paid
- customers or suppliers abroad (inside or outside the EU)
- employees: how many and since when; how the owner or owners are paid
  (lön, utdelning, uttag)
- rent, loans, leasing, cars, insurance and other recurring agreements
- moms: registered or not, the reporting period, special cases
- fiscal year, accounting method, F-skatt
- the previous accounting system, the accountant or byrå, and their
  instructions or preferences
- the bank or banks
- what is planned: hiring, an investment, a new market

Rules:

- Only what you actually remember or were told. Never guess and never fill a
  gap with what is typical for the industry.
- Leave out what \`memory\` already says. When yours is newer or different,
  it is an update: note the \`fact_id\` it replaces.
- No personnummer, bank account or card numbers, passwords or health details.
- If you remember nothing about this business, say so in one line and offer
  to ask the three or four questions that matter most instead.

## Step 3: show the list and ask

In the user's language, one short numbered line per fact, updates marked
("uppdaterar: ..."). Then ask once, for example: "Ska jag spara de här i
Accounted? Svara ja, eller ange numren som inte stämmer." Correct what the
user corrects.

## Step 4: save what the user confirmed

One \`gnubok_remember_fact\` per confirmed fact:

- \`content\`: one self-contained sentence in the user's language, readable
  without this conversation ("Bolaget har två anställda sedan september 2026.")
- \`kind\`: \`fact\`, or \`preference\` for how the user wants things done
- \`origin\`: \`"onboarding_import"\`
- \`replaces\`: the \`fact_id\` when the fact updates one already in \`memory\`

Then reply in two lines: how many facts were saved, and that every AI the user
connects to Accounted now starts from them. Say they can ask any of them to
forget a fact.

## Tools

- \`gnubok_get_agent_briefing\` (read: the company and what \`memory\` already holds)
- \`gnubok_remember_fact\` (saves one confirmed fact at once, no approval step; \`origin: "onboarding_import"\`)
- \`gnubok_forget_fact\` (only when the user asks to take a saved fact back)
`

export const companyFactsImportSkill: Skill = {
  slug: 'company-facts-import',
  name: 'Company Facts Import',
  summary:
    'Tell Accounted what you already remember about the business: list it, show the user, save what they confirm with gnubok_remember_fact (origin onboarding_import).',
  tags: ['onboarding', 'memory', 'facts', 'company', 'agent-first'],
  body,
  tier: 'workflow',
}
