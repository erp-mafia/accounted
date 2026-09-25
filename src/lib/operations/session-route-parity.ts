/**
 * Session-route parity manifest: "everything you can do in the product is
 * doable via the API", written down and kept honest by
 * ./__tests__/session-route-parity.test.ts.
 *
 * Every dashboard (session-cookie) WRITE route gets one entry here, keyed
 * '<METHOD> <path>' with Next dynamic segments written as :name (catch-alls
 * as :name*). Methods in scope: POST, PUT, PATCH, DELETE. Routes that only
 * export GET are out of scope. Routes declared inside extensions and reached
 * through the /api/extensions/ext/[...path] dispatcher are listed by their
 * public path, e.g. 'POST /api/extensions/ext/invoice-inbox/items/:id/convert'.
 *
 * Statuses:
 *   covered  : a public machine door does the same core action. `by` lists
 *              V1_ENDPOINT_SCOPES keys ('POST /api/v1/...') and/or MCP tool
 *              names from TOOL_SCOPE_MAP ('gnubok_*'). Partial coverage
 *              counts only when the core action is the same; the gap goes in
 *              `note`.
 *   gap      : a user capability no public door offers. P1 = core monthly
 *              workflow for an API customer or agent (bookkeeping, VAT,
 *              invoicing, AP, bank, payroll, filing), P2 = important but less
 *              frequent, P3 = nice to have.
 *   ui-only  : legitimately browser-only: auth/password/MFA/session, OAuth
 *              consent and BankID redirects, billing checkout, credential
 *              minting (privilege escalation), UI preferences, previews of
 *              unsaved forms, destructive owner-only resets, the in-app
 *              assistant runtime, support contact.
 *   machine  : not a user action at all: cron receivers, inbound webhooks,
 *              OAuth token/registration endpoints, the self-hosted connector
 *              proxies, telemetry sinks and the MCP door itself.
 *
 * How to update:
 *   - A new session write route fails the test until it has an entry here.
 *     Decide: is there a public door (covered), should there be one (gap),
 *     or is it genuinely browser-only (ui-only) / not a user action (machine)?
 *   - When you close a gap (new v1 route or MCP tool), flip the entry to
 *     { status: 'covered', by: [...] } and lower GAP_CEILING by one. The test
 *     demands the exact count, so a new gap is visible in review too.
 *   - A removed route fails the test as stale: delete its entry.
 */

export type ParityPriority = 'P1' | 'P2' | 'P3'

export type ParityEntry =
  | { status: 'covered'; by: readonly string[]; note?: string }
  | { status: 'gap'; priority: ParityPriority; note?: string }
  | { status: 'ui-only'; reason: string }
  | { status: 'machine'; reason: string }

export type ParityStatus = ParityEntry['status']

/** '<METHOD> <path>', e.g. 'POST /api/supplier-invoices/:id/approve'. */
export type SessionRouteKey = `${'POST' | 'PUT' | 'PATCH' | 'DELETE'} /api/${string}`

const covered = (by: readonly string[], note?: string): ParityEntry =>
  note ? { status: 'covered', by, note } : { status: 'covered', by }
const gap = (priority: ParityPriority, note?: string): ParityEntry =>
  note ? { status: 'gap', priority, note } : { status: 'gap', priority }
const uiOnly = (reason: string): ParityEntry => ({ status: 'ui-only', reason })
const machine = (reason: string): ParityEntry => ({ status: 'machine', reason })

/** v1 company-scoped prefix, to keep the `by` lists readable. */
const V = '/api/v1/companies/:companyId'

const AUTH = 'auth, password or session management'
const PREFS = 'per-user UI preference or notice state'
const PRIVILEGE = 'grants access or mints credentials (privilege escalation)'
const OAUTH_CONNECT = 'third-party OAuth/consent connect runs in the browser'
const ASSISTANT = 'in-app assistant runtime; external agents are the API customer'
const CRON = 'machine endpoint: cron receiver'
const WEBHOOK = 'machine endpoint: inbound webhook'
const CONNECTOR = 'machine endpoint: self-hosted connector proxy, authenticated by a connector key'
const PREVIEW = 'preview/parse helper for an unsaved form or import wizard; the API takes structured input'
const EXT_SYNC = 'webshop/payment integration sync is cron-driven; manual trigger has no API'

export const SESSION_ROUTE_PARITY: Record<string, ParityEntry> = {
  // ── Auth, account, user preferences ────────────────────────────────
  'POST /api/account/delete': uiOnly('destructive owner-only account erasure (GDPR), confirmed in the browser'),
  'POST /api/account/email': uiOnly(AUTH),
  'POST /api/account/password': uiOnly(AUTH),
  'POST /api/auth/email-hook': machine('machine endpoint: Supabase auth email hook'),
  'POST /api/auth/heartbeat': uiOnly(AUTH),
  'POST /api/auth/password-reset': uiOnly(AUTH),
  'POST /api/auth/signup': uiOnly(AUTH),
  'POST /api/user/locale': uiOnly(PREFS),
  'POST /api/user/profile': uiOnly('per-user profile (name) of the logged-in person'),
  'POST /api/user/ui-state': uiOnly(PREFS),
  'PATCH /api/user/preferences': uiOnly(PREFS),
  'POST /api/notices/dismiss': uiOnly(PREFS),
  'PUT /api/kpi/preferences': uiOnly(PREFS),
  'PATCH /api/onboarding/state': uiOnly('onboarding wizard UI state'),
  'POST /api/onboarding/books/exit': uiOnly('onboarding wizard UI state (first-session gate cookie)'),
  'POST /api/sandbox/seed': uiOnly('sandbox demo seeding'),
  'POST /api/support/contact': uiOnly('support contact form'),
  'POST /api/log': machine('machine endpoint: unauthenticated client telemetry sink'),
  'POST /api/billing/checkout': uiOnly('Stripe checkout'),
  'POST /api/billing/portal': uiOnly('Stripe customer portal'),

  // ── Credentials, OAuth, membership (privilege) ─────────────────────
  'POST /api/settings/api-keys': uiOnly(PRIVILEGE),
  'PATCH /api/settings/api-keys/:id': uiOnly(PRIVILEGE),
  'DELETE /api/settings/api-keys/:id': uiOnly(PRIVILEGE),
  'POST /api/settings/oauth-clients': uiOnly(PRIVILEGE),
  'DELETE /api/settings/oauth-clients/:id': uiOnly(PRIVILEGE),
  'POST /api/mcp-oauth/authorize': uiOnly('OAuth consent screen'),
  'POST /api/mcp-oauth/register': machine('machine endpoint: OAuth dynamic client registration'),
  'POST /api/mcp-oauth/token': machine('machine endpoint: OAuth token exchange'),
  'POST /api/calendar/feed': uiOnly('mints a secret calendar feed URL (credential)'),
  'PUT /api/calendar/feed': uiOnly('calendar feed subscription settings for the secret feed URL'),
  'DELETE /api/calendar/feed': uiOnly('revokes the secret calendar feed URL (credential)'),
  'POST /api/company/members/invite': uiOnly(PRIVILEGE),
  'DELETE /api/company/members/invite/:id': uiOnly(PRIVILEGE),
  'DELETE /api/company/members/:id': uiOnly(PRIVILEGE),
  'POST /api/team/invite': uiOnly(PRIVILEGE),
  'POST /api/team/invite/:id': uiOnly(PRIVILEGE),
  'DELETE /api/team/invite/:id': uiOnly(PRIVILEGE),
  'POST /api/team/accept': uiOnly('invite acceptance by the invited person'),
  'PATCH /api/team/members/:id': uiOnly(PRIVILEGE),
  'DELETE /api/team/members/:id': uiOnly(PRIVILEGE),
  'POST /api/clients/signup-access': uiOnly('byrå signup allowlist (access control)'),
  'PATCH /api/clients/signup-access': uiOnly('byrå signup mode (access control)'),
  'DELETE /api/clients/signup-access': uiOnly('byrå signup allowlist (access control)'),

  // ── Company and byrå ───────────────────────────────────────────────
  'PATCH /api/company/current': uiOnly('switches the browser session\'s active company; the API addresses companies per request'),
  'POST /api/company/:id/delete': uiOnly('destructive owner-only company archive'),
  'POST /api/company/:id/migration-reset': uiOnly('destructive owner-only migration reset'),
  'PATCH /api/byra/brand': gap('P3', 'byrå brand profile'),
  'POST /api/byra/brand/logo': gap('P3', 'byrå brand logo'),
  'DELETE /api/byra/brand/logo': gap('P3', 'byrå brand logo'),

  // ── Settings ───────────────────────────────────────────────────────
  'PUT /api/settings': covered(
    [`PATCH ${V}/settings`, 'gnubok_update_company_settings'],
    'the API covers the common fields; not every settings column is writable over the API',
  ),
  'POST /api/settings/logo': gap('P3', 'invoice logo upload'),
  'DELETE /api/settings/logo': gap('P3'),
  'POST /api/settings/invoice-font': gap('P3', 'invoice font upload'),
  'DELETE /api/settings/invoice-font': gap('P3'),
  'POST /api/settings/booking-templates': gap('P3', 'booking templates (konteringsmallar)'),
  'DELETE /api/settings/booking-templates': gap('P3'),
  'PUT /api/settings/booking-templates/:id': gap('P3'),
  'POST /api/settings/booking-templates/:id/hide': uiOnly(PREFS),
  'DELETE /api/settings/booking-templates/:id/hide': uiOnly(PREFS),
  'POST /api/settings/booking-templates/:id/touch': uiOnly('usage counter for the template picker'),
  'POST /api/settings/booking-templates/import': gap('P3', 'import templates exported from another company'),
  'PATCH /api/settings/counterparty-templates': gap('P3', 'rename a learned counterparty template (read via gnubok_get_counterparty_templates)'),
  'DELETE /api/settings/counterparty-templates': gap('P3'),
  'POST /api/settings/peppol': gap('P2', 'Peppol participant registration'),
  'DELETE /api/settings/peppol': gap('P3', 'Peppol deregistration'),
  'POST /api/settings/peppol/access': gap('P3', 'request Peppol access from operators'),
  'PATCH /api/extensions/:sector/:slug/settings': uiOnly('extension toggle and per-extension UI settings'),
  'POST /api/extensions/:sector/:slug/data': uiOnly('internal extension key-value state'),
  'DELETE /api/extensions/:sector/:slug/data': uiOnly('internal extension key-value state'),
  'PATCH /api/rules/:id': gap('P3', 'edit a counterparty booking rule'),

  // ── Chart of accounts ──────────────────────────────────────────────
  'POST /api/bookkeeping/accounts': covered(['gnubok_create_account']),
  'PUT /api/bookkeeping/accounts/:number': covered(['gnubok_update_account']),
  'DELETE /api/bookkeeping/accounts/:number': gap('P3', 'delete an unused account'),
  'POST /api/bookkeeping/accounts/activate': covered(['gnubok_create_account', 'gnubok_update_account'], 'one account per call, no batch'),
  'POST /api/bookkeeping/accounts/deactivate': covered(['gnubok_update_account'], 'is_active=false one account per call, no batch'),
  'POST /api/bookkeeping/accounts/prune': gap('P3', 'bulk-delete unused accounts'),

  // ── Journal entries (verifikat) ────────────────────────────────────
  'POST /api/bookkeeping/journal-entries': covered([`POST ${V}/journal-entries`, 'gnubok_create_voucher']),
  'PATCH /api/bookkeeping/journal-entries/:id': gap('P2', 'edit a DRAFT verifikat in place (header and lines)'),
  'DELETE /api/bookkeeping/journal-entries/:id': covered([`DELETE ${V}/journal-entries/:id`]),
  'POST /api/bookkeeping/journal-entries/:id/commit': covered([`POST ${V}/journal-entries/:id/commit`]),
  'POST /api/bookkeeping/journal-entries/:id/correct': covered([`POST ${V}/journal-entries/:id/correct`, 'gnubok_correct_entry']),
  'POST /api/bookkeeping/journal-entries/:id/reverse': covered([`POST ${V}/journal-entries/:id/reverse`, 'gnubok_reverse_journal_entry']),
  'POST /api/bookkeeping/journal-entries/:id/correct-metadata': gap('P2', 'inline metadata rättelse (description/date) of a posted verifikat; storno is covered'),
  'POST /api/bookkeeping/journal-entries/:id/strike-lines': gap('P2', 'inline line rättelse inside a posted verifikat; storno is covered'),
  'POST /api/bookkeeping/journal-entries/:id/recordate': gap('P3', 're-date a posted verifikat via storno and re-post'),
  'PATCH /api/bookkeeping/journal-entries/:id/notes': covered(['gnubok_set_voucher_note']),
  'POST /api/bookkeeping/journal-entries/:id/no-document-required': gap('P2', 'mark a verifikat "inget underlag krävs"'),
  'DELETE /api/bookkeeping/journal-entries/:id/no-document-required': gap('P3'),
  'POST /api/bookkeeping/no-doc-required/batch': gap('P2', 'batch "inget underlag krävs"'),
  'POST /api/bookkeeping/no-doc-required/bulk-missing': gap('P3', 'filter-wide "inget underlag krävs"'),
  'POST /api/bookkeeping/journal-entry-lines/:lineId/retag': covered(['gnubok_tag_journal_lines']),
  'POST /api/bookkeeping/voucher-gaps': covered([`POST ${V}/voucher-gap-explanations`, 'gnubok_explain_voucher_gap']),
  'POST /api/bookkeeping/fix-cash-mismatch': uiOnly('one-off remediation of a historical matcher bug, reviewed payment by payment'),

  // ── Accruals (periodiseringar) ─────────────────────────────────────
  'POST /api/bookkeeping/fiscal-periods/:id/accruals': covered(
    ['gnubok_propose_accruals', 'gnubok_create_voucher'],
    'proposal is read-only; posting goes through a generic voucher',
  ),
  'POST /api/bookkeeping/accruals/:id/dissolve': gap('P3', 'dissolve an accrual schedule early'),
  'POST /api/bookkeeping/accruals/post-due': gap('P3', 'manual trigger of the daily accrual run (list via gnubok_list_accrual_schedules)'),
  'POST /api/bookkeeping/accruals/post-due/cron': machine(CRON),

  // ── Fiscal periods, year-end, årsredovisning ───────────────────────
  'POST /api/bookkeeping/fiscal-periods': gap('P2', 'create a räkenskapsår'),
  'PATCH /api/bookkeeping/fiscal-periods/:id': gap('P3', 'edit räkenskapsår dates before any entries'),
  'POST /api/bookkeeping/fiscal-periods/:id/lock': covered([`POST ${V}/fiscal-periods/:id/lock`, 'gnubok_lock_period']),
  'POST /api/bookkeeping/fiscal-periods/:id/unlock': covered(['gnubok_unlock_period']),
  'POST /api/bookkeeping/fiscal-periods/:id/year-end': covered([`POST ${V}/fiscal-periods/:id/year-end`, 'gnubok_run_year_end']),
  'POST /api/bookkeeping/fiscal-periods/:id/close-external': gap('P3', 'mark an imported year as closed in a previous system'),
  'POST /api/bookkeeping/fiscal-periods/:id/reopen-external': gap('P3', 'undo close-external'),
  'POST /api/bookkeeping/fiscal-periods/:id/reset': uiOnly('destructive owner-only fiscal year reset'),
  'POST /api/bookkeeping/fiscal-periods/:id/opening-balance-review': gap('P3', 'sign off the opening balance review'),
  'POST /api/bookkeeping/fiscal-periods/:id/depreciation': covered(['gnubok_post_annual_depreciation']),
  'PUT /api/bookkeeping/fiscal-periods/:id/depreciation': gap('P3', 'save skattemässig (tax) depreciation choice'),
  'POST /api/bookkeeping/fiscal-periods/:id/bokslutsdispositioner': covered(
    ['gnubok_propose_dispositioner', 'gnubok_create_voucher'],
    'proposal is read-only; posting goes through a generic voucher',
  ),
  'PUT /api/bookkeeping/fiscal-periods/:id/bokslutsdispositioner': gap('P3', 'save dispositioner adjustments'),
  'PATCH /api/bookkeeping/fiscal-periods/:id/bokslut-checklist': gap('P3', 'tick a bokslut checklist item'),
  'PATCH /api/bookkeeping/fiscal-periods/:id/arsredovisning/compliance': gap('P3', 'årsredovisning compliance profile'),
  'POST /api/bookkeeping/fiscal-periods/:id/arsredovisning/narrative': gap('P2', 'förvaltningsberättelse and notes text (preview/validate are covered)'),
  'POST /api/bookkeeping/fiscal-periods/:id/arsredovisning/versions': gap('P2', 'freeze an årsredovisning version for signing'),
  'POST /api/bookkeeping/fiscal-periods/:id/arsredovisning/signatures': gap('P2', 'add an underskrift'),
  'PATCH /api/bookkeeping/fiscal-periods/:id/arsredovisning/signatures/:signatureId': gap('P3'),
  'DELETE /api/bookkeeping/fiscal-periods/:id/arsredovisning/signatures/:signatureId': gap('P3'),

  // ── Dimensions ─────────────────────────────────────────────────────
  'POST /api/dimensions': covered([`POST ${V}/dimensions`, 'gnubok_create_dimension']),
  'PATCH /api/dimensions/:id': covered([`PATCH ${V}/dimensions/:id`, 'gnubok_update_dimension']),
  'DELETE /api/dimensions/:id': covered([`DELETE ${V}/dimensions/:id`, 'gnubok_delete_dimension']),
  'POST /api/dimensions/:id/values': covered([`POST ${V}/dimensions/:id/values`, 'gnubok_create_dimension_value']),
  'PATCH /api/dimensions/:id/values/:valueId': covered([`PATCH ${V}/dimensions/:id/values/:valueId`]),
  'DELETE /api/dimensions/:id/values/:valueId': covered([`DELETE ${V}/dimensions/:id/values/:valueId`]),
  'POST /api/dimensions/rules': gap('P3', 'per-account dimension policy'),
  'PATCH /api/dimensions/rules/:id': gap('P3'),
  'DELETE /api/dimensions/rules/:id': gap('P3'),
  'POST /api/dimensions/import-existing': gap('P3', 'backfill dimension values from existing journal lines'),
  'POST /api/dimensions/tagging/apply': covered(['gnubok_tag_journal_lines']),

  // ── Bank transactions ──────────────────────────────────────────────
  'POST /api/transactions': covered([`POST ${V}/transactions/ingest`, 'gnubok_create_transactions']),
  'PATCH /api/transactions/:id': gap('P3', 'edit a transaction title'),
  'DELETE /api/transactions/:id': gap('P2', 'delete an unbooked transaction (e.g. a duplicate import)'),
  'PATCH /api/transactions/:id/cash-account': gap('P3', 'move an unbooked transaction to another cash account'),
  'POST /api/transactions/:id/book': covered(['gnubok_bulk_book_transactions'], 'book one transaction with explicit lines as a batch of one'),
  'POST /api/transactions/:id/categorize': covered([`POST ${V}/transactions/:id/categorize`, 'gnubok_categorize_transaction']),
  'POST /api/transactions/:id/uncategorize': covered([`POST ${V}/transactions/:id/uncategorize`, 'gnubok_uncategorize_transaction']),
  'POST /api/transactions/:id/ignore': covered([`POST ${V}/transactions/:id/ignore`, 'gnubok_ignore_transaction']),
  'DELETE /api/transactions/:id/ignore': covered([`DELETE ${V}/transactions/:id/ignore`]),
  'POST /api/transactions/:id/attach-document': covered(['gnubok_attach_document_to_transaction']),
  'DELETE /api/transactions/:id/attach-document': gap('P3', 'detach a document from a transaction'),
  'POST /api/transactions/:id/link-journal-entry': covered(['gnubok_link_transaction_to_journal_entry']),
  'POST /api/transactions/:id/match-batch': covered(['gnubok_match_batch_allocate']),
  'POST /api/transactions/:id/match-invoice': covered([`POST ${V}/transactions/:id/match-invoice`, 'gnubok_match_transaction_to_invoice']),
  'POST /api/transactions/:id/match-supplier-invoice': covered([`POST ${V}/transactions/:id/match-supplier-invoice`]),
  'POST /api/transactions/:id/match-expense-payout': gap('P2', 'book a bank row as repayment of utlägg'),
  'POST /api/transactions/:id/match-rot-rut-payout': covered(['gnubok_settle_rot_rut_payout']),
  'POST /api/transactions/:id/refresh-exchange-rate': gap('P3', 'repair a missing/wrong SEK rate'),
  'POST /api/transactions/batch-match-invoices': covered(['gnubok_auto_match_period'], 'auto-match proposals rather than an explicit pair list'),
  'POST /api/transactions/bulk-book': covered(['gnubok_bulk_book_transactions']),
  'POST /api/transactions/suggest-categories': covered(['gnubok_suggest_categories']),

  // ── Cash accounts ──────────────────────────────────────────────────
  'POST /api/cash-accounts': gap('P2', 'create a bank/cash account (list via gnubok_list_cash_accounts)'),
  'PATCH /api/cash-accounts/:id': gap('P2', 'edit a cash account (name, IBAN, ledger account)'),
  'POST /api/cash-accounts/:id/primary': gap('P3'),
  'PUT /api/cash-accounts/payee-defaults': gap('P3', 'per-currency payee account on invoices'),

  // ── Reconciliation ─────────────────────────────────────────────────
  'POST /api/reconciliation/bank/run': covered([`POST ${V}/reconciliation/bank/run`]),
  'POST /api/reconciliation/bank/link': covered(['gnubok_link_transaction_to_journal_entry', 'gnubok_reconcile_match']),
  'POST /api/reconciliation/bank/confirm-suggestions': covered(['gnubok_reconcile_match'], 'use_proposals; bulk reject has no API'),
  'POST /api/reconciliation/bank/mark-opening-balance': gap('P3', 're-tag a voucher as opening balance'),
  'POST /api/reconciliation/accounts/:accountKey/links': covered([`POST ${V}/reconciliation/accounts/:accountKey/links`, 'gnubok_reconcile_match']),
  'DELETE /api/reconciliation/accounts/:accountKey/links/:linkId': covered([`DELETE ${V}/reconciliation/accounts/:accountKey/links/:linkId`, 'gnubok_reconcile_unmatch']),
  'POST /api/reconciliation/accounts/:accountKey/items/:itemId/ignore': covered([`POST ${V}/reconciliation/accounts/:accountKey/items/:itemId/ignore`]),
  'POST /api/reconciliation/accounts/:accountKey/residual': covered([`POST ${V}/reconciliation/accounts/:accountKey/residual`, 'gnubok_reconcile_residual']),
  'POST /api/reconciliation/accounts/:accountKey/signoff': covered([`POST ${V}/reconciliation/accounts/:accountKey/signoff`, 'gnubok_reconcile_signoff']),
  'POST /api/reconciliation/accounts/:accountKey/signoff/:signoffId/reopen': covered([`POST ${V}/reconciliation/accounts/:accountKey/signoff/:signoffId/reopen`]),
  'POST /api/reconciliation/accounts/:accountKey/attachments': gap('P3', 'balansdag underlag for an account'),
  'DELETE /api/reconciliation/accounts/:accountKey/attachments/:attachmentId': gap('P3'),

  // ── Documents and archive ──────────────────────────────────────────
  'POST /api/documents': covered([`POST ${V}/documents`, 'gnubok_upload_document']),
  'DELETE /api/documents/:id': gap('P3', 'delete an unlinked document'),
  'POST /api/documents/:id/link': covered([`POST ${V}/documents/:id/link`, 'gnubok_link_document_to_voucher']),
  'POST /api/documents/:id/detach': gap('P3', 'detach a duplicate underlag from a posted verifikat'),
  'POST /api/documents/:id/versions': gap('P3', 'new version of a document'),
  'POST /api/documents/:id/admission': gap('P3', 'admit or discard a held document'),
  'POST /api/documents/:id/classification': gap('P3', 'human document type classification'),
  'POST /api/documents/:id/extraction/fields': gap('P3', 'settle extracted fields on an archive document'),
  'POST /api/documents/:id/links': gap('P3', 'link a document to a party/agreement/asset (not a verifikat)'),
  'DELETE /api/documents/:id/links/:linkId': gap('P3'),
  'POST /api/arkiv/facts/:id/revert': gap('P3', 'revert a company fact (gnubok_propose_fact stages new ones)'),
  'POST /api/arkiv/facts/derive': gap('P3', 'recompute company facts now (nightly cron does it)'),
  'POST /api/arkiv/findings/:id': gap('P3', 'close an Arkiv finding'),

  // ── Imports ────────────────────────────────────────────────────────
  'POST /api/import/sie/parse': covered(['gnubok_sie_preflight']),
  'POST /api/import/sie/upload': covered([`POST ${V}/imports/sie/upload`, 'gnubok_create_sie_upload']),
  'POST /api/import/sie/execute': covered([`POST ${V}/imports/sie`, 'gnubok_import_sie']),
  'POST /api/import/sie/create-accounts': covered(['gnubok_import_sie'], 'the API import creates missing accounts itself'),
  'POST /api/import/sie/mappings': gap('P3', 'saved SIE account mappings'),
  'PUT /api/import/sie/mappings': gap('P3'),
  'DELETE /api/import/sie/mappings': gap('P3'),
  'POST /api/import/sie/:id/action': gap('P3', 'SIE import follow-up actions'),
  'POST /api/import/sie/:id/replace': gap('P3', 'replace an SIE import via batch storno'),
  'DELETE /api/import/sie/:id': gap('P3', 'delete a failed/pending SIE import record'),
  'DELETE /api/import/sie/:id/undo': covered(['gnubok_undo_sie_import']),
  'POST /api/import/bank-file/parse': uiOnly(PREVIEW),
  'POST /api/import/bank-file/check-duplicates': uiOnly(PREVIEW),
  'POST /api/import/bank-file/execute': covered([`POST ${V}/imports/bank`]),
  'DELETE /api/import/bank-file/:id/undo': gap('P2', 'undo a bank file import'),
  'POST /api/import/skattekonto-file/parse': uiOnly(PREVIEW),
  'POST /api/import/skattekonto-file/execute': gap('P2', 'import a skattekonto file (self-hosted without SKV connection)'),
  'POST /api/import/customers/parse': uiOnly(PREVIEW),
  'POST /api/import/customers/execute': covered([`POST ${V}/customers/bulk-create`]),
  'POST /api/import/suppliers/parse': uiOnly(PREVIEW),
  'POST /api/import/suppliers/execute': covered([`POST ${V}/suppliers/bulk-create`]),
  'POST /api/import/articles/parse': uiOnly(PREVIEW),
  'POST /api/import/articles/execute': covered(['gnubok_create_article'], 'one article per call, no bulk'),
  'POST /api/import/documents/preview': uiOnly(PREVIEW),
  'POST /api/import/documents/attach': covered(['gnubok_upload_document', 'gnubok_link_documents_to_vouchers']),
  'POST /api/import/opening-balance/parse': uiOnly(PREVIEW),
  'POST /api/import/opening-balance/execute': gap('P2', 'enter/import an arbitrary IB; the API only carries IB forward from a closed year'),
  'POST /api/import/opening-balance/correct': gap('P3', 'IB correction via storno'),
  'POST /api/import/opening-balance/correct-inline': gap('P3', 'IB correction inline'),

  // ── Customers, articles, sales ─────────────────────────────────────
  'POST /api/customers': covered([`POST ${V}/customers`, 'gnubok_create_customer']),
  'PATCH /api/customers/:id': covered([`PATCH ${V}/customers/:id`, 'gnubok_update_customer']),
  'DELETE /api/customers/:id': covered([`DELETE ${V}/customers/:id`]),
  'POST /api/articles': covered(['gnubok_create_article']),
  'PATCH /api/articles/:id': covered(['gnubok_update_article']),
  'DELETE /api/articles/:id': gap('P3'),
  'POST /api/sales-orders': covered(['gnubok_create_sales_order']),
  'PATCH /api/sales-orders/:id': gap('P3', 'edit a draft kundorder'),
  'DELETE /api/sales-orders/:id': gap('P3'),
  'POST /api/sales-orders/:id/transition': covered(['gnubok_transition_sales_order']),
  'POST /api/sales-orders/:id/deliver': covered(['gnubok_register_sales_order_delivery']),
  'POST /api/sales-orders/:id/create-invoice': covered(['gnubok_create_invoice_from_sales_order']),

  // ── Customer invoices ──────────────────────────────────────────────
  'POST /api/invoices': covered([`POST ${V}/invoices`, 'gnubok_create_invoice']),
  'PATCH /api/invoices/:id': covered([`PATCH ${V}/invoices/:id`, 'gnubok_update_invoice']),
  'DELETE /api/invoices/:id': covered([`DELETE ${V}/invoices/:id`, 'gnubok_delete_draft_invoice']),
  'POST /api/invoices/:id/finalize': gap('P3', 'number an unnumbered UI draft; API-created invoices are numbered on create'),
  'POST /api/invoices/:id/book': gap('P1', 'defer_invoice_booking companies: invoices sent over the API are never booked'),
  'POST /api/invoices/bulk-book': gap('P2', 'bulk variant of the deferred Bokför step'),
  'POST /api/invoices/:id/send': covered([`POST ${V}/invoices/:id/send`, 'gnubok_send_invoice']),
  'POST /api/invoices/:id/mark-sent': covered([`POST ${V}/invoices/:id/mark-sent`, 'gnubok_mark_invoice_as_sent']),
  'POST /api/invoices/:id/mark-paid': covered([`POST ${V}/invoices/:id/mark-paid`, 'gnubok_mark_invoice_as_paid']),
  'POST /api/invoices/:id/link-to-voucher': covered(['gnubok_link_invoice_to_voucher']),
  'POST /api/invoices/:id/quote-status': covered([`POST ${V}/invoices/:id/quote-status`, 'gnubok_set_quote_status']),
  'POST /api/invoices/:id/convert': covered(['gnubok_convert_invoice']),
  'POST /api/invoices/:id/convert-to-order': covered(['gnubok_convert_invoice'], 'target order'),
  'POST /api/invoices/:id/peppol': gap('P2', 'stage a Peppol e-invoice delivery'),
  'POST /api/invoices/:id/peppol/send': gap('P2', 'send an invoice over Peppol (B2G)'),
  'POST /api/invoices/:id/refresh-exchange-rate': gap('P3'),
  'POST /api/invoices/:id/send-payment-confirmation': gap('P3', 'email a betalningsbekräftelse'),
  'POST /api/invoices/self-billed': gap('P3', 'register a received självfaktura'),
  'POST /api/invoices/preview-pdf': uiOnly(PREVIEW),
  'POST /api/invoices/recurring': covered(['gnubok_create_recurring_schedule']),
  'PATCH /api/invoices/recurring/:id': covered(['gnubok_update_recurring_schedule']),
  'DELETE /api/invoices/recurring/:id': gap('P3', 'delete a schedule (pause is covered by gnubok_update_recurring_schedule)'),
  'POST /api/invoices/recurring/:id/run': gap('P3', 'run a schedule now'),
  'POST /api/invoices/recurring/cron': machine(CRON),
  'POST /api/invoices/reminders/cron': machine(CRON),
  'POST /api/invoices/reminders/action': machine('machine endpoint: public token link for the invoice recipient'),

  // ── Suppliers and supplier invoices ────────────────────────────────
  'POST /api/suppliers': covered([`POST ${V}/suppliers`, 'gnubok_create_supplier']),
  'PUT /api/suppliers/:id': covered([`PATCH ${V}/suppliers/:id`]),
  'DELETE /api/suppliers/:id': covered([`DELETE ${V}/suppliers/:id`]),
  'POST /api/supplier-invoices': covered([`POST ${V}/supplier-invoices`, 'gnubok_create_supplier_invoice_from_inbox']),
  'PUT /api/supplier-invoices/:id': covered([`PATCH ${V}/supplier-invoices/:id`]),
  'DELETE /api/supplier-invoices/:id': gap('P2', 'delete an unbooked supplier invoice'),
  'POST /api/supplier-invoices/:id/approve': covered([`POST ${V}/supplier-invoices/:id/approve`, 'gnubok_approve_supplier_invoice']),
  'POST /api/supplier-invoices/:id/book': gap('P1', 'defer_invoice_booking companies: registered supplier invoices are never booked over the API'),
  'POST /api/supplier-invoices/:id/mark-paid': covered([`POST ${V}/supplier-invoices/:id/mark-paid`]),
  'POST /api/supplier-invoices/:id/credit': covered([`POST ${V}/supplier-invoices/:id/credit`, 'gnubok_credit_supplier_invoice']),
  'POST /api/supplier-invoices/:id/uncredit': gap('P3'),
  'POST /api/supplier-invoices/:id/link-to-voucher': covered(['gnubok_link_supplier_invoice_to_voucher']),
  'POST /api/supplier-invoices/:id/bank-entered': gap('P3', '"inlagd i banken" mark'),
  'PATCH /api/supplier-invoices/:id/items/:itemId': gap('P3', 'move one item to another account via inline correction'),
  'POST /api/supplier-invoices/payment-batches': gap('P1', 'create a betalfil (pain.001) for supplier payments'),
  'POST /api/supplier-invoices/payment-batches/:id/cancel': gap('P2'),
  'POST /api/supplier-invoices/payment-batches/preview': uiOnly(PREVIEW),

  // ── Expenses, mileage, webshop ─────────────────────────────────────
  'POST /api/expense-claims': gap('P2', 'register an utlägg'),
  'DELETE /api/expense-claims/:id': gap('P3'),
  'POST /api/expense-claims/payouts': gap('P2', 'pay out utlägg'),
  'POST /api/expense-claims/suggest-template': uiOnly(PREVIEW),
  'POST /api/mileage/trips': covered(['gnubok_log_mileage_trip']),
  'PATCH /api/mileage/trips/:id': gap('P3'),
  'DELETE /api/mileage/trips/:id': gap('P3'),
  'POST /api/mileage/book': covered(['gnubok_book_mileage_period']),
  'POST /api/mileage/salary-push': gap('P3', 'push milersättning to a salary run'),
  'POST /api/webshop-orders/:id/book': gap('P3', 'book a webshop order row'),
  'POST /api/webshop-orders/:id/create-invoice': gap('P3'),
  'POST /api/webshop-orders/:id/mark-booked': gap('P3'),
  'DELETE /api/webshop-orders/:id/mark-booked': gap('P3'),
  'POST /api/webshop-orders/bulk-book': gap('P3'),
  'PUT /api/webshop-orders/settings': gap('P3', 'payment-method to account mapping'),

  // ── VAT, tax, ROT/RUT ──────────────────────────────────────────────
  'POST /api/reports/vat-declaration/filings': covered([`POST ${V}/reports/vat-declaration/filings`]),
  'DELETE /api/reports/vat-declaration/filings': covered([`DELETE ${V}/reports/vat-declaration/filings`]),
  'POST /api/reports/vat-declaration/rc-basis-gaps/fix': gap('P3', 'add the missing reverse-charge basbelopp pair'),
  'POST /api/vat/validate': uiOnly('read-only VIES VAT-number check for a form, exposed as POST'),
  'POST /api/tax-assessment-notices': gap('P3', 'register a slutskattebesked'),
  'PATCH /api/tax-assessment-notices/:id': gap('P3'),
  'POST /api/tax-deadlines/generate': gap('P3', 'regenerate tax deadlines'),
  'POST /api/skatteverket/tax-payments/:period/mark-paid': gap('P3', 'mark AGI period tax paid'),
  'POST /api/deadlines': gap('P3', 'custom deadline'),
  'PUT /api/deadlines/:id': gap('P3'),
  'DELETE /api/deadlines/:id': gap('P3'),
  'POST /api/deadlines/:id/complete': gap('P3'),
  'POST /api/rot-rut/payout-file': covered(['gnubok_generate_rot_rut_file']),
  'POST /api/rot-rut/beslut/import': covered(['gnubok_import_rot_rut_beslut']),
  'PATCH /api/rot-rut/payout-requests/:id': gap('P3', 'begäran lifecycle (cancel/rejected)'),
  'POST /api/rot-rut/payout-requests/:id/link-voucher': covered(['gnubok_link_rot_rut_payout_voucher']),
  'POST /api/rot-rut/payout-requests/:id/settle': covered(['gnubok_settle_rot_rut_payout']),
  'POST /api/rot-rut/payout-requests/:id/reclaim': gap('P3', 'book a refused share back onto the customer'),

  // ── Assets ─────────────────────────────────────────────────────────
  'POST /api/assets': covered([`POST ${V}/assets`, 'gnubok_create_asset']),
  'PATCH /api/assets/:id': covered([`PATCH ${V}/assets/:id`, 'gnubok_update_asset']),
  'DELETE /api/assets/:id': covered([`DELETE ${V}/assets/:id`]),
  'POST /api/assets/:id/dispose': covered([`POST ${V}/assets/:id/dispose`, 'gnubok_dispose_asset']),

  // ── Payroll ────────────────────────────────────────────────────────
  'POST /api/salary/employees': covered([`POST ${V}/employees`, 'gnubok_create_employee']),
  'PATCH /api/salary/employees/:id': covered([`PATCH ${V}/employees/:id`, 'gnubok_update_employee']),
  'DELETE /api/salary/employees/:id': covered([`DELETE ${V}/employees/:id`]),
  'POST /api/salary/employees/:id/absence': covered([`PUT ${V}/employees/:id/absence`, 'gnubok_register_absence']),
  'DELETE /api/salary/employees/:id/absence': covered([`DELETE ${V}/employees/:id/absence`, 'gnubok_delete_absence']),
  'POST /api/salary/employees/:id/benefits': covered([`POST ${V}/employees/:id/benefits`]),
  'PATCH /api/salary/employees/:id/benefits/:benefitId': covered([`PATCH ${V}/employees/:id/benefits/:benefitId`]),
  'DELETE /api/salary/employees/:id/benefits/:benefitId': covered([`DELETE ${V}/employees/:id/benefits/:benefitId`]),
  'POST /api/salary/employees/:id/recurring-lines': covered([`POST ${V}/employees/:id/recurring-lines`]),
  'PATCH /api/salary/employees/:id/recurring-lines/:lineId': covered([`PATCH ${V}/employees/:id/recurring-lines/:lineId`]),
  'DELETE /api/salary/employees/:id/recurring-lines/:lineId': covered([`DELETE ${V}/employees/:id/recurring-lines/:lineId`]),
  'POST /api/salary/employees/:id/worked-hours': covered([`PUT ${V}/employees/:id/worked-days`]),
  'POST /api/salary/employees/:id/worked-hours/batch': covered([`PUT ${V}/employees/:id/worked-days`]),
  'DELETE /api/salary/employees/:id/worked-hours': covered([`DELETE ${V}/employees/:id/worked-days`]),
  'PUT /api/salary/employees/:id/opening-balances': covered([`PUT ${V}/employees/:id/opening-balances`, 'gnubok_set_employee_opening_balances']),
  'POST /api/salary/runs': covered([`POST ${V}/salary-runs`, 'gnubok_create_salary_run']),
  'PATCH /api/salary/runs/:id': covered([`PATCH ${V}/salary-runs/:id`, 'gnubok_update_salary_run']),
  'DELETE /api/salary/runs/:id': covered([`DELETE ${V}/salary-runs/:id`]),
  'POST /api/salary/runs/:id/calculate': covered([`POST ${V}/salary-runs/:id/calculate`, 'gnubok_calculate_salary_run']),
  'POST /api/salary/runs/:id/review': covered([`POST ${V}/salary-runs/:id/calculate`], 'v1 calculate advances draft to review'),
  'POST /api/salary/runs/:id/revert': gap('P2', 'review back to draft'),
  'POST /api/salary/runs/:id/approve': covered([`POST ${V}/salary-runs/:id/approve`]),
  'POST /api/salary/runs/:id/unapprove': gap('P2', 'approved back to review'),
  'POST /api/salary/runs/:id/paid': covered([`POST ${V}/salary-runs/:id/mark-paid`]),
  'POST /api/salary/runs/:id/book': covered([`POST ${V}/salary-runs/:id/book`, 'gnubok_book_salary_run']),
  'POST /api/salary/runs/:id/correct': covered([`POST ${V}/salary-runs/:id/correct`]),
  'POST /api/salary/runs/:id/payslips/send': gap('P1', 'email payslips to employees'),
  'POST /api/salary/runs/:id/employees': covered([`POST ${V}/salary-runs/:id/employees`]),
  'PATCH /api/salary/runs/:id/employees/:employeeId': covered([`PATCH ${V}/salary-runs/:id/employees/:employeeId`, 'gnubok_set_run_salary']),
  'DELETE /api/salary/runs/:id/employees/:employeeId': covered([`DELETE ${V}/salary-runs/:id/employees/:employeeId`]),
  'POST /api/salary/runs/:id/employees/:employeeId/expense-claims': gap('P2', 'put open utlägg on the payslip'),
  'POST /api/salary/runs/:id/lines': covered([`POST ${V}/salary-runs/:id/employees/:employeeId/lines`]),
  'PATCH /api/salary/runs/:id/lines/:lineId': covered([`PATCH ${V}/salary-runs/:id/lines/:lineId`, 'gnubok_update_payslip_line']),
  'DELETE /api/salary/runs/:id/lines/:lineId': covered([`DELETE ${V}/salary-runs/:id/lines/:lineId`]),

  // ── Staged operations (Granskning) ─────────────────────────────────
  'POST /api/pending-operations/:id/commit': covered(['gnubok_approve_pending_operation']),
  'POST /api/pending-operations/:id/reject': covered(['gnubok_reject_pending_operation']),
  'POST /api/pending-operations/bulk-commit': covered(['gnubok_approve_pending_operation'], 'one at a time'),
  'POST /api/pending-operations/bulk-reject': covered(['gnubok_reject_pending_operation'], 'one at a time'),
  'PATCH /api/pending-operations/:id': gap('P3', 'edit a staged categorization before approval (reject and restage works)'),

  // ── Counterparts (parties) ─────────────────────────────────────────
  'POST /api/parties/:id/enrich': gap('P3', 'SCB registry enrichment'),
  'POST /api/parties/aliases': gap('P3'),
  'POST /api/parties/decide': gap('P3'),
  'POST /api/parties/decide/undo': gap('P3'),
  'POST /api/parties/merge': gap('P3'),
  'POST /api/parties/merge/undo': gap('P3'),
  'POST /api/parties/promote': gap('P3'),
  'POST /api/parties/promote/undo': gap('P3'),
  'POST /api/parties/resolver/run': gap('P3'),
  'POST /api/parties/suggest': gap('P3'),

  // ── Assistant, skills, knowledge ───────────────────────────────────
  'POST /api/agent/ask': uiOnly(ASSISTANT),
  'POST /api/agent/invoke': uiOnly(ASSISTANT),
  'POST /api/agent/onboarding/stream': uiOnly(ASSISTANT),
  'POST /api/agent/feedback': uiOnly(ASSISTANT),
  'PATCH /api/agent/conversations/:id': uiOnly(ASSISTANT),
  'POST /api/agent/conversations/:id/reject-pending': uiOnly(ASSISTANT),
  'PATCH /api/agent/profile': uiOnly(ASSISTANT),
  'POST /api/agent/profile/verify': uiOnly(ASSISTANT),
  'POST /api/agent/categorize': covered(['gnubok_suggest_categories']),
  'POST /api/agent/categorize/outcome': machine('machine endpoint: calibration telemetry'),
  'POST /api/agent/memory': covered(['gnubok_remember_fact']),
  'PATCH /api/agent/memory/:id': covered(['gnubok_forget_fact'], 'dismiss only; edit and pin have no API'),
  'PATCH /api/agents/knowledge': gap('P3', 'attach knowledge packs to an agent'),
  'POST /api/agents/community/feedback': uiOnly('community upvote by a person'),
  'POST /api/skills': covered(['gnubok_create_skill']),
  'POST /api/skills/draft': covered(['gnubok_create_skill']),
  'PATCH /api/skills/:id': gap('P3'),
  'DELETE /api/skills/:id': gap('P3'),

  // ── Machine endpoints: crons, webhooks, connector proxies ──────────
  'POST /api/peppol/inbound/cron': machine(CRON),
  'POST /api/peppol/outbound/status/cron': machine(CRON),
  'POST /api/receipt-hunt/cron': machine(CRON),
  'POST /api/stripe/webhook': machine(WEBHOOK),
  'POST /api/webhooks/peppol/qvalia': machine(WEBHOOK),
  'POST /api/extensions/woocommerce/callback': machine(WEBHOOK),
  'POST /api/connector/sync': machine('machine endpoint: self-hosted entitlement sync trigger (operator)'),
  'POST /api/connect/entitlements': machine(CONNECTOR),
  'POST /api/connect/skv/oauth/authorize-url': machine(CONNECTOR),
  'POST /api/connect/skv/oauth/token': machine(CONNECTOR),
  'POST /api/connect/bank/:path*': machine(CONNECTOR),
  'DELETE /api/connect/bank/:path*': machine(CONNECTOR),
  'POST /api/connect/peppol/:path*': machine(CONNECTOR),
  'PUT /api/connect/peppol/:path*': machine(CONNECTOR),
  'DELETE /api/connect/peppol/:path*': machine(CONNECTOR),
  'POST /api/connect/skv/api/:path*': machine(CONNECTOR),
  'PUT /api/connect/skv/api/:path*': machine(CONNECTOR),
  'PATCH /api/connect/skv/api/:path*': machine(CONNECTOR),
  'DELETE /api/connect/skv/api/:path*': machine(CONNECTOR),
  'PUT /api/storage/:path*': machine('machine endpoint: signed-URL storage proxy that MCP document uploads PUT bytes to'),

  // ═══ Extension routes (dispatched by /api/extensions/ext/[...path]) ═══

  // enable-banking
  'POST /api/extensions/ext/enable-banking/connect': covered(['gnubok_connect_bank'], 'returns the browser consent link; BankID consent itself is browser-only'),
  'POST /api/extensions/ext/enable-banking/attach': uiOnly('reuse another company\'s bank consent session, then pick accounts in the browser'),
  'POST /api/extensions/ext/enable-banking/sync': covered([`POST ${V}/bank-connections/:connectionId/sync`, 'gnubok_sync_bank']),
  'PATCH /api/extensions/ext/enable-banking/accounts': gap('P3', 'map connected bank accounts to ledger accounts'),
  'DELETE /api/extensions/ext/enable-banking/disconnect': gap('P3'),

  // email
  'POST /api/extensions/ext/email/sending-domain': gap('P3', 'custom sending domain'),
  'POST /api/extensions/ext/email/sending-domain/verify': gap('P3'),
  'PATCH /api/extensions/ext/email/sending-domain': gap('P3'),
  'DELETE /api/extensions/ext/email/sending-domain': gap('P3'),
  'POST /api/extensions/ext/email/delivery-status': machine(WEBHOOK),

  // arcim-migration
  'POST /api/extensions/ext/arcim-migration/connect': covered(['gnubok_connect_migration'], 'returns the connect card; the wizard runs in the browser'),
  'POST /api/extensions/ext/arcim-migration/submit-token': uiOnly('enters a third-party system credential'),
  'POST /api/extensions/ext/arcim-migration/migration-jobs': gap('P3', 'migration wizard steps run in the browser after gnubok_connect_migration'),
  'POST /api/extensions/ext/arcim-migration/migration-jobs/run': gap('P3'),
  'POST /api/extensions/ext/arcim-migration/migration-jobs/retry': gap('P3'),
  'POST /api/extensions/ext/arcim-migration/invoice-completion/retry': gap('P3'),
  'POST /api/extensions/ext/arcim-migration/import-sie': gap('P3'),
  'POST /api/extensions/ext/arcim-migration/migrate': gap('P3'),
  'POST /api/extensions/ext/arcim-migration/reconcile': gap('P3'),
  'POST /api/extensions/ext/arcim-migration/import-documents': gap('P3'),
  'POST /api/extensions/ext/arcim-migration/accept': gap('P3'),
  'DELETE /api/extensions/ext/arcim-migration/disconnect': gap('P3'),

  // tic (BankID identity)
  'POST /api/extensions/ext/tic/bankid/start': uiOnly('BankID flow'),
  'POST /api/extensions/ext/tic/bankid/poll': uiOnly('BankID flow'),
  'POST /api/extensions/ext/tic/bankid/complete': uiOnly('BankID flow'),
  'POST /api/extensions/ext/tic/bankid/cancel': uiOnly('BankID flow'),
  'POST /api/extensions/ext/tic/bankid/link': uiOnly('links a BankID identity to the logged-in person'),
  'POST /api/extensions/ext/tic/bankid/unlink': uiOnly('unlinks a BankID identity from the logged-in person'),

  // mcp-server
  'POST /api/extensions/ext/mcp-server/mcp': machine('machine endpoint: the MCP door itself'),
  'DELETE /api/extensions/ext/mcp-server/mcp': machine('machine endpoint: the MCP door itself'),

  // cloud-backup
  'POST /api/extensions/ext/cloud-backup/connect': uiOnly(OAUTH_CONNECT),
  'POST /api/extensions/ext/cloud-backup/disconnect': gap('P3'),
  'PUT /api/extensions/ext/cloud-backup/schedule': gap('P3'),
  'POST /api/extensions/ext/cloud-backup/sync': gap('P3'),

  // skatteverket
  'POST /api/extensions/ext/skatteverket/disconnect': gap('P3', 'connect is covered by gnubok_connect_skatteverket'),
  'POST /api/extensions/ext/skatteverket/system-connection/verify': uiOnly('Skatteverket system/ombud connection setup via the e-tjänst'),
  'POST /api/extensions/ext/skatteverket/system-connection/deeplink': uiOnly('Skatteverket system/ombud connection setup via the e-tjänst'),
  'DELETE /api/extensions/ext/skatteverket/system-connection': uiOnly('Skatteverket system/ombud connection setup via the e-tjänst'),
  'POST /api/extensions/ext/skatteverket/declaration/validate': covered(['gnubok_vat_declaration_validate']),
  'POST /api/extensions/ext/skatteverket/declaration/draft': covered(['gnubok_vat_declaration_submit'], 'submit saves the draft and locks it for signing in one step'),
  'DELETE /api/extensions/ext/skatteverket/declaration/draft': gap('P3'),
  'PUT /api/extensions/ext/skatteverket/declaration/lock': covered(['gnubok_vat_declaration_submit'], 'submit saves the draft and locks it for signing in one step'),
  'DELETE /api/extensions/ext/skatteverket/declaration/lock': gap('P3', 'unlock a declaration awaiting signature'),
  'POST /api/extensions/ext/skatteverket/declaration/submit': covered(['gnubok_vat_declaration_submit']),
  'POST /api/extensions/ext/skatteverket/agi/submit': covered(['gnubok_agi_submit']),
  'POST /api/extensions/ext/skatteverket/agi/spara': covered(['gnubok_agi_submit'], 'submit saves the underlag and locks it for signing in one step'),
  'POST /api/extensions/ext/skatteverket/agi/las': covered(['gnubok_agi_submit'], 'submit saves the underlag and locks it for signing in one step'),
  'POST /api/extensions/ext/skatteverket/agi/lasUpp': gap('P3', 'unlock an AGI awaiting signature'),
  'DELETE /api/extensions/ext/skatteverket/agi/underlag': gap('P3'),
  'DELETE /api/extensions/ext/skatteverket/agi/sparad': gap('P3'),
  'POST /api/extensions/ext/skatteverket/agi/granskningsunderlag': gap('P3', 'fetch Skatteverket\'s granskningsunderlag'),
  'POST /api/extensions/ext/skatteverket/agi/kontrollera/hu': gap('P2', 'pre-validate AGI huvuduppgift at Skatteverket'),
  'POST /api/extensions/ext/skatteverket/agi/kontrollera/iu': gap('P2', 'pre-validate AGI individuppgifter at Skatteverket'),
  'POST /api/extensions/ext/skatteverket/skattekonto/sync': gap('P2', 'sync skattekonto now (hourly cron does it)'),
  'POST /api/extensions/ext/skatteverket/skattekonto/transaktioner/bokfor-batch': covered(['gnubok_book_skattekonto_rows']),
  'POST /api/extensions/ext/skatteverket/skattekonto/transaktioner/:id/bokfor': covered(['gnubok_book_skattekonto_row']),
  'POST /api/extensions/ext/skatteverket/skattekonto/transaktioner/:id/match': covered(['gnubok_reconcile_match']),
  'PATCH /api/extensions/ext/skatteverket/skattekonto/transaktioner/:id/ignore': covered(
    [`POST ${V}/reconciliation/accounts/:accountKey/items/:itemId/ignore`],
    'with accountKey=skattekonto',
  ),

  // invoice-inbox (Underlag)
  'POST /api/extensions/ext/invoice-inbox/upload': covered(['gnubok_upload_document']),
  'POST /api/extensions/ext/invoice-inbox/upload/create': covered(['gnubok_create_document_upload']),
  'POST /api/extensions/ext/invoice-inbox/upload/complete': covered(['gnubok_complete_document_upload']),
  'PATCH /api/extensions/ext/invoice-inbox/items/:id/fields': covered(['gnubok_set_inbox_extracted_data']),
  'PUT /api/extensions/ext/invoice-inbox/items/:id/extracted-data': covered(['gnubok_set_inbox_extracted_data']),
  'POST /api/extensions/ext/invoice-inbox/items/:id/attach-document': gap('P3', 'add a source file to an existing inbox item'),
  'POST /api/extensions/ext/invoice-inbox/items/:id/match-supplier': gap('P2', 'pick the supplier for an inbox item (convert resolves it or returns candidates)'),
  'POST /api/extensions/ext/invoice-inbox/items/:id/match-transaction': gap('P2', 'pair an inbox item with a bank transaction'),
  'POST /api/extensions/ext/invoice-inbox/items/:id/unmatch-transaction': gap('P3'),
  'POST /api/extensions/ext/invoice-inbox/items/:id/retry-extraction': gap('P3'),
  'POST /api/extensions/ext/invoice-inbox/items/:id/convert': covered(['gnubok_create_supplier_invoice_from_inbox']),
  'POST /api/extensions/ext/invoice-inbox/items/:id/book-direct': covered(['gnubok_bulk_book_inbox_items'], 'batch of one; items without a matched bank row have no API'),
  'POST /api/extensions/ext/invoice-inbox/items/:id/suggest-booking': covered(['gnubok_suggest_categories']),
  'POST /api/extensions/ext/invoice-inbox/items/bulk-book': covered(['gnubok_bulk_book_inbox_items']),
  'DELETE /api/extensions/ext/invoice-inbox/items/:id': gap('P2', 'discard an inbox item'),
  'POST /api/extensions/ext/invoice-inbox/inbox/rotate': gap('P3', 'rotate the inbound e-mail address'),
  'POST /api/extensions/ext/invoice-inbox/inbox/domain': gap('P3'),
  'POST /api/extensions/ext/invoice-inbox/inbox/domain/verify': gap('P3'),
  'DELETE /api/extensions/ext/invoice-inbox/inbox/domain': gap('P3'),
  'POST /api/extensions/ext/invoice-inbox/inbound': machine(WEBHOOK),

  // stripe (payments integration, not billing)
  'POST /api/extensions/ext/stripe/connect': uiOnly(OAUTH_CONNECT),
  'DELETE /api/extensions/ext/stripe/disconnect': gap('P3'),
  'POST /api/extensions/ext/stripe/sync': gap('P3', EXT_SYNC),
  'POST /api/extensions/ext/stripe/backfill': gap('P3', EXT_SYNC),
  'POST /api/extensions/ext/stripe/transaction-sync': gap('P3', EXT_SYNC),

  // whatsapp-inbox
  'POST /api/extensions/ext/whatsapp-inbox/webhook': machine(WEBHOOK),
  'POST /api/extensions/ext/whatsapp-inbox/link/start': uiOnly('links the logged-in person\'s own WhatsApp number'),
  'POST /api/extensions/ext/whatsapp-inbox/link/revoke': uiOnly('links the logged-in person\'s own WhatsApp number'),
  'POST /api/extensions/ext/whatsapp-inbox/link/unmute': uiOnly('links the logged-in person\'s own WhatsApp number'),
  'POST /api/extensions/ext/whatsapp-inbox/link/default-company': uiOnly('links the logged-in person\'s own WhatsApp number'),

  // woocommerce
  'POST /api/extensions/ext/woocommerce/connect': uiOnly(OAUTH_CONNECT),
  'POST /api/extensions/ext/woocommerce/manual-connect': uiOnly('enters a third-party store credential'),
  'DELETE /api/extensions/ext/woocommerce/disconnect': gap('P3'),
  'POST /api/extensions/ext/woocommerce/sync': gap('P3', EXT_SYNC),
  'POST /api/extensions/ext/woocommerce/backfill': gap('P3', EXT_SYNC),
  'POST /api/extensions/ext/woocommerce/transaction-sync': gap('P3', EXT_SYNC),

  // shopify
  'POST /api/extensions/ext/shopify/connect': uiOnly(OAUTH_CONNECT),
  'DELETE /api/extensions/ext/shopify/disconnect': gap('P3'),
  'POST /api/extensions/ext/shopify/sync': gap('P3', EXT_SYNC),
  'POST /api/extensions/ext/shopify/backfill': gap('P3', EXT_SYNC),
  'POST /api/extensions/ext/shopify/transaction-sync': gap('P3', EXT_SYNC),

  // zettle
  'POST /api/extensions/ext/zettle/connect': uiOnly(OAUTH_CONNECT),
  'DELETE /api/extensions/ext/zettle/disconnect': gap('P3'),
  'POST /api/extensions/ext/zettle/sync': gap('P3', EXT_SYNC),
  'POST /api/extensions/ext/zettle/backfill': gap('P3', EXT_SYNC),
  'POST /api/extensions/ext/zettle/transaction-sync': gap('P3', EXT_SYNC),
}

/**
 * The exact number of 'gap' entries today. Covering a gap means lowering
 * this; adding one means raising it in the same diff, visibly.
 */
export const GAP_CEILING = 198
