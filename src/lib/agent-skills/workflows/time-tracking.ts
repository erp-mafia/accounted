import type { Skill } from '../types'

const body = `# Time Tracking: Accounted

Registering billable hours (tidrapportering) per customer, project and
consultant, and following up what is not invoiced yet. Typical in byråer and
konsultbolag, often said out loud from a phone: "logga tre timmar på
Galärbryggan igår, bokslut".

## When to use

- "Logga / registrera / tidrapportera X timmar på ..."
- "Vad har jag rapporterat den här veckan?"
- "Hur mycket ofakturerad tid har vi på Galärbryggan?"
- "Ta bort / ändra tidraden från i tisdags"
- Before invoicing time-billed work: the uninvoiced totals are the fakturaunderlag

## Ground rules

1. **Never guess a customer, project, activity or consultant.** Pass what the
   user said. The tools resolve exact code, then exact name, then one
   confident fuzzy match. When they answer TIME_ENTRY_REFERENCE_UNRESOLVED,
   read \`details.candidates\` back to the user and ask which one; retry with
   the code. Never pick the top candidate yourself.
2. **Resolve relative dates before calling.** "igår", "i måndags", "förra
   fredagen" become YYYY-MM-DD from today's date. Say the date and weekday back
   in your confirmation; the preview shows the weekday too.
3. **Hours are decimal.** "en och en halv timme" is 1.5, "45 minuter" is
   0.75. At most two decimals and 24 hours per entry.
4. **Sanity-check the amount.** If one entry is more than 12 hours, or a day
   adds up past 12, ask before staging: it is usually a typo or two days.
5. **One approval per batch.** Several entries from one message ("2 h på A
   och 3 h på B") go in one \`gnubok_log_time\` call (up to 20 entries), so
   the user approves once.
6. **Nothing is created.** A customer or project that does not exist is a
   question for the user, not something to create from here. New customers:
   see \`customer-onboarding\`; new projects: \`gnubok_create_dimension_value\`
   (dimension 6), each its own approval.

## Workflow: log time

### Step 1: Know the codes (once per conversation)

\`gnubok_list_time_codes\` returns the consultants, activity codes with
hourly rates, imported customer codes and active projects. Use it to map
what the user says, and to ask good questions ("Menar du aktivitet 2,
Bokslut?").

### Step 2: Stage the entries

\`gnubok_log_time({
  entries: [
    { entry_date: '2026-11-02', hours: 3, customer: 'Galärbryggan', activity: 'bokslut' },
  ],
})\`

- Omit \`consultant\` to use the consultant linked to the user ("Din
  medarbetarkod" in the time-tracking settings). If the answer is
  TIME_ENTRY_CONSULTANT_REQUIRED, ask who did the work, or suggest linking
  the code once under Tidrapportering, Sammanställning.
- \`gnubok_log_time\` is not in the default tool list: find it with
  \`gnubok_search_tools\`, or reach it through \`gnubok_stage_tool\`.

### Step 3: Confirm and approve

Read the preview back in one line per entry: weekday and date, hours,
customer, project, activity, amount. Mention every entry in \`matched\`
(resolved by name or fuzzily, not by code). Approve with
\`gnubok_approve_pending_operation\` only after the user says yes.

## Workflow: correct or remove

1. \`gnubok_list_time_entries\` with \`from\`/\`to\` (and \`consultant\`) to find
   the row; use its \`time_entry_id\`.
2. \`gnubok_update_time_entry\` with only the fields that change
   (\`project\`, \`activity\`, \`comment\` take null to clear), or
   \`gnubok_delete_time_entry\` for a duplicate.
3. An entry that is on an invoice is frozen (TIME_ENTRY_INVOICED): the fix is
   a credit note and a new invoice, see \`kreditfaktura-process\`.

## Workflow: follow up and invoice basis

- \`gnubok_get_time_summary({ group_by: 'customer', uninvoiced: 'true' })\`
  totals uninvoiced billable hours per customer and month with their amount
  (activity code rate, else the default rate; SEK ex moms).
- \`uninvoiced_amount: null\` means some hours have no rate: ask the user for
  the rate before quoting a sum.
- \`group_by: 'project'\` or \`'consultant'\` for project follow-up and
  per-person totals.
- Invoicing itself goes through \`gnubok_create_invoice\` (see
  \`invoicing-rules\`); the dashboard's export gives the line-by-line
  fakturaunderlag.

## Tools

- \`gnubok_list_time_codes\`: consultants, activity codes and rates, customer codes, projects
- \`gnubok_log_time\`: stage 1-20 entries, references by code or name
- \`gnubok_list_time_entries\`: find entries by date, customer, consultant, project, uninvoiced
- \`gnubok_get_time_summary\`: totals and uninvoiced amounts per customer, project or consultant and month
- \`gnubok_update_time_entry\`: stage a change to an uninvoiced entry
- \`gnubok_delete_time_entry\`: stage deleting an uninvoiced entry
- \`gnubok_approve_pending_operation\`: commit after the user confirms
`

export const timeTrackingSkill: Skill = {
  slug: 'time-tracking',
  name: 'Time Tracking',
  summary: 'Log billable hours by voice or chat (resolve names, never guess), correct or remove entries, and total uninvoiced time per customer, project or consultant.',
  tags: ['time-tracking', 'tidrapportering', 'consulting', 'invoicing'],
  body,
  tier: 'workflow',
  applicability: { entity_type: 'both' },
}
