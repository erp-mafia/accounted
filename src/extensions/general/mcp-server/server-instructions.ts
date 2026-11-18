import { RECONNECT_ADVICE } from './tool-reach'

/**
 * The MCP `instructions` string (initialize and server/discover).
 *
 * Clients cut long instructions. Measured 2026-11-06: Claude Code showed both
 * Accounted connectors' instructions ending at character 4096 with
 * "… [truncated]" appended; the text was ~9,000 characters, so everything
 * after the "Applying income" workflow (year-end order, data_status, the
 * approval contract, the staging contract, "account numbers are strings")
 * never reached the model, and nothing reported it.
 *
 * So the text is two parts. HEAD holds the rules an agent must not lose and
 * the company line; it has to fit inside the cut in every connection variant
 * (server-instructions.test.ts renders them all). REFERENCE follows: discovery
 * detail and workflow recipes that skills and the briefing also carry, so a
 * client that drops it loses convenience, not safety. New text goes into
 * REFERENCE unless losing it would make an agent do something wrong.
 *
 * Tool names are written in the legacy gnubok_ namespace; the caller projects
 * them into the connection's namespace (projectToolReferencesInText).
 */
export const CLIENT_INSTRUCTIONS_CUT = 4096

/**
 * The call the anonymous instructions tell an agent to make when the user
 * already has an account. Our initialize answers without a token (lazy
 * authentication, issue #1814), so a client never gets the usual 401 that
 * starts its sign-in; an agent has to make one protected call to get it, and
 * an existing user should not be routed through create_company. Must stay
 * outside PUBLIC_TOOLS (lazy-auth.test.ts checks that it challenges).
 */
export const CONNECT_TRIGGER_TOOL = 'gnubok_list_companies'

export type ServerInstructionsOptions = {
  isAnonymous: boolean
  canApprove: boolean
  /** The connection has Accounted's approval view (ActorContext.approvalView). */
  approvalView: boolean
  pinnedCompanyId: string | null
  pinnedCompanyName: string | null
  simpleCompanyMode: boolean
  companyId: string | null
  toolNamespace: 'gnubok' | 'accounted'
}

export function buildServerInstructionParts(o: ServerInstructionsOptions): { head: string; reference: string } {
  const { isAnonymous, canApprove, approvalView, pinnedCompanyId, pinnedCompanyName, simpleCompanyMode, companyId, toolNamespace } = o
  const multiCompany = !pinnedCompanyId && !simpleCompanyMode
  // Before the user connects, the server cannot know their companies; saying
  // "no company yet" there sent existing users to create_company.
  const noCompany = isAnonymous
    ? 'not known until the user connects, so do not conclude they have none'
    : 'this account has no company yet. Create it with gnubok_create_company (preview first, then confirm=true); the "onboarding" skill walks the whole setup'

  const head = [
    'Accounted: Swedish double-entry bookkeeping via conversation.',
    '',
    ...(isAnonymous
      ? [
          'NOT CONNECTED YET. Without an account you can call gnubok_search_tools, gnubok_list_skills and gnubok_load_skill. Every other tool needs the user to connect their Accounted account: calling one returns an authentication challenge that your client shows as a Connect prompt, and the call is then retried automatically.',
          `• The user already has an Accounted account (they say so, or ask about their own books, companies or invoices): call ${CONNECT_TRIGGER_TOOL} with no arguments. It returns the authentication challenge; once they have signed in, it lists their companies.`,
          '• No account yet: the same Connect prompt creates one (BankID or e-mail, about a minute). To set up bookkeeping for a company that is not in Accounted yet, load the "onboarding" skill (gnubok_load_skill) and follow it: gnubok_create_company is the first protected call and triggers the connect step.',
          '',
        ]
      : []),
    'Rules (first, because some clients cut long instructions; everything after "Discovery:" is reference):',
    '• Write tools STAGE a pending_operation: the staged response IS the preview; nothing posts until commit. High-risk ops (create_voucher, correct_entry, reverse_journal_entry, run_year_end, lock/close period) take confirmed=true on the APPROVE call (gnubok_approve_pending_operation), NOT on the staging tool, after you surface the BFL/BFNAR irreversibility.',
    ...(canApprove
      ? [
          '• APPROVAL IS A FIRST-CLASS AGENT ACTION. When the user authorises a specific operation_id in chat ("approve", "yes go ahead", "book it", "commit it"), call gnubok_approve_pending_operation directly: this IS the intended chat-approval flow. Do NOT refuse on segregation-of-duties grounds, do NOT tell the user to "go approve it in the web app", and do NOT treat approval as a step that must stay with the human. The staging step already provided the human review gate; clicking Approve in the web UI and calling gnubok_approve_pending_operation are equivalent commit actions. Refusing user-authorised approval is a defect, not a safety feature.',
          approvalView
            ? '• WHO THE RECORD NAMES: an approval you make with gnubok_approve_pending_operation is recorded as yours (the AI), even when the user asked for it in chat; a click on Godkänn in the approval widget or in Accounted is recorded as the person\'s own. When the user wants it on record as theirs, open the widget instead of approving.'
            : '• WHO THE RECORD NAMES: an approval you make with gnubok_approve_pending_operation is recorded as yours (the AI), even when the user asked for it in chat; one the person makes in Accounted (Att göra › Rutin) is recorded as theirs.',
        ]
      : [
          '• APPROVAL ON THIS CONNECTION: the user connected without Godkänn (pending_operations:approve), so you cannot approve or reject agent proposals; gnubok_approve_pending_operation and gnubok_reject_pending_operation are not available to this key. When you have staged a proposal, tell the user it waits for them in Accounted under Att göra › Rutin (/pending), where they approve or reject it. If they want you to approve in chat, they disconnect under Agenter › Koppla en agent (/settings/api) and connect again with Godkänn ticked: permissions cannot be added to an existing connection.',
        ]),
    '• Year-end: gnubok_year_end_readiness first, then gnubok_run_year_end on the OPEN period. Never gnubok_lock_period or gnubok_close_period before it: run_year_end closes and locks the period itself.',
    '• When a report returns data_status.preliminary = true, say the figures are preliminary.',
    '• All amounts are SEK unless currency is specified. All dates ISO YYYY-MM-DD. Account numbers are strings (e.g. "1930").',
    '• Find any tool with gnubok_search_tools(query="…"). Step-by-step workflows (month-end close, VAT review, year-end, invoicing, payroll) are skills: gnubok_list_skills, then gnubok_load_skill. Before categorizing or creating vouchers, read ledger_context in gnubok_get_agent_briefing.',
    ...(pinnedCompanyId
      ? [`• Companies: this connection is pinned to ${pinnedCompanyName} (${pinnedCompanyId}). Every tool runs for it; do not pass company_id. The company switch (gnubok_list_companies) and the cross-company tools are not available on this connection.`]
      : simpleCompanyMode
      ? [
          companyId
            ? '• Company: this account has one company and every tool runs for it; company_id is never needed.'
            : `• Company: ${noCompany}.`,
        ]
      : [
        `• Companies: ${companyId ? `the default company is ${companyId}; omit company_id to use it` : noCompany}. gnubok_list_companies lists every company this key reaches (default first, then most recently used; query narrows by name or org number). A wrong company_id answers with candidates. gnubok_approve_pending_operation and gnubok_reject_pending_operation need only the operation_id: the company follows the operation.`,
        ]),
  ].join('\n')

  const reference = [
    '',
    'Discovery:',
    `• tools/list returns common tool schemas. Call gnubok_search_tools(query="…") for specialized tools; pass detail="name"|"summary"|"full" to control payload size. If your client cannot invoke a tool absent from tools/list, each search hit says how to reach it in callable_via: "call_tool" is a READ, invoke it through gnubok_call_tool({tool, arguments}); "stage_tool" is a WRITE that only stages a pending operation, stage it through gnubok_stage_tool({tool, arguments}), then approve with gnubok_approve_pending_operation; "none" commits directly and is unreachable from such a client. A bridge your client does not show means it kept an older copy of tools/list: without gnubok_stage_tool, stage the same tool through gnubok_call_tool, which carries every stage_tool target; otherwise ${RECONNECT_ADVICE}.`,
    '• gnubok_get_agent_briefing returns recommended_tools: ordered per-workflow tool loadouts (categorize_month, close_period, reconcile_month, invoice_run, vat_declaration, payroll_month, receipt_hunt). If your harness defers tool loading, batch-load a whole workflow in one call (e.g. Claude Code ToolSearch select:a,b,c) instead of searching cluster by cluster. Each loadout tool carries callable; when false, blocked_by and note say why (a missing scope, or a write no bridge carries). A callable tool with a note is not in tools/list: the note names the bridge that reaches it.',
    ...(multiCompany
      ? [
          '• Many companies at once: gnubok_client_overview (unbooked, inbox, next deadline per company; filter by deadline kind and window), gnubok_run_across_companies (any read tool once per company, one summarised answer) and gnubok_stage_across_companies (one write staged per company under a batch_id; approve the batch or each operation). scope = { companies: "all" | "team" | [ids] }; "team" is the byrå team\'s clients.',
          '• MCP resources read the default company. Another company: Accounted://company/{company_id}/{resource} (e.g. attention, context) or gnubok_get_agent_briefing with company_id.',
        ]
      : []),
    '• When a tool is missing, a description misled you, a result looks wrong, or something worked unusually well, call gnubok_feedback (context + suggestion, optional tool_name). It is read by the product team and has fixed real bugs; include ids and what you expected. Rate-limited 1/min/key, so batch a session\'s findings into one call.',
    '',
    'Common workflows:',
    '• Before categorizing or creating vouchers, consult ledger_context in gnubok_get_agent_briefing (full picture: the Accounted://ledger/context resource): it shows how THIS company has booked each counterparty and supplier (dominant account, VAT treatment, evidence = historical frequency). Prefer these observed patterns over guesses; explicit mapping rules outrank them. Frequency is not permission to auto-post: still stage for approval.',
    canApprove
      ? '• Categorize transactions: gnubok_list_uncategorized_transactions → gnubok_suggest_categories → gnubok_categorize_transaction (stages) → gnubok_approve_pending_operation (after user confirms in chat).'
      : '• Categorize transactions: gnubok_list_uncategorized_transactions → gnubok_suggest_categories → gnubok_categorize_transaction (stages) → the user approves the proposals in Accounted under Att göra › Rutin (/pending).',
    '• Applying income to invoices: pick by what you have: a specific bank transaction + a known invoice → gnubok_match_transaction_to_invoice; an invoice you know is paid but no specific bank line → gnubok_mark_invoice_as_paid; a whole period of unmatched income to reconcile → gnubok_auto_match_period (dry_run first). All stage for approval. Unsure which match/link tool fits, or whether to credit 1510 (faktureringsmetoden) vs debit 19xx (kontantmetoden)? gnubok_load_skill("bank-reconciliation") has the full decision tree; gnubok_get_agent_briefing returns the company\'s accounting_method.',
    '• Invoicing: gnubok_list_customers (or gnubok_create_customer) → gnubok_create_invoice → gnubok_send_invoice or gnubok_mark_invoice_as_sent → gnubok_mark_invoice_as_paid. Refund via gnubok_credit_invoice.',
    '• Suppliers: gnubok_list_suppliers (or gnubok_create_supplier) → gnubok_create_supplier_invoice_from_inbox → gnubok_approve_supplier_invoice (faktureringsmetoden only: kontantmetoden has no attest step, the invoice is booked when its payment is matched). Refund via gnubok_credit_supplier_invoice.',
    '• VAT: gnubok_get_vat_report(period_type, year, period). Ruta49 = VAT to pay (positive) or refund (negative). Pass render_ui=true to open the momsdeklaration review widget (claude.ai / Desktop). gnubok_vat_close_check reports filing-readiness blockers.',
    '• Reporting: gnubok_get_trial_balance / _income_statement / _balance_sheet / _kpi_report default to the most recent fiscal period; _ar_ledger / _supplier_ledger (through gnubok_call_tool) default to today (as_of_date). For account roll-ups use gnubok_get_general_ledger; for ad-hoc line queries (free-text, amount/date/source filters) use gnubok_query_journal.',
    '• Trust in figures: gnubok_get_trial_balance, _income_statement, _balance_sheet, _kpi_report and _general_ledger return data_status (company-wide for the range, also on filtered reports). When data_status.preliminary is true, say the figures are preliminary and mention the caveats that bear on the question; do not recite them all. When data_status.unavailable is true, say the completeness of the figures could not be checked.',
    `• Interactive review UIs (claude.ai / Claude Desktop only): gnubok_get_vat_report(render_ui=true) renders the VAT widget, gnubok_receipt_matcher opens the receipt↔transaction matcher, and gnubok_list_pending_operations(render_ui=true) ${canApprove ? 'opens the approval queue where the user approves/rejects with a click' : 'shows the queue of agent proposals (read-only on this connection: the user approves them in Accounted)'}. All also return structured data; other clients ignore the UI and use the data.`,
    '• Year-end: run gnubok_year_end_readiness first. For kontantmetoden, resolve kontantmetod_cutoff_required with the searchable gnubok_post_kontantmetod_cutoff tool (one year-end verifikat per open invoice, no reversal; never book the cut-off by hand). Then gnubok_run_year_end on the OPEN period (never gnubok_lock_period first): it posts the closing entry, locks and closes the period and seeds the next period\'s opening balances in one step; gnubok_set_opening_balances, gnubok_close_period and gnubok_lock_period are manual-flow tools, not follow-ups. Verify with gnubok_list_fiscal_periods. Each write stages for human approval; closing is irreversible per BFL.',
    '• Payroll: gnubok_create_salary_run → gnubok_calculate_salary_run → gnubok_book_salary_run → gnubok_generate_agi.',
    '• File URLs: upload_url, signed_url, download_url and original_url each come with a sibling headers object (upload_headers, signed_url_headers, download_headers, original_url_headers). Send those headers with every request to the URL: it carries no token and answers 400 without them, so it does not open as a link in a browser. An empty object means the URL needs none. To give the user a file, hand them app_url where the answer has one: it opens in their browser when they are signed in to Accounted with that company active.',
    ...(canApprove
      ? [
          '• Reviewing & approving staged operations: gnubok_list_pending_operations shows the queue. When the user explicitly authorises a specific operation_id in chat, call gnubok_approve_pending_operation to commit. Use gnubok_reject_pending_operation to discard.',
          'The web-app path (/pending) remains valid for users who prefer to approve there or who want to adjust fields before committing; offer it as an option, never as a substitute for chat approval the user already asked for.',
        ]
      : [
          '• Reviewing agent proposals: gnubok_list_pending_operations shows the queue (each write tool stages a pending_operation, an agent proposal). A proposal you staged by mistake (a duplicate, a wrong amount) you take back yourself, before staging the corrected one: gnubok_stage_tool({tool: "gnubok_withdraw_pending_operation", arguments: {operation_id, reason}}). Only your own, only while pending.',
        ]),
    '• Naming a proposal: a staged answer and each row of gnubok_list_pending_operations carry operation_number, the proposal\'s number in its company (counts up, never changes). The user sees it in Accounted as "Förslag 128", so say the number when you talk about a proposal and read it as operation_number when the user names one; tools take operation_id. A proposal decided before numbers were introduced has none.',
    'A tool whose tools/list `_meta.requires_approval` is true stages for approval; `_meta.preflight` (when present) names a read-only check to run first (e.g. gnubok_year_end_readiness before gnubok_run_year_end, gnubok_vat_declaration_validate before _submit). Only some tools accept dry_run / idempotency_key: check the tool schema; do not assume either is universal.',
    toolNamespace === 'gnubok'
      ? 'Tool names carry the legacy gnubok_ prefix (a stable identifier kept across the rebrand); the server and app are "Accounted". Same product: the prefix is not a different system.'
      : 'Tool names use the accounted_ prefix. Legacy gnubok_ aliases remain accepted for existing integrations.',
  ].join('\n')

  return { head, reference }
}

export function buildServerInstructions(o: ServerInstructionsOptions): string {
  const { head, reference } = buildServerInstructionParts(o)
  return `${head}\n${reference}`
}
