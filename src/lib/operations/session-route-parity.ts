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
 *              registered v1 endpoints ('POST /api/v1/...') and/or MCP tool
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
const PAYMENT_SIGNING = 'BankID signing of a bank payment: the account holder signs money out in person, no machine door signs'
const BANK_CONSENT = 'BankID consent to read a bank account: the account holder gives it in person, no machine door consents'
const SIGNATORY_LINK = 'token route of the signatory link (/koppla/<token>): the firmatecknare gives the bank consent in person, authenticated by the link, no machine door consents'
const ATTEST_LINK = 'token route of the attest mail\'s link (/attest/<token>): the attester decides in person, authenticated by the link; the same decision is POST /api/v1/.../supplier-invoices/:id/approve or /reject'
const ATTEST_LIST_LINK = 'token route of the batched attest mail\'s list link (/attest/lista/<token>): the attester decides each invoice in person, authenticated by the link; the same decisions are POST /api/v1/.../supplier-invoices/:id/approve or /reject'
const PAYMENT_SIGNING_LINK = 'token route of the payment signing link (/betala/<token>): the firmatecknare signs the payments in person with BankID, authenticated by the link, no machine door signs'
const SIGNING_CEREMONY = 'BankID signing of a document: the signer signs in person, by the link (/signera/<token>) or as the member named; agents and API clients request, chase and read, no machine door signs'
const PREVIEW = 'preview/parse helper for an unsaved form or import wizard; the API takes structured input'
const EXT_SYNC = 'webshop/payment integration sync is cron-driven; "Synka nu" has no door of its own (gnubok_backfill_feed refetches from a named day, which moves the cursor)'
const EXT_SYNC_SWITCH = 'switch the nightly sync of a webshop/payment integration on or off; no door'
const COLLECTIONS_AGREEMENT = "entering or ending the company's agreement with a collection provider: a person consents, accepts and signs"
const CONSENT = 'a person accepts the terms or gives or withdraws consent in person (terms, analytics, the company\'s data choices); an agent or API key never decides what may be done with the data'
const STOCK_COUNT_SIGNATURE = 'the inventeringslista is signed på heder och samvete (LIV 2 §) by a person, by hand or with their own BankID; agents prepare and book it, no machine door signs'

export const SESSION_ROUTE_PARITY: Record<string, ParityEntry> = {
  // ── Auth, account, user preferences ────────────────────────────────
  'POST /api/account/delete': uiOnly('destructive owner-only account erasure (GDPR), confirmed in the browser'),
  'POST /api/account/email': uiOnly(AUTH),
  'POST /api/account/password': uiOnly(AUTH),
  'POST /api/auth/anonymous': uiOnly(AUTH),
  'POST /api/auth/email-hook': machine('machine endpoint: Supabase auth email hook'),
  'POST /api/auth/heartbeat': uiOnly(AUTH),
  'POST /api/auth/login': uiOnly(AUTH),
  'POST /api/auth/logout': uiOnly(AUTH),
  'POST /api/auth/mfa/enroll': uiOnly(AUTH),
  'POST /api/auth/mfa/unenroll': uiOnly(AUTH),
  'POST /api/auth/mfa/verify': uiOnly(AUTH),
  'POST /api/auth/mfa/webauthn/challenge': uiOnly(AUTH),
  'POST /api/auth/mfa/webauthn/enroll': uiOnly(AUTH),
  'POST /api/auth/mfa/webauthn/verify': uiOnly(AUTH),
  'POST /api/auth/oauth': uiOnly(AUTH),
  'POST /api/auth/otp': uiOnly(AUTH),
  'POST /api/auth/password-reset': uiOnly(AUTH),
  'POST /api/auth/signup': uiOnly(AUTH),
  'POST /api/auth/sso': uiOnly(AUTH),
  'POST /api/user/locale': uiOnly(PREFS),
  'POST /api/user/profile': uiOnly('per-user profile (name) of the logged-in person'),
  'POST /api/user/ui-state': uiOnly(PREFS),
  'PATCH /api/user/preferences': uiOnly(PREFS),
  'PUT /api/user/analytics-consent': uiOnly(CONSENT),
  'POST /api/legal/accept': uiOnly(CONSENT),
  'PATCH /api/settings/data-sharing': uiOnly(CONSENT),
  'POST /api/notices/dismiss': uiOnly(PREFS),
  'PUT /api/kpi/preferences': uiOnly(PREFS),
  'PATCH /api/onboarding/state': uiOnly('onboarding wizard UI state'),
  'POST /api/onboarding/books/exit': uiOnly('onboarding wizard UI state (first-session gate cookie)'),
  'POST /api/sandbox/seed': uiOnly('sandbox demo seeding'),
  'POST /api/support/contact': uiOnly('support contact form'),
  'POST /api/support/ask': uiOnly('the AI assistant in the support dialog: it answers a person in the app and writes nothing but its own conversation; a connected agent reads the same ledger through its own tools'),
  'POST /api/log': machine('machine endpoint: unauthenticated client telemetry sink'),
  'POST /api/billing/checkout': uiOnly('Stripe checkout'),
  'POST /api/billing/portal': uiOnly('Stripe customer portal'),
  'POST /api/billing/payment-packs': uiOnly('buying bank payment packs on the Stripe subscription: the owner\'s card is charged at once'),
  // Company formation (lib/formation): a user-level draft before the company
  // exists, so there is no company-scoped v1 or MCP door to put it behind.
  'POST /api/formation': uiOnly('company formation draft before any company exists; v1 and MCP doors are company-scoped'),
  'PUT /api/formation/:id': uiOnly('company formation draft before any company exists; v1 and MCP doors are company-scoped'),
  'POST /api/formation/:id/submitted': uiOnly('the founder marks the verksamt.se filing as sent in, before the company exists'),
  'POST /api/formation/:id/setup': uiOnly('one approval that creates the company from the formation; it becomes the company door\'s first write'),
  'POST /api/billing/usage/requests': uiOnly('asking Accounted for more of a priced service: a person asks, the operators open the charge by hand'),

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
  'POST /api/company/members/invite/:id': uiOnly(PRIVILEGE),
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
  'POST /api/company/switch': uiOnly('switches the browser session\'s active company; the API addresses companies per request'),
  'POST /api/company/:id/delete': uiOnly('destructive owner-only company archive'),
  'POST /api/company/:id/migration-reset': uiOnly('destructive owner-only migration reset'),
  'POST /api/company/check-org-number': uiOnly('read-only onboarding check for a company the user already has, a POST so the org number stays out of the URL'),
  'PATCH /api/byra/brand': gap('P3', 'byrå brand profile'),
  'PUT /api/clients/:companyId/client-number': gap('P3', "the byrå's own customer number for a client; read on GET /api/v1/portfolio/overview and gnubok_client_overview (client_number), not writable there yet"),
  'POST /api/byra/brand/logo': gap('P3', 'byrå brand logo'),
  'DELETE /api/byra/brand/logo': gap('P3', 'byrå brand logo'),

  // ── Settings ───────────────────────────────────────────────────────
  'PUT /api/settings': covered(
    [
      `PATCH ${V}/settings`,
      `PATCH ${V}/settings/tax-profile`,
      `PATCH ${V}/settings/bookkeeping-lock`,
      'gnubok_update_company_settings',
      'gnubok_update_company_tax_profile',
      'gnubok_update_bookkeeping_lock',
    ],
    'entity_type and org_number are fixed; payroll fields via PATCH /salary/settings',
  ),
  'POST /api/settings/registered-office/from-register': covered(
    [`PATCH ${V}/settings`, 'gnubok_update_company_settings'],
    'a door stores the säte it is given (registered_office); asking the register for a missing one has no door',
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
  'PATCH /api/settings/counterparty-templates': covered(['gnubok_rename_counterparty_template']),
  'DELETE /api/settings/counterparty-templates': covered(['gnubok_update_counterparty_template'], 'the soft delete reads as paused (the table\'s mode trigger): mode paused is the same act'),
  'PUT /api/settings/skattekonto-account': covered([`PATCH ${V}/settings/skattekonto-account`], 'no MCP tool yet: a staged write needs its own pending type (issue #50)'),
  'POST /api/settings/skattekonto-account/transfer-draft': covered([`POST ${V}/journal-entries`, 'gnubok_create_voucher'], 'the route drafts one two-line verifikat; a door books the same two lines as a generic voucher, with the amount from the account change answer (left_on_previous)'),
  'POST /api/settings/peppol': covered([`POST ${V}/peppol/registration`, 'gnubok_register_peppol_participant']),
  'DELETE /api/settings/peppol': gap('P3', 'Peppol deregistration'),
  'POST /api/settings/peppol/access': covered([`POST ${V}/peppol/access-request`, 'gnubok_request_peppol_access']),
  // Påminnelser och inkasso: the company's agreement with a third-party
  // provider is entered and ended by a person, never by an agent (build spec
  // rule 4: approvals that carry a human attestation are web-only).
  'POST /api/settings/collections/consent': uiOnly(COLLECTIONS_AGREEMENT),
  'POST /api/settings/collections/onboarding': uiOnly(COLLECTIONS_AGREEMENT),
  'POST /api/settings/collections/terms': uiOnly(COLLECTIONS_AGREEMENT),
  'POST /api/settings/collections/signature': uiOnly(COLLECTIONS_AGREEMENT),
  'POST /api/settings/collections/cancel': uiOnly(COLLECTIONS_AGREEMENT),
  'POST /api/settings/collections/disconnect': uiOnly(COLLECTIONS_AGREEMENT),
  'POST /api/settings/collections/refresh': uiOnly('status refresh button; the sync cron polls the same status every ten minutes'),
  'PATCH /api/settings/collections': gap('P3', 'the rules for handing invoices over to collection, and the booking accounts and automatic booking of what the provider collects'),
  'POST /api/extensions/:sector/:slug/data': uiOnly('internal extension key-value state'),
  'DELETE /api/extensions/:sector/:slug/data': uiOnly('internal extension key-value state'),
  'PATCH /api/rules/:id': covered(['gnubok_update_counterparty_template']),
  // Hard blocks (accounted#130): what no key, agent, grant or bulk path may
  // book without a person's review. A key that could lift one would lift its
  // own limit, so an owner or admin sets and archives them in the browser.
  'POST /api/rules/blocks': uiOnly('a hard block decides what agents may never book without a person; an owner or admin sets it in the browser'),
  'DELETE /api/rules/blocks/:ruleId': uiOnly('archiving a hard block widens what agents may book; an owner or admin lifts it in the browser'),

  // ── Chart of accounts ──────────────────────────────────────────────
  'POST /api/bookkeeping/accounts': covered([`POST ${V}/accounts`, 'gnubok_create_account']),
  'PUT /api/bookkeeping/accounts/:number': covered([`PATCH ${V}/accounts/:number`, 'gnubok_update_account']),
  'DELETE /api/bookkeeping/accounts/:number': covered([`DELETE ${V}/accounts/:number`, 'gnubok_delete_account']),
  'POST /api/bookkeeping/accounts/activate': covered([`POST ${V}/accounts/activate`, 'gnubok_activate_accounts']),
  'POST /api/bookkeeping/accounts/deactivate': covered([`POST ${V}/accounts/deactivate`, 'gnubok_deactivate_accounts']),
  'POST /api/bookkeeping/accounts/oss-countries': covered([`POST ${V}/accounts/oss-countries`, 'gnubok_set_oss_account_countries']),
  'POST /api/bookkeeping/accounts/prune': gap('P3', 'bulk-delete unused accounts; DELETE /accounts/:number does it one at a time'),

  // ── Journal entries (verifikat) ────────────────────────────────────
  'POST /api/bookkeeping/journal-entries': covered([`POST ${V}/journal-entries`, 'gnubok_create_voucher', `POST ${V}/vat/settlement`, 'gnubok_book_vat_settlement']),
  'PATCH /api/bookkeeping/journal-entries/:id': covered([`PATCH ${V}/journal-entries/:id`]),
  'DELETE /api/bookkeeping/journal-entries/:id': covered([`DELETE ${V}/journal-entries/:id`, 'gnubok_cancel_draft_entry']),
  'POST /api/bookkeeping/journal-entries/:id/commit': covered([`POST ${V}/journal-entries/:id/commit`]),
  'POST /api/bookkeeping/journal-entries/:id/correct': covered([`POST ${V}/journal-entries/:id/correct`, 'gnubok_correct_entry']),
  'POST /api/bookkeeping/journal-entries/:id/reverse': covered([`POST ${V}/journal-entries/:id/reverse`, 'gnubok_reverse_journal_entry']),
  'POST /api/bookkeeping/journal-entries/:id/correct-metadata': covered([`POST ${V}/journal-entries/:id/correct-metadata`, 'gnubok_correct_entry_metadata']),
  'POST /api/bookkeeping/journal-entries/:id/strike-lines': covered([`POST ${V}/journal-entries/:id/strike-lines`, 'gnubok_correct_entry_lines']),
  'POST /api/bookkeeping/accruals': covered([`POST ${V}/accrual-schedules`, 'gnubok_create_accrual_schedule']),
  'PATCH /api/bookkeeping/accruals/:id': covered([`POST ${V}/accrual-schedules/:id/replan`, 'gnubok_replan_accrual_schedule']),
  'POST /api/bookkeeping/accruals/:id/cancel': covered([`POST ${V}/accrual-schedules/:id/cancel`, 'gnubok_cancel_accrual_schedule']),
  'POST /api/bookkeeping/journal-entries/:id/recordate': covered([`POST ${V}/journal-entries/:id/redate`, 'gnubok_redate_entry']),
  'PATCH /api/bookkeeping/journal-entries/:id/notes': covered([`PATCH ${V}/journal-entries/:id/notes`, 'gnubok_set_voucher_note']),
  'POST /api/bookkeeping/journal-entries/:id/no-document-required': covered([`POST ${V}/journal-entries/:id/no-document-required`, 'gnubok_mark_no_document_required'], 'the tool takes journal_entry_ids: one verifikat is a batch of one'),
  'DELETE /api/bookkeeping/journal-entries/:id/no-document-required': covered([`DELETE ${V}/journal-entries/:id/no-document-required`]),
  'POST /api/bookkeeping/no-doc-required/batch': covered([`POST ${V}/journal-entries/no-document-required`, 'gnubok_mark_no_document_required']),
  'POST /api/bookkeeping/no-doc-required/bulk-missing': covered([`POST ${V}/journal-entries/no-document-required`, 'gnubok_mark_no_document_required'], 'the same mark (markEntriesNoDocRequired) by journal_entry_ids, up to 500 a call, from gnubok_list_verifikat_without_documents; choosing by filter on the server is the dashboard only'),
  'POST /api/bookkeeping/journal-entry-lines/:lineId/retag': covered([`POST ${V}/dimensions/retag`, 'gnubok_tag_journal_lines']),
  'POST /api/bookkeeping/voucher-gaps': covered([`POST ${V}/voucher-gap-explanations`, 'gnubok_explain_voucher_gap']),
  // Pågående arbeten (K3 kapitel 23), behind NEXT_PUBLIC_CONTRACT_REVENUE_ENABLED: dashboard first.
  'PUT /api/bookkeeping/contract-revenue': gap('P3', 'choose the method and the pinned adjustment account for pågående arbeten'),
  'DELETE /api/bookkeeping/contract-revenue': gap('P3', 'stop using pågående arbeten, releasing an adjustment account no register verifikat touched'),
  'POST /api/bookkeeping/contract-revenue/contracts': gap('P3', 'add a pågående uppdrag with its figures on a balansdag'),
  'PUT /api/bookkeeping/contract-revenue/contracts/:id': gap('P3', 'state a pågående uppdrag\'s figures anew'),
  'DELETE /api/bookkeeping/contract-revenue/contracts/:id': gap('P3', 'remove a pågående uppdrag'),
  'POST /api/bookkeeping/contract-revenue/year': gap('P3', 'book the year\'s change in pågående arbeten on balansdagen'),

  // ── Accruals (periodiseringar) ─────────────────────────────────────
  'POST /api/bookkeeping/fiscal-periods/:id/accruals': covered(
    ['gnubok_propose_accruals', 'gnubok_create_voucher', `POST ${V}/journal-entries`],
    'proposal is read-only and an MCP tool only; posting goes through a generic voucher on either door',
  ),
  'POST /api/bookkeeping/accruals/:id/dissolve': gap('P3', 'dissolve an accrual schedule early'),
  'POST /api/bookkeeping/accruals/post-due': gap('P3', 'manual trigger of the daily accrual run (list via gnubok_list_accrual_schedules)'),
  'POST /api/bookkeeping/accruals/post-due/cron': machine(CRON),
  'POST /api/bookkeeping/finance-leases': gap('P3', 'register a finansiellt leasingavtal (K3 kapitel 20, behind NEXT_PUBLIC_FINANCE_LEASE_ENABLED), dashboard first'),
  'POST /api/bookkeeping/finance-leases/book': gap('P3', 'book the year of the finansiella leasingavtal (start and year-end adjustment), dashboard first'),
  'POST /api/bookkeeping/tax-loss-carryforwards': covered([`POST ${V}/tax-loss-carryforwards`, 'gnubok_save_tax_loss_carryforward']),
  // The year-end stock count (inventeringslista, LIV 1955:257), behind BOLAGET_COMPANY_IDS.
  'POST /api/bookkeeping/inventory-counts': covered(['gnubok_save_inventory_count'], 'served while BOLAGET_COMPANY_IDS is set'),
  'PUT /api/bookkeeping/inventory-counts/:id': covered(['gnubok_save_inventory_count'], 'served while BOLAGET_COMPANY_IDS is set'),
  'DELETE /api/bookkeeping/inventory-counts/:id': gap('P3', 'delete a draft stock count; a signed count is kept'),
  'POST /api/bookkeeping/inventory-counts/:id/sign': uiOnly(STOCK_COUNT_SIGNATURE),
  'POST /api/bookkeeping/inventory-counts/:id/bankid': uiOnly(STOCK_COUNT_SIGNATURE),
  'POST /api/bookkeeping/inventory-counts/:id/book': covered(['gnubok_book_inventory_count'], 'served while BOLAGET_COMPANY_IDS is set'),

  // ── Fiscal periods, year-end, årsredovisning ───────────────────────
  'POST /api/bookkeeping/fiscal-periods': covered([`POST ${V}/fiscal-periods`, 'gnubok_create_fiscal_period']),
  'PATCH /api/bookkeeping/fiscal-periods/:id': covered([`PATCH ${V}/fiscal-periods/:id`, 'gnubok_update_fiscal_period']),
  'DELETE /api/bookkeeping/fiscal-periods/:id': covered([`DELETE ${V}/fiscal-periods/:id`, 'gnubok_delete_fiscal_period']),
  'POST /api/bookkeeping/fiscal-periods/:id/lock': covered([`POST ${V}/fiscal-periods/:id/lock`, 'gnubok_lock_period']),
  'POST /api/bookkeeping/fiscal-periods/:id/unlock': covered([`POST ${V}/fiscal-periods/:id/unlock`, 'gnubok_unlock_period']),
  'POST /api/bookkeeping/fiscal-periods/:id/year-end': covered([`POST ${V}/fiscal-periods/:id/year-end`, 'gnubok_run_year_end']),
  'POST /api/bookkeeping/fiscal-periods/:id/close-external': covered([`POST ${V}/fiscal-periods/:id/close-external`, 'gnubok_close_fiscal_period_external']),
  'POST /api/bookkeeping/fiscal-periods/:id/reopen-external': covered([`POST ${V}/fiscal-periods/:id/reopen-external`, 'gnubok_reopen_fiscal_period_external']),
  'POST /api/bookkeeping/fiscal-periods/:id/reset': uiOnly('destructive owner-only fiscal year reset'),
  'POST /api/bookkeeping/currency-revaluation/monthly': gap('P2', 'month-end currency revaluation with its next-day storno (#523), a monthly close step where the company has switched it on; v1 and MCP revalue the balansdag only'),
  'POST /api/bookkeeping/fiscal-periods/:id/reopen': uiOnly('owner-only reopen of a year closed with a bokslut, on the owner\'s typed statement that the årsredovisning was not signed, adopted or filed'),
  'POST /api/bookkeeping/fiscal-periods/:id/opening-balance-review': covered(
    ['gnubok_acknowledge_opening_balance_review'],
    'staged; a person approves the agent\'s confirmation (crm#1967)',
  ),
  'POST /api/bookkeeping/fiscal-periods/:id/opening-balance-review/sie-file': covered(
    [`POST ${V}/fiscal-periods/:id/opening-balances/manual`, 'gnubok_set_opening_balances_manual'],
    'the API takes lines; reading them from the SIE import manifest stays UI-only',
  ),
  'POST /api/bookkeeping/fiscal-periods/:id/depreciation': covered(['gnubok_post_annual_depreciation']),
  'PUT /api/bookkeeping/fiscal-periods/:id/depreciation': gap('P3', 'save skattemässig (tax) depreciation choice'),
  'POST /api/bookkeeping/fiscal-periods/:id/bokslutsdispositioner': covered(
    ['gnubok_propose_dispositioner', 'gnubok_create_voucher', `POST ${V}/journal-entries`],
    'proposal is read-only and an MCP tool only; posting goes through a generic voucher on either door',
  ),
  'PUT /api/bookkeeping/fiscal-periods/:id/bokslutsdispositioner': gap('P3', 'save dispositioner adjustments'),
  'POST /api/bookkeeping/k3-transition': covered([`POST ${V}/k3-transition`, 'gnubok_start_k3_transition']),
  'PATCH /api/bookkeeping/k3-transition': covered([`PATCH ${V}/k3-transition`, 'gnubok_update_k3_transition']),
  'DELETE /api/bookkeeping/k3-transition': covered([`DELETE ${V}/k3-transition`, 'gnubok_delete_k3_transition']),
  'POST /api/bookkeeping/k3-transition/preview': covered([`POST ${V}/k3-transition/commit`, 'gnubok_commit_k3_transition'], 'the commit operation\'s dry run'),
  'POST /api/bookkeeping/k3-transition/commit': covered([`POST ${V}/k3-transition/commit`, 'gnubok_commit_k3_transition']),
  'PUT /api/assets/:id/transition-split': covered([`PUT ${V}/assets/:id/transition-split`, 'gnubok_split_asset_at_k3_transition']),
  'PUT /api/assets/:id/tax-plan': covered([`PUT ${V}/assets/:id/tax-plan`, 'gnubok_set_asset_tax_plan']),
  'PATCH /api/company/accounting-policies': covered([`PATCH ${V}/accounting-policies`, 'gnubok_set_development_model']),
  'PUT /api/bookkeeping/fiscal-periods/:id/deferred-tax': covered([`PUT ${V}/fiscal-periods/:id/deferred-tax`, 'gnubok_set_deferred_tax_inputs']),
  'PATCH /api/bookkeeping/fiscal-periods/:id/bokslut-checklist': gap('P3', 'tick a bokslut checklist item'),
  'PATCH /api/bookkeeping/fiscal-periods/:id/forenklat-arsbokslut': gap('P3', 'förenklat årsbokslut eligibility confirmation, notes and signatories; v1 and MCP read them (reports.forenklat-arsbokslut)'),
  'PATCH /api/bookkeeping/fiscal-periods/:id/arsredovisning/compliance': covered([`PATCH ${V}/fiscal-periods/:id/arsredovisning/compliance`, 'gnubok_update_arsredovisning_compliance']),
  'POST /api/bookkeeping/fiscal-periods/:id/arsredovisning/narrative': covered([`POST ${V}/fiscal-periods/:id/arsredovisning/narrative`, 'gnubok_update_arsredovisning_narrative']),
  'POST /api/bookkeeping/fiscal-periods/:id/arsredovisning/versions': covered([`POST ${V}/fiscal-periods/:id/arsredovisning/versions`, 'gnubok_create_arsredovisning_version']),
  'POST /api/bookkeeping/fiscal-periods/:id/arsredovisning/versions/:versionId/signing-request': covered([`POST ${V}/fiscal-periods/:id/arsredovisning/versions/:versionId/signing-request`, 'gnubok_request_arsredovisning_signatures'], 'the board signs in person with BankID; agents and API clients send the version'),
  'POST /api/bookkeeping/fiscal-periods/:id/arsredovisning/signatures': covered([`POST ${V}/fiscal-periods/:id/arsredovisning/signatures`, 'gnubok_add_arsredovisning_signature']),
  'PATCH /api/bookkeeping/fiscal-periods/:id/arsredovisning/signatures/:signatureId': covered([`PATCH ${V}/fiscal-periods/:id/arsredovisning/signatures/:signatureId`], 'v1 only: an agent never attests that a person signed'),
  'DELETE /api/bookkeeping/fiscal-periods/:id/arsredovisning/signatures/:signatureId': covered([`DELETE ${V}/fiscal-periods/:id/arsredovisning/signatures/:signatureId`]),
  'POST /api/bookkeeping/fiscal-periods/:id/arsredovisning/signatures/from-roles': covered(
    [`POST ${V}/fiscal-periods/:id/arsredovisning/signatures`, 'gnubok_add_arsredovisning_signature'],
    'the board and VD from Styrelse och firmateckning, added one by one through the same roster rules',
  ),
  // Bolaget registers (lib/operations/bolaget.ts).
  'POST /api/bolaget/share-register/events': covered([`POST ${V}/share-register/events`, 'gnubok_register_share_event']),
  // Taking the register into use: the same step as an entry sent with completes_setup.
  'POST /api/bolaget/share-register/setup': covered([`POST ${V}/share-register/events`, 'gnubok_register_share_event']),
  'POST /api/bolaget/share-classes': covered([`POST ${V}/share-classes`, 'gnubok_create_share_class']),
  'PATCH /api/bolaget/share-classes/:id': covered([`PATCH ${V}/share-classes/:id`, 'gnubok_update_share_class']),
  'POST /api/bolaget/roles': covered([`POST ${V}/company-roles`, 'gnubok_add_company_role']),
  'POST /api/bolaget/roles/:id/end': covered([`POST ${V}/company-roles/:id/end`, 'gnubok_end_company_role']),
  'POST /api/bolaget/signatory-rules': covered([`POST ${V}/signatory-rules`, 'gnubok_set_signatory_rule']),
  'POST /api/bolaget/beneficial-owners/assessments': covered([`POST ${V}/beneficial-owners/assessments`, 'gnubok_confirm_beneficial_owners']),
  'PATCH /api/bolaget/people/:partyId': uiOnly(
    'a holder\'s name, personnummer and postal address for the aktiebok (ABL 5:5): collected and corrected in the app only, never through an API key or an agent',
  ),
  'PATCH /api/bolaget/settings': uiOnly(
    'the avstämningsbolag status, stated once in the app: the central securities depository then keeps the aktiebok and this register takes no entries',
  ),
  // Bolaget capital events (lib/operations/bolaget-capital.ts).
  'POST /api/bolaget/capital/dividends': covered([`POST ${V}/dividends`, 'gnubok_create_dividend']),
  'POST /api/bolaget/capital/dividends/:id/book': covered([`POST ${V}/dividends/:id/book`, 'gnubok_book_dividend']),
  'POST /api/bolaget/capital/dividends/:id/pay': covered([`POST ${V}/dividends/:id/pay`, 'gnubok_pay_dividend']),
  'POST /api/bolaget/capital/dividends/:id/cancel': uiOnly(
    'withdraws a dividend the person recorded by mistake before anything is booked; an agent stages a new decision instead',
  ),
  'POST /api/bolaget/capital/dividends/ledger': uiOnly(
    'the one-time "who received" step for a dividend booked before the aktiebok existed: the recipients are people whose personnummer is collected in the app only',
  ),
  'PUT /api/bolaget/capital/ku31/:year': uiOnly(
    'the fåmansföretag answer (KU31 field 061 or 062) a person confirms for the year, and the KU31 contact person',
  ),
  'POST /api/bolaget/capital/contributions': covered([`POST ${V}/shareholder-contributions`, 'gnubok_create_shareholder_contribution']),
  'POST /api/bolaget/capital/changes': covered([`POST ${V}/capital-changes`, 'gnubok_create_capital_change']),
  'POST /api/bolaget/capital/changes/:id/book': covered([`POST ${V}/capital-changes/:id/book`, 'gnubok_book_capital_change']),
  // Bolaget owner tax: K10 underlag, owner loans, KU20 (lib/operations/bolaget-owner-tax.ts).
  'PUT /api/bolaget/owner-tax/k10/:year/owners/:partyId': covered([`PUT ${V}/k10/:year/owners/:partyId`, 'gnubok_set_k10_owner_inputs']),
  'POST /api/bolaget/owner-tax/loans': covered([`POST ${V}/owner-loans`, 'gnubok_create_owner_loan']),
  'PATCH /api/bolaget/owner-tax/loans/:id': covered([`PATCH ${V}/owner-loans/:id`, 'gnubok_update_owner_loan']),
  'POST /api/bolaget/owner-tax/loans/:id/interest': covered([`POST ${V}/owner-loans/:id/interest`, 'gnubok_set_owner_loan_interest']),
  // Bolaget meetings and minutes (lib/operations/corporate-meetings.ts).
  'POST /api/bolaget/meetings': covered([`POST ${V}/corporate-meetings`, 'gnubok_create_corporate_meeting']),
  'PATCH /api/bolaget/meetings/:id': covered([`PATCH ${V}/corporate-meetings/:id`, 'gnubok_update_corporate_meeting']),
  'DELETE /api/bolaget/meetings/:id': uiOnly('deleting a draft meeting is a person\'s call in the app; held and signed minutes are never deleted'),
  'POST /api/bolaget/meetings/:id/decisions': covered([`POST ${V}/corporate-meetings/:id/decisions`, 'gnubok_record_corporate_decision']),
  'DELETE /api/bolaget/meetings/:id/decisions/:decisionId': uiOnly(
    'removing a paragraph from unsigned minutes in the app; an agent changes it or records it as bordlagd through POST /corporate-meetings/{id}/decisions',
  ),
  'POST /api/bolaget/meetings/:id/hold': covered([`POST ${V}/corporate-meetings/:id/hold`, 'gnubok_hold_corporate_meeting']),
  'POST /api/bolaget/meetings/:id/sign': uiOnly(
    'a person attests that the minutes were signed on paper and uploads the signed copy; an agent never attests a signature',
  ),
  'POST /api/bolaget/meetings/:id/bankid': uiOnly(
    'sending the minutes for BankID signing: each signer signs in person (the machine door for any archived PDF is POST /signing-requests)',
  ),
  'POST /api/bookkeeping/proposal-preview': uiOnly('preview of an unsaved booking proposal (read-only, POST for its body); agents get the same lines from the categorize dry run'),

  // ── Budgets (accounted#134) ────────────────────────────────────────
  'POST /api/budgets': covered([`POST ${V}/budgets`, 'gnubok_create_budget']),
  'PATCH /api/budgets/:id': covered([`PATCH ${V}/budgets/:id`, 'gnubok_update_budget']),
  'DELETE /api/budgets/:id': covered([`DELETE ${V}/budgets/:id`, 'gnubok_delete_budget']),
  'POST /api/budgets/:id/lines': covered([`POST ${V}/budgets/:id/lines`, 'gnubok_upsert_budget_lines']),
  'POST /api/budgets/:id/spread': covered([`POST ${V}/budgets/:id/spread`, 'gnubok_spread_budget']),
  'POST /api/budgets/:id/copy-actuals': covered([`POST ${V}/budgets/:id/copy-actuals`, 'gnubok_copy_actuals_to_budget']),
  'POST /api/budgets/:id/import': covered([`POST ${V}/budgets/:id/import`], 'v1 only: the file would be the staged params; an agent writes cells with gnubok_upsert_budget_lines'),
  'POST /api/budgets/:id/import/preview': covered([`POST ${V}/budgets/:id/import`], 'the v1 import\'s dry run'),

  // ── Dimensions ─────────────────────────────────────────────────────
  'POST /api/dimensions': covered([`POST ${V}/dimensions`, 'gnubok_create_dimension']),
  'PATCH /api/dimensions/:id': covered([`PATCH ${V}/dimensions/:id`, 'gnubok_update_dimension']),
  'DELETE /api/dimensions/:id': covered([`DELETE ${V}/dimensions/:id`, 'gnubok_delete_dimension']),
  'POST /api/dimensions/:id/values': covered([`POST ${V}/dimensions/:id/values`, 'gnubok_create_dimension_value']),
  'PATCH /api/dimensions/:id/values/:valueId': covered([`PATCH ${V}/dimensions/:id/values/:valueId`]),
  'DELETE /api/dimensions/:id/values/:valueId': covered([`DELETE ${V}/dimensions/:id/values/:valueId`]),
  'POST /api/dimensions/rules': covered([`POST ${V}/dimensions/rules`, 'gnubok_create_dimension_rule']),
  'PATCH /api/dimensions/rules/:id': covered([`PATCH ${V}/dimensions/rules/:id`, 'gnubok_update_dimension_rule']),
  'DELETE /api/dimensions/rules/:id': covered([`DELETE ${V}/dimensions/rules/:id`, 'gnubok_delete_dimension_rule']),
  'POST /api/dimensions/import-existing': covered(
    [`PATCH ${V}/settings`, 'gnubok_update_company_settings'],
    'runs when dimensions_enabled turns on (lib/company/settings-service.ts); turning it off and on again re-runs it',
  ),
  'POST /api/dimensions/tagging/apply': covered([`POST ${V}/dimensions/retag`, 'gnubok_tag_journal_lines']),

  // ── Bank transactions ──────────────────────────────────────────────
  'POST /api/transactions': covered([`POST ${V}/transactions/ingest`, 'gnubok_create_transactions']),
  'PATCH /api/transactions/:id': covered([`PATCH ${V}/transactions/:id`]),
  'DELETE /api/transactions/:id': covered([`DELETE ${V}/transactions/:id`]),
  'PATCH /api/transactions/:id/cash-account': covered([`PATCH ${V}/transactions/:id`], 'the account_number field'),
  'POST /api/transactions/:id/book': covered([`POST ${V}/transactions/bulk-book`, 'gnubok_bulk_book_transactions'], 'book one transaction with explicit lines as a batch of one'),
  'POST /api/transactions/:id/categorize': covered([`POST ${V}/transactions/:id/categorize`, 'gnubok_categorize_transaction']),
  'POST /api/transactions/:id/uncategorize': covered([`POST ${V}/transactions/:id/uncategorize`, 'gnubok_uncategorize_transaction']),
  'POST /api/transactions/:id/ignore': covered([`POST ${V}/transactions/:id/ignore`, 'gnubok_ignore_transaction']),
  'DELETE /api/transactions/:id/ignore': covered([`DELETE ${V}/transactions/:id/ignore`, 'gnubok_ignore_transaction'], 'the tool restores with restore: true'),
  'POST /api/transactions/:id/attach-document': covered([`POST ${V}/transactions/:id/attach-document`, 'gnubok_attach_document_to_transaction']),
  'DELETE /api/transactions/:id/attach-document': covered([`POST ${V}/transactions/:id/detach-document`, 'gnubok_detach_document_from_transaction']),
  'POST /api/transactions/:id/link-journal-entry': covered([`POST ${V}/transactions/:id/link-journal-entry`, 'gnubok_link_transaction_to_journal_entry']),
  'POST /api/transactions/:id/match-batch': covered([`POST ${V}/transactions/:id/match-batch`, 'gnubok_match_batch_allocate']),
  'POST /api/transactions/:id/match-invoice': covered([`POST ${V}/transactions/:id/match-invoice`, 'gnubok_match_transaction_to_invoice']),
  'POST /api/transactions/:id/match-supplier-invoice': covered([`POST ${V}/transactions/:id/match-supplier-invoice`]),
  'POST /api/transactions/:id/match-expense-payout': covered([`POST ${V}/transactions/:id/match-expense-payout`, 'gnubok_match_expense_payout']),
  'POST /api/transactions/:id/match-rot-rut-payout': covered(['gnubok_settle_rot_rut_payout']),
  'POST /api/transactions/:id/refresh-exchange-rate': covered([`POST ${V}/transactions/:id/refresh-exchange-rate`]),
  'POST /api/transactions/bulk-book': covered([`POST ${V}/transactions/bulk-book`, 'gnubok_bulk_book_transactions']),
  'POST /api/transactions/previous-system': covered(
    ['gnubok_bulk_ignore_transactions'],
    'the tool ignores the unbooked rows of one cash account before a date the agent names; the dashboard takes the date from the SIE import (crm#1954)',
  ),
  'POST /api/transactions/suggest-categories': covered(['gnubok_suggest_categories']),

  // ── Cash accounts ──────────────────────────────────────────────────
  'POST /api/cash-accounts': covered([`POST ${V}/cash-accounts`, 'gnubok_create_cash_account']),
  'PATCH /api/cash-accounts/:id': covered([`PATCH ${V}/cash-accounts/:id`, 'gnubok_update_cash_account'], 'the ledger account is not editable on any door'),
  'DELETE /api/cash-accounts/:id': gap('P3', 'removing a wrongly synced, unbooked bank account (#3130) deletes bank rows; whether an API key or agent may do that is a product call, so it ships dashboard-only'),
  'POST /api/cash-accounts/:id/archive': gap('P3', 'archiving a mistakenly connected bank account (PH 222) hides its open rows; like removal it ships dashboard-only until it is decided whether an API key or agent may do that'),
  'POST /api/cash-accounts/:id/primary': covered([`POST ${V}/cash-accounts/:id/set-primary`, 'gnubok_set_primary_cash_account']),
  'PUT /api/cash-accounts/payee-defaults': covered([`PUT ${V}/cash-accounts/payee-defaults`, 'gnubok_set_invoice_payee_default']),

  // ── Reconciliation ─────────────────────────────────────────────────
  'POST /api/reconciliation/bank/run': covered([`POST ${V}/reconciliation/bank/run`]),
  'POST /api/reconciliation/bank/link': covered([`POST ${V}/transactions/:id/link-journal-entry`, `POST ${V}/reconciliation/accounts/:accountKey/links`, 'gnubok_link_transaction_to_journal_entry', 'gnubok_reconcile_match']),
  'POST /api/reconciliation/bank/confirm-suggestions': covered([`POST ${V}/reconciliation/accounts/:accountKey/links`, 'gnubok_reconcile_match'], 'use_proposals; bulk reject has no API'),
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
  'POST /api/documents/uploads': covered([`POST ${V}/documents`, 'gnubok_create_document_upload'], 'v1 uploads in one multipart call, without the reserved URL'),
  'DELETE /api/documents/:id': covered([`DELETE ${V}/documents/:id`, 'gnubok_delete_document']),
  'POST /api/documents/:id/link': covered([`POST ${V}/documents/:id/link`, 'gnubok_link_document_to_voucher']),
  'POST /api/documents/:id/detach': gap('P3', 'detach a duplicate underlag from a posted verifikat'),
  'POST /api/documents/:id/versions': gap('P3', 'new version of a document'),
  'POST /api/documents/:id/admission': gap('P3', 'admit or discard a held document'),
  'POST /api/documents/:id/classification': covered([`PUT ${V}/documents/:id/type`, 'gnubok_set_document_type']),
  'POST /api/documents/:id/extraction/fields': gap('P3', 'settle extracted fields on an archive document'),
  'POST /api/arkiv/facts/:id/revert': gap('P3', 'revert a company fact (gnubok_propose_fact stages new ones)'),
  'POST /api/arkiv/findings/:id': gap('P3', 'close an Arkiv finding'),

  // ── Imports ────────────────────────────────────────────────────────
  'POST /api/import/sie/parse': covered(['gnubok_sie_preflight']),
  // The append preview (issue #108): the MCP preflight and staging carry the
  // same plan; v1 refuses at submit with the same verdicts.
  'POST /api/import/sie/append-plan': covered(['gnubok_sie_preflight', 'gnubok_import_sie', `POST ${V}/imports/sie`]),
  'POST /api/import/sie/upload': covered([`POST ${V}/imports/sie/upload`, 'gnubok_create_sie_upload']),
  'POST /api/import/sie/execute': covered([`POST ${V}/imports/sie`, 'gnubok_import_sie']),
  'POST /api/import/sie/create-accounts': covered(['gnubok_import_sie'], 'the API import creates missing accounts itself'),
  'POST /api/import/sie/:id/action': covered([`POST ${V}/imports/sie/:id/undo`, `POST ${V}/imports/sie/:id/resume`]),
  'POST /api/import/sie/:id/replace': covered([`POST ${V}/imports/sie/:id/undo`], 'compat route: queues the same batch storno'),
  'DELETE /api/import/sie/:id': gap('P3', 'delete a failed/pending SIE import record'),
  'DELETE /api/import/sie/:id/undo': covered([`POST ${V}/imports/sie/:id/undo`, 'gnubok_undo_sie_import']),
  'POST /api/import/bank-file/parse': uiOnly(PREVIEW),
  'POST /api/import/bank-file/check-duplicates': uiOnly(PREVIEW),
  'POST /api/import/bank-file/execute': covered([`POST ${V}/imports/bank`]),
  'POST /api/import/bank-file/deposit-specification': covered([`POST ${V}/imports/deposit-specification`], 'v1 takes the whole file; no MCP tool (would stage file bytes)'),
  'DELETE /api/import/bank-file/:id/undo': covered([`POST ${V}/imports/bank/:id/undo`, 'gnubok_undo_bank_import']),
  'POST /api/import/skattekonto-file/parse': uiOnly(PREVIEW),
  'POST /api/import/skattekonto-file/execute': covered([`POST ${V}/imports/skattekonto-file`], 'v1 takes the whole file; no MCP tool (would stage file bytes)'),
  'POST /api/import/customers/parse': uiOnly(PREVIEW),
  'POST /api/import/customers/execute': covered([`POST ${V}/customers/bulk-create`, 'gnubok_create_customer'], 'the tool takes one customer per call'),
  'POST /api/import/suppliers/parse': uiOnly(PREVIEW),
  'POST /api/import/suppliers/execute': covered([`POST ${V}/suppliers/bulk-create`, 'gnubok_create_supplier'], 'the tool takes one supplier per call'),
  'POST /api/import/articles/parse': uiOnly(PREVIEW),
  'POST /api/import/articles/match': uiOnly(PREVIEW),
  'POST /api/import/articles/execute': covered(['gnubok_create_article'], 'one article per call, no bulk'),
  'DELETE /api/import/registers/:id/undo': gap('P3', 'undo a dashboard customer/supplier/article import; v1 bulk-create records no run to undo'),
  'POST /api/import/documents/preview': uiOnly(PREVIEW),
  'POST /api/import/documents/attach': covered([`POST ${V}/documents`, `POST ${V}/documents/:id/link`, 'gnubok_upload_document', 'gnubok_link_documents_to_vouchers']),
  'POST /api/import/opening-balance/parse': uiOnly(PREVIEW),
  'POST /api/import/opening-balance/execute': covered([`POST ${V}/fiscal-periods/:id/opening-balances/manual`, 'gnubok_set_opening_balances_manual'], 'the spreadsheet parse stays UI-only; the API takes lines'),
  'POST /api/import/opening-balance/correct': covered([`POST ${V}/fiscal-periods/:id/opening-balances/correct`, 'gnubok_correct_opening_balances']),
  'POST /api/import/opening-balance/correct-inline': covered([`POST ${V}/journal-entries/:id/strike-lines`, 'gnubok_correct_entry_lines'], 'no cascade to later years'),
  'POST /api/import/opening-balance/split-per-project': covered([`POST ${V}/fiscal-periods/:id/opening-balances/split-per-project`, 'gnubok_split_opening_balances_per_project']),

  // ── Customers, articles, sales ─────────────────────────────────────
  'POST /api/customers': covered([`POST ${V}/customers`, 'gnubok_create_customer']),
  'PATCH /api/customers/:id': covered([`PATCH ${V}/customers/:id`, 'gnubok_update_customer']),
  'POST /api/customers/merge': covered([`POST ${V}/customers/merge`, 'gnubok_merge_customers']),
  'POST /api/customers/merge/undo': covered([`POST ${V}/customers/merges/:mergeId/undo`]),
  'DELETE /api/customers/:id': covered([`DELETE ${V}/customers/:id`]),
  'PATCH /api/customers/:id/collections-exclusion': gap(
    'P3',
    '"Skicka aldrig till inkasso" on a customer; served only while collections is offered, joins PATCH /api/v1/customers/:id when collections leaves the dark launch',
  ),
  'PATCH /api/customers/:id/reminders-exclusion': gap(
    'P3',
    '"Skicka aldrig påminnelser" on a customer; joins PATCH /api/v1/customers/:id when reminders leave the dark launch (accounted#104)',
  ),
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
  'POST /api/invoices/:id/finalize': gap('P3', 'number a draft without sending it; over v1 and MCP the number is allocated when the invoice is sent or marked sent'),
  'POST /api/invoices/:id/book': covered([`POST ${V}/invoices/:id/book`, 'gnubok_book_invoice']),
  'POST /api/invoices/bulk-book': covered([`POST ${V}/invoices/bulk-book`, 'gnubok_bulk_book_invoices']),
  'POST /api/invoices/:id/send': covered([`POST ${V}/invoices/:id/send`, 'gnubok_send_invoice']),
  'POST /api/invoices/:id/attachments': covered(
    [`POST ${V}/invoices/:id/send`, 'gnubok_send_invoice'],
    'attachment_document_ids attaches at send time',
  ),
  'DELETE /api/invoices/:id/attachments/:documentId': gap('P3', 'take a file off a draft before it is sent'),
  'POST /api/invoices/:id/underlag': covered([`POST ${V}/invoices/:id/underlag`, 'gnubok_attach_invoice_underlag']),
  'DELETE /api/invoices/:id/underlag/:documentId': covered([
    `DELETE ${V}/invoices/:id/underlag/:documentId`,
    'gnubok_detach_invoice_underlag',
  ]),
  'POST /api/invoices/:id/mark-sent': covered([`POST ${V}/invoices/:id/mark-sent`, 'gnubok_mark_invoice_as_sent']),
  'POST /api/invoices/:id/mark-paid': covered([`POST ${V}/invoices/:id/mark-paid`, 'gnubok_mark_invoice_as_paid']),
  'POST /api/invoices/:id/link-to-voucher': covered(['gnubok_link_invoice_to_voucher']),
  'POST /api/invoices/:id/quote-status': covered([`POST ${V}/invoices/:id/quote-status`, 'gnubok_set_quote_status']),
  'POST /api/invoices/:id/cancel': covered([`POST ${V}/invoices/:id/cancel`, 'gnubok_cancel_quote_or_proforma']),
  'POST /api/invoices/:id/convert': covered(['gnubok_convert_invoice']),
  'POST /api/invoices/:id/convert-to-order': covered(['gnubok_convert_invoice'], 'target order'),
  'POST /api/invoices/:id/peppol': covered([`POST ${V}/invoices/:id/send-peppol`, 'gnubok_send_invoice_peppol'], 'staging alone has no door; send stages first'),
  'POST /api/invoices/:id/peppol/send': covered([`POST ${V}/invoices/:id/send-peppol`, 'gnubok_send_invoice_peppol']),
  'POST /api/invoices/:id/customer-loss': covered(
    ['gnubok_record_customer_loss'],
    'served while CUSTOMER_LOSS_ENABLED is set',
  ),
  'POST /api/invoices/:id/digital-mailbox/send': covered(['gnubok_send_invoice'], 'channel kivra or billo; no v1 route'),
  // Digital mailboxes (Kivra, Billo): connecting the company's own mailbox
  // and the company as a sender. Billo's mailbox needs the admin's BankID
  // personnummer, read from their login, which an API key has no login for.
  'POST /api/digital-mailboxes/:provider/receive': gap('P3', 'connect a Kivra or Billo mailbox to the Inkorg'),
  'DELETE /api/digital-mailboxes/:provider/receive': gap('P3', 'disconnect a Kivra or Billo mailbox'),
  'POST /api/digital-mailboxes/:provider/send': gap('P3', 'activate sending through Kivra or Billo'),
  'DELETE /api/digital-mailboxes/:provider/send': gap('P3', 'stop sending through Kivra or Billo'),
  'POST /api/digital-mailboxes/:provider/sync': gap('P3', 'read a connected mailbox now; the cron reads it every 10 minutes'),
  'POST /api/parties/:id/setoffs': covered(
    [`POST ${V}/setoffs`, 'gnubok_book_counterparty_setoff'],
    'served while COUNTERPARTY_SETOFF_ENABLED is set',
  ),
  'POST /api/invoices/:id/collection': covered(
    ['POST /api/v1/companies/:companyId/invoices/:id/collection', 'gnubok_send_invoice_to_collection'],
    'served while collections is switched on; attestations (no delivery record, an import, a customer answer, an unsynced bank) are a person\'s in the browser, and only a person approves the staged handover (REST: stage=true only, STAGE_REQUIRED otherwise)',
  ),
  'POST /api/invoices/:id/collection/actions': covered(
    ['POST /api/v1/companies/:companyId/invoices/:id/collection/actions', 'gnubok_collection_case_action'],
    'served while collections is switched on; escalations are approved by a person in the browser (REST: stage=true only for them, STAGE_REQUIRED otherwise)',
  ),
  'POST /api/invoices/:id/collection/forwards': gap(
    'P3',
    'retry a payment report the collections provider did not take, or mark a partly ignored one as handled',
  ),
  'POST /api/collections/settlements/:id/book': covered(
    ['POST /api/v1/companies/:companyId/collections/settlements/:settlementId/book', 'gnubok_book_collection_settlement'],
    "served while collections is switched on; the staged booking pins the payout's lines and amount, and a possible duplicate stays a person's answer",
  ),
  'POST /api/collections/settlements/:id/duplicate': gap(
    'P2',
    'answer a payout held as a possible duplicate: book it, or mark it handled elsewhere with a reason',
  ),
  'POST /api/collections/payments/:id/book': covered(
    ['POST /api/v1/companies/:companyId/collections/payments/:paymentId/book', 'gnubok_book_collected_payment'],
    'served while collections is switched on',
  ),
  'POST /api/collections/payments/:id/rebook': gap(
    'P2',
    'storno and book again a payment the debtor made to the collections provider (the sanctioned correction)',
  ),
  'POST /api/invoices/:id/collection/possible-payments': gap(
    'P3',
    'say that a bank row the collections sweep found pays something else (booking the row answers it too)',
  ),
  'POST /api/invoices/:id/refresh-exchange-rate': gap('P3'),
  'POST /api/invoices/:id/send-payment-confirmation': gap('P3', 'email a betalningsbekräftelse'),
  'POST /api/invoices/:id/resend': gap('P3', 'email an already emailed invoice again as a copy (crm#1339)'),
  'POST /api/invoices/self-billed': covered([`POST ${V}/invoices`], 'is_self_billed: true runs the same service (createSelfBilledSaleInvoice); gnubok_create_invoice has no such argument'),
  'POST /api/invoices/preview-pdf': uiOnly(PREVIEW),
  'POST /api/invoices/preview-email': uiOnly(PREVIEW),
  'POST /api/invoices/recurring': covered(['gnubok_create_recurring_schedule']),
  'PATCH /api/invoices/recurring/:id': covered(['gnubok_update_recurring_schedule']),
  'DELETE /api/invoices/recurring/:id': gap('P3', 'delete a schedule (pause is covered by gnubok_update_recurring_schedule)'),
  'POST /api/invoices/recurring/:id/run': gap('P3', 'run a schedule now'),
  'POST /api/invoices/recurring/cron': machine(CRON),
  // Autogiro v1 (pilot, AUTOGIRO_COMPANY_IDS): the dashboard first; the
  // operations for v1 and MCP follow once a real debit has run.
  'PUT /api/invoices/autogiro/settings': gap('P2', 'Autogiro agreement (Bankgirot Kundnummer and bankgiro)'),
  'POST /api/invoices/autogiro/mandates': gap('P2', 'register an existing Autogiro mandate on a customer'),
  'PATCH /api/invoices/autogiro/mandates/:id': gap('P2', 'link an Autogiro payer number to a customer'),
  'POST /api/invoices/autogiro/mandates/:id/cancel': gap('P2', 'cancel an Autogiro mandate (file for the bank)'),
  'POST /api/invoices/autogiro/debit-files': gap('P2', 'write the Autogiro payment file for due invoices'),
  'POST /api/invoices/autogiro/debit-files/:id/withdraw': gap('P2', 'withdraw an Autogiro payment file not yet reported'),
  'POST /api/invoices/autogiro/reports': gap('P2', 'read a Bankgirot Autogiro report (payments, mandates)'),
  'POST /api/invoices/autogiro/settle': gap('P2', 'settle Autogiro debits from the bank deposit without a report'),
  'POST /api/invoices/reminders/action': machine('machine endpoint: public token link for the invoice recipient'),
  'POST /api/reminders/automatic': uiOnly(
    'a person lets the daily reminder batch send itself after three clean batches; no machine door changes who approves reminders (accounted#104)',
  ),
  'POST /api/reminders/send': uiOnly(
    'a person picks which customers get a reminder email now, with the bank check shown; no machine door sends reminders (accounted#104)',
  ),

  // ── Suppliers and supplier invoices ────────────────────────────────
  'POST /api/suppliers': covered([`POST ${V}/suppliers`, 'gnubok_create_supplier']),
  'PUT /api/suppliers/:id': covered([`PATCH ${V}/suppliers/:id`, 'gnubok_update_supplier']),
  'DELETE /api/suppliers/:id': covered([`DELETE ${V}/suppliers/:id`, 'gnubok_archive_supplier']),
  'POST /api/supplier-invoices': covered([`POST ${V}/supplier-invoices`, 'gnubok_create_supplier_invoice_from_inbox']),
  'PUT /api/supplier-invoices/:id': covered([`PATCH ${V}/supplier-invoices/:id`, 'gnubok_update_supplier_invoice']),
  'DELETE /api/supplier-invoices/:id': covered([`DELETE ${V}/supplier-invoices/:id`, 'gnubok_delete_supplier_invoice']),
  'POST /api/supplier-invoices/:id/approve': covered([`POST ${V}/supplier-invoices/:id/approve`, 'gnubok_approve_supplier_invoice']),
  'POST /api/supplier-invoices/:id/reject': covered([`POST ${V}/supplier-invoices/:id/reject`]),
  'PUT /api/supplier-invoices/attest-policy': covered([`PUT ${V}/supplier-invoices/attest-policy`], 'owners and admins; no MCP tool: who controls payments is a person\'s decision'),
  'PUT /api/supplier-invoices/attest-policy/mail': uiOnly(PREFS),
  'POST /api/supplier-invoices/attest-policy/substitutes': covered([`POST ${V}/supplier-invoices/attest-substitutes`], 'no MCP tool: who may release a payment is a person\'s decision'),
  'DELETE /api/supplier-invoices/attest-policy/substitutes/:id': covered([`DELETE ${V}/supplier-invoices/attest-substitutes/:id`], 'no MCP tool: who may release a payment is a person\'s decision'),
  'POST /api/attest/:token/decision': uiOnly(ATTEST_LINK),
  'POST /api/attest/lista/:token/decisions': uiOnly(ATTEST_LIST_LINK),
  'POST /api/supplier-invoices/:id/book': covered([`POST ${V}/supplier-invoices/:id/book`, 'gnubok_book_supplier_invoice']),
  'POST /api/supplier-invoices/:id/mark-paid': covered([`POST ${V}/supplier-invoices/:id/mark-paid`]),
  'POST /api/supplier-invoices/:id/credit': covered([`POST ${V}/supplier-invoices/:id/credit`, 'gnubok_credit_supplier_invoice']),
  'POST /api/supplier-invoices/:id/uncredit': covered([`POST ${V}/supplier-invoices/:id/uncredit`, 'gnubok_uncredit_supplier_invoice']),
  'POST /api/supplier-invoices/:id/link-to-voucher': covered(['gnubok_link_supplier_invoice_to_voucher']),
  'POST /api/supplier-invoices/:id/unlink-voucher': gap('P2', 'the undo of a voucher link is dashboard-only so far: no v1 route and no MCP tool; the rules sit in unlink_supplier_invoice_from_voucher, so a door only has to call unlinkSupplierInvoiceFromVoucher'),
  'POST /api/supplier-invoices/:id/bank-entered': covered([`POST ${V}/supplier-invoices/:id/bank-entered`]),
  'POST /api/supplier-invoices/:id/payee': covered(['gnubok_confirm_supplier_payee'], 'an agent stages the approval of new bank details, a person approves it in the web UI; rejecting is the person\'s own act there, and neither has a v1 door (a person vouches for the account)'),
  'PATCH /api/supplier-invoices/:id/items/:itemId': covered([`PATCH ${V}/supplier-invoices/:id/items/:itemId`, 'gnubok_update_supplier_invoice_item_account']),
  'POST /api/supplier-invoices/payment-batches': covered([`POST ${V}/supplier-payment-batches`, 'gnubok_create_supplier_payment_batch']),
  'POST /api/supplier-invoices/payment-batches/:id/cancel': covered([`POST ${V}/supplier-payment-batches/:id/cancel`, 'gnubok_cancel_supplier_payment_batch']),
  'POST /api/supplier-invoices/payment-batches/preview': covered([`POST ${V}/supplier-payment-batches/preview`, 'gnubok_preview_supplier_payment_batch']),

  // ── Bank payments (payment initiation, lib/payments/orders) ─────────
  'POST /api/payments/orders': covered([`POST ${V}/payment-orders`, 'gnubok_prepare_payments'], 'an agent prepares drafts; a person approves and signs'),
  'POST /api/payments/orders/approve': covered([`POST ${V}/payment-orders/approve`], 'attestation is a person\'s act: v1 only (an API key is a person\'s tool), no MCP tool'),
  'POST /api/payments/orders/unapprove': covered([`POST ${V}/payment-orders/unapprove`]),
  'POST /api/payments/orders/:id/cancel': covered([`POST ${V}/payment-orders/:id/cancel`, 'gnubok_cancel_payment_order']),
  'POST /api/payments/orders/skattekonto': covered([`POST ${V}/payment-orders`, 'gnubok_prepare_payments'], 'payment-orders.prepare with skattekonto: the same service (prepare-skattekonto.ts); approving and signing are the supplier payments\' doors'),
  'POST /api/payments/orders/:id/resolve': uiOnly('a person attests what the bank cannot tell (a payment that never reached the bank, or one paid): never an agent'),
  'POST /api/payments/signing': uiOnly(PAYMENT_SIGNING),
  'POST /api/payments/signing/:id/poll': uiOnly(PAYMENT_SIGNING),
  'POST /api/payments/signing/:id/restart': uiOnly(PAYMENT_SIGNING),
  'POST /api/payments/signing/:id/second-signature': uiOnly(PAYMENT_SIGNING),
  'POST /api/payments/allowance-requests': uiOnly('asking the operators for more included bank payments a month: a support request from a person, answered by hand'),
  'POST /api/payments/verification': covered([`POST ${V}/payment-orders/verification/start`], 'answers the provider\'s know-your-customer form link, which a signatory fills in and signs'),
  'POST /api/payments/orders/status/cron': machine(CRON),
  'POST /api/payments/signing-links': covered([`POST ${V}/payments/signing-links`, 'gnubok_request_payment_signature'], 'agents and API clients request the link; the firmatecknare still signs in person with BankID'),
  'DELETE /api/payments/signing-links/:id': gap('P3', 'cancel an open payment signing link (Avbryt länken on Betalningar)'),

  // ── The payment signing link (lib/payments/orders/signing-links): token routes a firmatecknare reaches without a login ──
  'POST /api/betala/:token/signing': uiOnly(PAYMENT_SIGNING_LINK),
  'POST /api/betala/:token/signing/:id/poll': uiOnly(PAYMENT_SIGNING_LINK),
  'POST /api/betala/:token/signing/:id/restart': uiOnly(PAYMENT_SIGNING_LINK),
  // BankID document signing (lib/signing): agents and API clients request,
  // chase and cancel; each signer still signs in person with BankID.
  // Commitments and holdings (Bolaget): the same services as lib/operations/commitments.ts.
  'POST /api/commitments/agreements': covered([`POST ${V}/agreements`, 'gnubok_create_agreement']),
  'PATCH /api/commitments/agreements/:id': covered([`PATCH ${V}/agreements/:id`, 'gnubok_update_agreement']),
  'POST /api/commitments/agreements/:id/end': covered([`POST ${V}/agreements/:id/end`, 'gnubok_end_agreement']),
  'POST /api/commitments/securities': covered([`POST ${V}/securities`, 'gnubok_create_security']),
  'PATCH /api/commitments/securities/:id': covered([`PATCH ${V}/securities/:id`, 'gnubok_update_security']),
  'POST /api/commitments/group-links': covered([`POST ${V}/group-links`, 'gnubok_create_group_link']),
  'PATCH /api/commitments/group-links/:id': covered([`PATCH ${V}/group-links/:id`, 'gnubok_update_group_link']),
  'POST /api/signing-requests': covered([`POST ${V}/signing-requests`, 'gnubok_request_signature']),
  'POST /api/signing-requests/:id/cancel': covered([`POST ${V}/signing-requests/:id/cancel`]),
  'POST /api/signing-requests/:id/signers/:signerId/remind': covered([`POST ${V}/signing-requests/:id/signers/:signerId/remind`, 'gnubok_remind_signer']),
  'POST /api/signera/:token/start': uiOnly(SIGNING_CEREMONY),
  'POST /api/signera/:token/poll': uiOnly(SIGNING_CEREMONY),
  'POST /api/signera/:token/cancel': uiOnly(SIGNING_CEREMONY),
  'POST /api/signera/:token/decline': uiOnly(SIGNING_CEREMONY),
  'POST /api/signing/me/:signerId/start': uiOnly(SIGNING_CEREMONY),
  'POST /api/signing/me/:signerId/poll': uiOnly(SIGNING_CEREMONY),
  'POST /api/signing/me/:signerId/cancel': uiOnly(SIGNING_CEREMONY),
  'POST /api/signing/me/:signerId/decline': uiOnly(SIGNING_CEREMONY),
  // The public check of a signed file (/verifiera): a read by hash for anyone holding the file, nothing it changes.
  'POST /api/verifiera': uiOnly('public check of a signed file by its SHA-256 (/verifiera): it reads what the copy itself prints and changes nothing, so no machine door needs it'),

  // ── Bank connections through Open Payments (lib/bank-feed) ──────────
  'POST /api/bank/open-payments/connections': uiOnly(BANK_CONSENT),
  'POST /api/bank/open-payments/connections/:id/poll': uiOnly(BANK_CONSENT),
  'POST /api/bank/open-payments/connections/:id/restart': uiOnly(BANK_CONSENT),
  'POST /api/bank/open-payments/connections/:id/select': gap('P3', 'choose which accounts sync after the consent and start the first import, as for Enable Banking; their ledger accounts have a door (POST /cash-accounts/change-ledgers, gnubok_change_bank_ledgers). Svea: also signs the second consent, which stays a person\'s act'),
  'POST /api/bank/open-payments/connections/:id/sync': covered([`POST ${V}/bank-connections/:connectionId/sync`, 'gnubok_sync_bank'], 'both doors fall through to the Open Payments runner for its connections'),
  'DELETE /api/bank/open-payments/connections/:id': gap('P3', 'remove a bank connection, as for Enable Banking'),
  'PATCH /api/bank/connections/:id/ledgers': covered([`POST ${V}/cash-accounts/change-ledgers`, 'gnubok_change_bank_ledgers'], 'named by cash_account_id instead of the connection account uid (crm#1663)'),
  'POST /api/clients/bank-switch/remind': uiOnly('a byrå mails its own clients about the one-off Enable Banking to Open Payments switch; the campaign ends with the deadline'),
  'POST /api/bank/open-payments/invites': covered([`POST ${V}/bank-feed/invites`, 'gnubok_bank_feed_connect_link'], 'the signatory link (operation bank-feed.invite): the firmatecknare still signs the consent in person'),

  // ── The signatory link (lib/bank-feed/invites): token routes a firmatecknare reaches without a login ──
  'POST /api/koppla/:token/connections': uiOnly(SIGNATORY_LINK),
  'POST /api/koppla/:token/connections/:id/poll': uiOnly(SIGNATORY_LINK),
  'POST /api/koppla/:token/connections/:id/restart': uiOnly(SIGNATORY_LINK),
  'POST /api/koppla/:token/connections/:id/select': uiOnly(SIGNATORY_LINK),
  'POST /api/koppla/:token/connections/:id/sync': uiOnly(SIGNATORY_LINK),
  'DELETE /api/koppla/:token/connections/:id': uiOnly(SIGNATORY_LINK),
  'POST /api/koppla/:token/verification/start': uiOnly(SIGNATORY_LINK),

  // ── Expenses, mileage, webshop ─────────────────────────────────────
  'POST /api/expense-claims': covered([`POST ${V}/expense-claims`, 'gnubok_create_expense_claim']),
  'DELETE /api/expense-claims/:id': covered([`DELETE ${V}/expense-claims/:id`, 'gnubok_delete_expense_claim']),
  'POST /api/expense-claims/payouts': covered([`POST ${V}/expense-claims/payouts`, 'gnubok_record_expense_payout']),
  'POST /api/expense-claims/suggest-template': uiOnly(PREVIEW),
  'POST /api/mileage/trips': covered(['gnubok_log_mileage_trip']),
  'PATCH /api/mileage/trips/:id': gap('P3'),
  'DELETE /api/mileage/trips/:id': gap('P3'),
  'POST /api/mileage/book': covered(['gnubok_book_mileage_period']),
  'POST /api/mileage/salary-push': gap('P2', 'push milersättning to a salary run and claim the trips (monthly payroll). An agent can only type the amount as a payslip line (gnubok_add_payslip_line), which leaves the trips unclaimed, so gnubok_book_mileage_period can book them a second time'),
  'POST /api/webshop-orders/:id/book': covered([`POST ${V}/webshop-orders/:orderId/book`, 'gnubok_book_webshop_order']),
  'POST /api/webshop-orders/:id/create-invoice': gap('P3'),
  'POST /api/webshop-orders/:id/mark-booked': gap('P3'),
  'DELETE /api/webshop-orders/:id/mark-booked': gap('P3'),
  'POST /api/webshop-orders/:id/underlag': gap('P3', 'retry the orderunderlag PDF on a booked order'),
  'POST /api/webshop-orders/bulk-book': gap('P3'),
  'POST /api/webshop-orders/kustom-settlement': gap('P3', 'read a Kustom settlement report (CSV) onto the Orders page'),
  'PUT /api/webshop-orders/settings': gap('P3', 'payment-method mapping and accounts per country'),
  // POS sales (kassasystem via Accounted Connect): lib/operations/pos-sales.ts
  'POST /api/pos-sales/connections': covered([`POST ${V}/pos-sales/connections`, 'gnubok_connect_pos_venue']),
  'POST /api/pos-sales/connections/:id/disconnect': covered([
    `POST ${V}/pos-sales/connections/:connectionId/disconnect`,
    'gnubok_disconnect_pos_connection',
  ]),
  'PATCH /api/pos-sales/connections/:id/settings': covered([
    `PATCH ${V}/pos-sales/connections/:connectionId/settings`,
    'gnubok_update_pos_settings',
  ]),
  'POST /api/pos-sales/days/:id/book': covered([`POST ${V}/pos-sales/days/:dayId/book`, 'gnubok_book_pos_sales_day']),
  'POST /api/pos-sales/fetch': covered([`POST ${V}/pos-sales/fetch`]),

  // Liquidity forecast rows (lib/forecast/rows.ts): written directly, not bookkeeping
  'POST /api/reports/cash-forecast/rows': covered(
    [`POST ${V}/cash-forecast-rows`, 'gnubok_upsert_cash_forecast_rows'],
    'the API names each row by external_source + external_id; a row a person types in has no outside key',
  ),
  'POST /api/reports/cash-forecast/rows/:id/cancel': covered([`POST ${V}/cash-forecast-rows/cancel`, 'gnubok_cancel_cash_forecast_row']),

  // ── VAT, tax, ROT/RUT ──────────────────────────────────────────────
  'POST /api/reports/vat-declaration/filings': covered([`POST ${V}/reports/vat-declaration/filings`, 'gnubok_mark_vat_period_filed']),
  'DELETE /api/reports/vat-declaration/filings': covered([`DELETE ${V}/reports/vat-declaration/filings`, 'gnubok_unmark_vat_period_filed']),
  'POST /api/reports/vat-declaration/rc-basis-gaps/fix': gap('P3', 'add the missing reverse-charge basbelopp pair'),
  'POST /api/reports/vat-declaration/check-reviews': covered(['gnubok_mark_vat_check_reviewed'], 'staged; a person approves the agent\'s review'),
  'DELETE /api/reports/vat-declaration/check-reviews': uiOnly('taking back a VAT warning review is the reviewer\'s own act in the momsdeklaration view'),
  'POST /api/reports/vat-declaration/not-momsredovisning': covered(['gnubok_mark_not_momsredovisning'], 'staged; a person approves the agent\'s mark'),
  'DELETE /api/reports/vat-declaration/not-momsredovisning': covered(['gnubok_withdraw_not_momsredovisning'], 'staged; a person approves the agent\'s withdrawal'),
  'PUT /api/reports/ink3/inputs': gap(
    'P2',
    'INK3 account treatments, the allmännyttig statement and ruta overrides; v1 and MCP read the underlag only in this step (product decision on #47)',
  ),
  'PUT /api/bookkeeping/fiscal-periods/:id/ef-declaration/inputs': gap(
    'P2',
    'the enskild firma\'s NE-bilaga sida 2 inputs; MCP gnubok_preview_ef_declaration takes them per call in this step',
  ),
  'POST /api/vat/validate': uiOnly('read-only VIES VAT-number check for a form, exposed as POST'),
  'POST /api/tax-assessment-notices': gap('P3', 'register a slutskattebesked'),
  'PATCH /api/tax-assessment-notices/:id': gap('P3'),
  'POST /api/tax-deadlines/generate': gap('P3', 'regenerate tax deadlines'),
  'POST /api/skatteverket/tax-payments/:period/mark-paid': gap('P3', 'mark AGI period tax paid'),
  'POST /api/deadlines': gap('P3', 'custom deadline'),
  'PUT /api/deadlines/:id': gap('P3'),
  'DELETE /api/deadlines/:id': gap('P3'),
  'POST /api/deadlines/:id/complete': covered([`POST ${V}/deadlines/:id/complete`, `POST ${V}/reports/vat-declaration/filings`, 'gnubok_complete_deadline', 'gnubok_mark_vat_period_filed', 'gnubok_mark_agi_period_filed'], 'any deadline by its id, either way (crm#1848); the moms and AGI deadlines also by period, with the filing date'),
  'POST /api/rot-rut/payout-file': covered(['gnubok_generate_rot_rut_file']),
  'POST /api/rot-rut/beslut/import': covered(['gnubok_import_rot_rut_beslut']),
  'PATCH /api/rot-rut/payout-requests/:id': gap('P3', 'begäran lifecycle by hand: submitted, paid, partially paid (with the decided total), rejected, cancelled; only the decision file has a door (gnubok_import_rot_rut_beslut)'),
  'POST /api/rot-rut/payout-requests/:id/link-voucher': covered(['gnubok_link_rot_rut_payout_voucher']),
  'POST /api/rot-rut/payout-requests/:id/settle': covered(['gnubok_settle_rot_rut_payout']),
  'POST /api/rot-rut/payout-requests/:id/reclaim': gap('P3', 'book a refused share back onto the customer'),

  // ── Assets ─────────────────────────────────────────────────────────
  'POST /api/assets': covered([`POST ${V}/assets`, 'gnubok_create_asset']),
  'PATCH /api/assets/:id': covered([`PATCH ${V}/assets/:id`, 'gnubok_update_asset']),
  'DELETE /api/assets/:id': covered([`DELETE ${V}/assets/:id`, 'gnubok_delete_asset']),
  'POST /api/assets/:id/dispose': covered([`POST ${V}/assets/:id/dispose`, 'gnubok_dispose_asset']),
  // The component register (K3 17.4-17.5): add, change and remove are the
  // full component list of PATCH /assets/:id (component_id names an
  // existing one).
  'POST /api/assets/:id/components': covered([`PATCH ${V}/assets/:id`, 'gnubok_update_asset']),
  'PATCH /api/assets/:id/components/:componentId': covered([`PATCH ${V}/assets/:id`, 'gnubok_update_asset']),
  'DELETE /api/assets/:id/components/:componentId': covered([`PATCH ${V}/assets/:id`, 'gnubok_update_asset']),
  'POST /api/assets/:id/components/:componentId/replace': covered([`POST ${V}/assets/:id/components/:componentId/replace`, 'gnubok_replace_asset_component']),
  'POST /api/assets/:id/value-adjustments': covered([`POST ${V}/assets/:id/value-adjustments`, 'gnubok_post_asset_value_adjustment']),
  'PATCH /api/assets/:id/identification': gap('P3', 'a building\'s fastighetsbeteckning and taxeringsvärde, a vehicle\'s registration number and bilförmån; dashboard first behind BOLAGET_COMPANY_IDS'),

  // ── Payroll ────────────────────────────────────────────────────────
  'POST /api/salary/employees': covered([`POST ${V}/employees`, 'gnubok_create_employee']),
  'PATCH /api/salary/employees/:id': covered([`PATCH ${V}/employees/:id`, 'gnubok_update_employee']),
  'DELETE /api/salary/employees/:id': covered([`DELETE ${V}/employees/:id`, 'gnubok_delete_employee']),
  'POST /api/salary/employees/:id/absence': covered([`PUT ${V}/employees/:id/absence`, 'gnubok_register_absence']),
  'DELETE /api/salary/employees/:id/absence': covered([`DELETE ${V}/employees/:id/absence`, 'gnubok_delete_absence']),
  'POST /api/salary/employees/:id/benefits': covered([`POST ${V}/employees/:id/benefits`, 'gnubok_add_employee_benefit']),
  'PATCH /api/salary/employees/:id/benefits/:benefitId': covered([`PATCH ${V}/employees/:id/benefits/:benefitId`, 'gnubok_update_employee_benefit']),
  'DELETE /api/salary/employees/:id/benefits/:benefitId': covered([`DELETE ${V}/employees/:id/benefits/:benefitId`, 'gnubok_delete_employee_benefit']),
  'POST /api/salary/employees/:id/recurring-lines': covered([`POST ${V}/employees/:id/recurring-lines`, 'gnubok_add_employee_recurring_line']),
  'PATCH /api/salary/employees/:id/recurring-lines/:lineId': covered([`PATCH ${V}/employees/:id/recurring-lines/:lineId`, 'gnubok_update_employee_recurring_line']),
  'DELETE /api/salary/employees/:id/recurring-lines/:lineId': covered([`DELETE ${V}/employees/:id/recurring-lines/:lineId`, 'gnubok_delete_employee_recurring_line']),
  'POST /api/salary/employees/:id/worked-hours': covered([`PUT ${V}/employees/:id/worked-days`, 'gnubok_set_worked_days']),
  'POST /api/salary/employees/:id/worked-hours/batch': covered([`PUT ${V}/employees/:id/worked-days`, 'gnubok_set_worked_days']),
  'DELETE /api/salary/employees/:id/worked-hours': covered([`DELETE ${V}/employees/:id/worked-days`, 'gnubok_delete_worked_days']),
  'PUT /api/salary/employees/:id/opening-balances': covered([`PUT ${V}/employees/:id/opening-balances`, 'gnubok_set_employee_opening_balances']),
  // OB and overtime premium rules: v1 only for now; an MCP tool is a follow-up.
  'POST /api/salary/premium-rules': covered([`POST ${V}/salary/premium-rules`]),
  'PATCH /api/salary/premium-rules/:id': covered([`PATCH ${V}/salary/premium-rules/:id`]),
  'DELETE /api/salary/premium-rules/:id': covered([`DELETE ${V}/salary/premium-rules/:id`]),
  'POST /api/salary/runs': covered([`POST ${V}/salary-runs`, 'gnubok_create_salary_run']),
  'PATCH /api/salary/runs/:id': covered([`PATCH ${V}/salary-runs/:id`, 'gnubok_update_salary_run']),
  'DELETE /api/salary/runs/:id': covered([`DELETE ${V}/salary-runs/:id`]),
  'POST /api/salary/runs/:id/calculate': covered([`POST ${V}/salary-runs/:id/calculate`, 'gnubok_calculate_salary_run']),
  'POST /api/salary/runs/:id/review': covered([`POST ${V}/salary-runs/:id/calculate`], 'v1 calculate advances draft to review'),
  'POST /api/salary/runs/:id/revert': covered([`POST ${V}/salary-runs/:id/revert`, 'gnubok_revert_salary_run']),
  'POST /api/salary/runs/:id/approve': covered([`POST ${V}/salary-runs/:id/approve`]),
  'POST /api/salary/runs/:id/unapprove': covered([`POST ${V}/salary-runs/:id/unapprove`, 'gnubok_unapprove_salary_run']),
  'POST /api/salary/runs/:id/paid': covered([`POST ${V}/salary-runs/:id/mark-paid`, 'gnubok_mark_salary_run_paid']),
  'POST /api/salary/runs/:id/book': covered([`POST ${V}/salary-runs/:id/book`, 'gnubok_book_salary_run']),
  'POST /api/salary/runs/:id/correct': covered([`POST ${V}/salary-runs/:id/correct`, 'gnubok_correct_salary_run']),
  'POST /api/salary/runs/:id/payment/pain001': covered(
    [`POST ${V}/salary-runs/:id/payment-file`],
    'new version with new_version + confirm_previous_not_approved; no MCP door builds payment files',
  ),
  'POST /api/salary/runs/:id/payment/pay-via-bank': gap(
    'P2',
    'prepare a salary run as bank payments, one per employee (lib/salary/payment/pay-via-bank.ts): the dashboard only in v1, no v1 endpoint or MCP tool yet; approving and signing them are the supplier payments\' doors',
  ),
  'POST /api/salary/runs/:id/payslips/send': covered([`POST ${V}/salary-runs/:id/send-payslips`, 'gnubok_send_payslips']),
  'POST /api/salary/runs/:id/employees': covered([`POST ${V}/salary-runs/:id/employees`, 'gnubok_add_salary_run_employee']),
  'PATCH /api/salary/runs/:id/employees/:employeeId': covered([`PATCH ${V}/salary-runs/:id/employees/:employeeId`, 'gnubok_set_run_salary']),
  'DELETE /api/salary/runs/:id/employees/:employeeId': covered([`DELETE ${V}/salary-runs/:id/employees/:employeeId`, 'gnubok_remove_salary_run_employee']),
  'POST /api/salary/runs/:id/employees/:employeeId/expense-claims': covered([`POST ${V}/salary-runs/:id/employees/:employeeId/expense-claims`, 'gnubok_attach_salary_expense_claims']),
  'POST /api/salary/runs/:id/lines': covered([`POST ${V}/salary-runs/:id/employees/:employeeId/lines`, 'gnubok_add_payslip_line']),
  'PATCH /api/salary/runs/:id/lines/:lineId': covered([`PATCH ${V}/salary-runs/:id/lines/:lineId`, 'gnubok_update_payslip_line']),
  'DELETE /api/salary/runs/:id/lines/:lineId': covered([`DELETE ${V}/salary-runs/:id/lines/:lineId`, 'gnubok_delete_payslip_line']),
  'POST /api/salary/vacation-liability/reconcile': covered(
    [`POST ${V}/salary/vacation-liability/reconcile`],
    'stäm av semesterlöneskuld per datum; MCP tool not yet (needs a staged pending type)',
  ),
  'POST /api/salary/vacation-liability/method': gap(
    'P3',
    'switch how the semesterlöneskuld is booked, with the catch-up verifikat: dashboard only; v1 GET /salary/settings does not show it yet',
  ),

  // ── Staged operations (Granskning) ─────────────────────────────────
  // The Anpassa page's package switch: stages enable_package or disable_package; approval is the commit door below.
  'POST /api/packages/:packageId': covered([
    `POST ${V}/packages/:packageId/enable`,
    `POST ${V}/packages/:packageId/disable`,
    'gnubok_enable_package',
    'gnubok_disable_package',
  ]),
  // Rules for automatic booking (grants, lib/grants): Att göra's "Bokfört enligt regel".
  'POST /api/grants/:id/revoke': gap('P2', 'stage revoke_grant for a rule for automatic booking; agents see the rules and their postings in the briefing but cannot stage a revoke yet'),
  'POST /api/grants/review': gap('P3', 'mark postings a rule let through as reviewed; the briefing lists them'),
  'POST /api/grants/pause': uiOnly("switches the company's rules for automatic booking off and on: switching them back on hands posting authority to agents, so a person does it in the browser"),
  'POST /api/pending-operations/:id/commit': covered([`POST ${V}/pending-operations/:id/approve`, 'gnubok_approve_pending_operation']),
  'POST /api/pending-operations/:id/reject': covered([`POST ${V}/pending-operations/:id/reject`, 'gnubok_reject_pending_operation']),
  'POST /api/pending-operations/bulk-commit': covered(
    [`POST ${V}/pending-operations/:id/approve`, 'gnubok_approve_pending_operation'],
    'one at a time',
  ),
  'POST /api/pending-operations/bulk-reject': covered(
    [`POST ${V}/pending-operations/:id/reject`, 'gnubok_reject_pending_operation'],
    'one at a time',
  ),
  'PATCH /api/pending-operations/:id/items': uiOnly(
    'taking invoices out of the daily collections batch in the review dialog; only a person approves that batch, in the browser',
  ),

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
  'POST /api/agent/feedback': uiOnly(ASSISTANT),
  'PATCH /api/agent/conversations/:id': uiOnly(ASSISTANT),
  'POST /api/agent/conversations/:id/reject-pending': uiOnly(ASSISTANT),
  'POST /api/agent/categorize': covered(['gnubok_suggest_categories']),
  'POST /api/agent/categorize/outcome': machine('machine endpoint: calibration telemetry'),
  'POST /api/agent/memory': covered(['gnubok_remember_fact']),
  'PATCH /api/agent/memory/:id': covered(['gnubok_forget_fact'], 'dismiss only; edit and pin have no API'),
  'POST /api/questions/:id/answer': covered(['gnubok_remember_fact'], 'the answer is a saved fact that names the question (answers_question_id)'),
  'POST /api/questions/:id/close': covered(['gnubok_close_question']),
  'POST /api/questions/:id/reopen': uiOnly("the page's own undo: the person who answered in the app takes the answer back within ten minutes"),
  'PATCH /api/agents/knowledge': gap('P3', 'attach knowledge packs to an agent'),
  'POST /api/agents/community/feedback': uiOnly('community upvote by a person'),
  // Community review is Accounted staff moderating the shared instruction
  // library, not a company capability; an agent must not approve its own text.
  'POST /api/community/items/:slug/approve': uiOnly('staff review of a community item: reviewers only'),
  'POST /api/community/submissions/:id/approve': uiOnly('staff review of a community submission: reviewers only'),
  'POST /api/community/submissions/:id/send-back': uiOnly('staff review of a community submission: reviewers only'),
  'POST /api/skills': covered(['gnubok_create_skill']),
  'PATCH /api/skills/:id': covered(['gnubok_create_skill'], 'edit via company_skill_id, back to draft; sharing and adding a draft stay in the app: adding is the person\'s own check'),
  'DELETE /api/skills/:id': covered(['gnubok_create_skill'], 'delete: true, the company\'s own private items only'),

  // ── Machine endpoints: crons, webhooks, connector proxies ──────────
  'POST /api/peppol/daily-report/cron': machine(CRON),
  'POST /api/peppol/inbound/cron': machine(CRON),
  'POST /api/digital-mailboxes/cron': machine(CRON),
  'POST /api/peppol/outbound/status/cron': machine(CRON),
  'POST /api/receipt-hunt/cron': machine(CRON),
  'POST /api/stripe/webhook': machine(WEBHOOK),
  'POST /api/webhooks/peppol/qvalia': machine(WEBHOOK),
  'POST /api/webhooks/kivra': machine(WEBHOOK),
  'POST /api/webhooks/billo': machine(WEBHOOK),
  'POST /api/extensions/woocommerce/callback': machine(WEBHOOK),
  'POST /api/connector/sync': machine('machine endpoint: self-hosted entitlement sync trigger (operator)'),
  'PUT /api/storage/:path*': machine('machine endpoint: signed-URL storage proxy that MCP document uploads PUT bytes to'),

  // ═══ Extension routes (dispatched by /api/extensions/ext/[...path]) ═══

  // enable-banking
  'POST /api/extensions/ext/enable-banking/connect': covered(['gnubok_connect_bank'], 'returns the browser consent link; BankID consent itself is browser-only'),
  'POST /api/extensions/ext/enable-banking/attach': uiOnly('reuse another company\'s bank consent session, then pick accounts in the browser'),
  'POST /api/extensions/ext/enable-banking/sync': covered([`POST ${V}/bank-connections/:connectionId/sync`, 'gnubok_sync_bank']),
  'PATCH /api/extensions/ext/enable-banking/accounts': gap('P3', 'choose which connected bank accounts sync; their ledger accounts have a door since crm#1663 (POST /cash-accounts/change-ledgers, gnubok_change_bank_ledgers)'),
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
  'POST /api/extensions/ext/arcim-migration/migration-jobs/accept': gap('P3', 'finish a reviewed import with the records it could not complete'),
  'POST /api/extensions/ext/arcim-migration/invoice-completion/retry': gap('P3'),
  'POST /api/extensions/ext/arcim-migration/deduction-backfill': gap('P3', 'post-migration ROT/RUT step: reads buyers\' personnummer and books vouchers; no API client has asked (crm#1144)'),
  'PUT /api/extensions/ext/arcim-migration/fortnox-topup': gap('P3', 'switch the nightly top-up from Fortnox of the imported years on or off; no door (a client with a key appends a SIE file itself through POST /imports/sie with onExistingPeriod append)'),
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
  'POST /api/extensions/ext/tic/lookup': covered([`POST ${V}/company-lookup`, 'gnubok_lookup_company'], 'read-only registry lookup, a POST so the org number stays out of the URL'),

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
  'POST /api/extensions/ext/skatteverket/agi/send-for-signing': covered(['gnubok_agi_submit']),
  'POST /api/extensions/ext/skatteverket/agi/lasUpp': gap('P3', 'unlock an AGI awaiting signature'),
  'POST /api/extensions/ext/skatteverket/agi/granskningsunderlag': covered(['gnubok_agi_submit'], 'step 2 of the chain (the signing link, with the period locked): the tool\'s approval runs both steps (submitAgiChain), never step 2 alone'),
  'POST /api/extensions/ext/skatteverket/skattekonto/sync': covered([`POST ${V}/skattekonto/sync`]),
  'POST /api/extensions/ext/skatteverket/skattekonto/transaktioner/bokfor-batch': covered(['gnubok_book_skattekonto_rows']),
  'POST /api/extensions/ext/skatteverket/skattekonto/transaktioner/:id/bokfor': covered(['gnubok_book_skattekonto_row']),
  'POST /api/extensions/ext/skatteverket/skattekonto/transaktioner/:id/match': covered(['gnubok_reconcile_match']),
  'POST /api/extensions/ext/skatteverket/skattekonto/transaktioner/group-match-candidates': covered(
    ['gnubok_query_journal', 'gnubok_reconcile_match'],
    'read helper for the match dialog: find the verifikat by its 1630 amount, then link the rows as one pair',
  ),
  'PATCH /api/extensions/ext/skatteverket/skattekonto/transaktioner/:id/ignore': covered(
    [`POST ${V}/reconciliation/accounts/:accountKey/items/:itemId/ignore`],
    'with accountKey=skattekonto',
  ),

  // invoice-inbox (Underlag)
  'POST /api/extensions/ext/invoice-inbox/upload': covered([`POST ${V}/inbox-items`, 'gnubok_upload_document']),
  'POST /api/extensions/ext/invoice-inbox/upload/create': covered(['gnubok_create_document_upload']),
  'POST /api/extensions/ext/invoice-inbox/upload/complete': covered(['gnubok_complete_document_upload']),
  'PATCH /api/extensions/ext/invoice-inbox/items/:id/fields': covered([`PATCH ${V}/inbox-items/:id`, 'gnubok_set_inbox_extracted_data']),
  'PUT /api/extensions/ext/invoice-inbox/items/:id/purchase-category': covered([`PUT ${V}/inbox-items/:id/purchase-category`, 'gnubok_set_inbox_purchase_category']),
  'POST /api/extensions/ext/invoice-inbox/items/:id/match-transaction': covered([`POST ${V}/inbox-items/:id/match-transaction`, 'gnubok_attach_document_to_transaction']),
  'POST /api/extensions/ext/invoice-inbox/items/:id/unmatch-transaction': covered([`POST ${V}/inbox-items/:id/unmatch-transaction`, 'gnubok_unmatch_inbox_item_transaction']),
  'POST /api/extensions/ext/invoice-inbox/items/:id/retry-extraction': gap('P3'),
  'POST /api/extensions/ext/invoice-inbox/items/:id/convert': covered([`POST ${V}/inbox-items/:id/convert`, 'gnubok_create_supplier_invoice_from_inbox']),
  'POST /api/inkorg/items/:id/register-and-settle': covered(
    [`POST ${V}/inbox-items/:id/convert`, `POST ${V}/transactions/:id/match-supplier-invoice`],
    'the Inkorg runs the two in one request; a machine calls them in turn',
  ),
  'POST /api/inkorg/items/:id/book': covered(
    [`POST ${V}/inbox-items/:id/convert`, `POST ${V}/transactions/:id/match-supplier-invoice`, 'gnubok_bulk_book_inbox_items'],
    'the Inkorg plans the booking on the server and runs the doors in one request; a machine plans its own and calls them',
  ),
  'POST /api/inkorg/items/:id/companion': covered(
    [`POST ${V}/inbox-items/:id/match-transaction`, 'gnubok_link_document_to_voucher'],
    'the receipt that came with an invoice lands on the invoice\'s booking: matched to its booked bank row, or its document linked to the verifikat',
  ),
  // The company's own supplier portals: where a supplier keeps its invoices
  // behind a login. Kvittojakten's worklist reads them (portal, next_step);
  // no machine door adds or changes one yet.
  'POST /api/inkorg/portals': gap('P3', 'add a supplier portal from a purchase (read back through gnubok_receipt_hunt_worklist portal)'),
  'PATCH /api/inkorg/portals/:id': gap('P3'),
  'DELETE /api/inkorg/portals/:id': gap('P3'),
  'POST /api/extensions/ext/invoice-inbox/items/:id/book-direct': covered(['gnubok_bulk_book_inbox_items'], 'batch of one; items without a matched bank row have no API'),
  'POST /api/extensions/ext/invoice-inbox/items/:id/suggest-booking': covered(['gnubok_suggest_categories']),
  'POST /api/extensions/ext/invoice-inbox/items/bulk-book': covered(['gnubok_bulk_book_inbox_items']),
  'DELETE /api/extensions/ext/invoice-inbox/items/:id': covered([`DELETE ${V}/inbox-items/:id`, 'gnubok_delete_inbox_item']),
  'POST /api/inkorg/items/remove': covered([`DELETE ${V}/inbox-items/:id`, 'gnubok_delete_inbox_item'], 'one call per item; the batch is the same removal in a loop'),
  'POST /api/inkorg/items/restore': covered([`POST ${V}/inbox-items/:id/restore`], 'no MCP tool yet: a person puts an item back from Senast borttagna'),
  'POST /api/extensions/ext/invoice-inbox/inbox/previous/stop': gap('P3', 'stop an earlier inbox address a rename kept (crm#1209), like rotate'),
  'POST /api/extensions/ext/invoice-inbox/inbox/rotate': gap('P3', 'rotate the inbound e-mail address'),
  'POST /api/extensions/ext/invoice-inbox/inbound': machine(WEBHOOK),

  // mail (Gmail receipt hunt). Searching a mailbox stays a press by a
  // signed-in person: Google approved gmail.readonly for that trigger, not
  // for an API key or an agent, and the nightly cron never searches mail.
  'POST /api/extensions/ext/mail/oauth/start': uiOnly(OAUTH_CONNECT),
  'DELETE /api/extensions/ext/mail/connections': gap('P3'),
  'POST /api/receipt-hunt/run': uiOnly(
    'mailbox search a signed-in person starts: the Gmail scope was approved for that trigger, not for API keys or agents',
  ),

  // stripe (payments integration, not billing)
  'POST /api/extensions/ext/stripe/connect': uiOnly(OAUTH_CONNECT),
  'DELETE /api/extensions/ext/stripe/disconnect': gap('P3'),
  'POST /api/extensions/ext/stripe/sync': gap('P3', EXT_SYNC),
  'POST /api/extensions/ext/stripe/backfill': covered(['gnubok_backfill_feed']),
  'POST /api/extensions/ext/stripe/transaction-sync': gap('P3', EXT_SYNC_SWITCH),

  // whatsapp-inbox
  'POST /api/extensions/ext/whatsapp-inbox/webhook': machine(WEBHOOK),
  'POST /api/extensions/ext/whatsapp-inbox/link/start': uiOnly('links the logged-in person\'s own WhatsApp number'),
  'POST /api/extensions/ext/whatsapp-inbox/link/revoke': uiOnly('links the logged-in person\'s own WhatsApp number'),
  'POST /api/extensions/ext/whatsapp-inbox/link/unmute': uiOnly('links the logged-in person\'s own WhatsApp number'),
  'POST /api/extensions/ext/whatsapp-inbox/link/default-company': uiOnly('links the logged-in person\'s own WhatsApp number'),

  // woocommerce
  'POST /api/extensions/ext/woocommerce/connect': uiOnly(OAUTH_CONNECT),
  'POST /api/extensions/ext/woocommerce/manual-connect': uiOnly('enters a third-party store credential'),
  'POST /api/extensions/ext/woocommerce/verify-store': uiOnly('finishes the store authorization in the browser: the person types what only the store admin shows'),
  'DELETE /api/extensions/ext/woocommerce/disconnect': gap('P3'),
  'POST /api/extensions/ext/woocommerce/sync': gap('P3', EXT_SYNC),
  'POST /api/extensions/ext/woocommerce/backfill': covered(['gnubok_backfill_feed']),
  'POST /api/extensions/ext/woocommerce/transaction-sync': gap('P3', EXT_SYNC_SWITCH),

  // shopify
  'POST /api/extensions/ext/shopify/connect': uiOnly(OAUTH_CONNECT),
  'DELETE /api/extensions/ext/shopify/disconnect': gap('P3'),
  'POST /api/extensions/ext/shopify/sync': gap('P3', EXT_SYNC),
  'POST /api/extensions/ext/shopify/backfill': covered(['gnubok_backfill_feed']),
  'POST /api/extensions/ext/shopify/transaction-sync': gap('P3', EXT_SYNC_SWITCH),

  // zettle
  'POST /api/extensions/ext/zettle/connect': uiOnly(OAUTH_CONNECT),
  'DELETE /api/extensions/ext/zettle/disconnect': gap('P3'),
  'POST /api/extensions/ext/zettle/sync': gap('P3', EXT_SYNC),
  'POST /api/extensions/ext/zettle/backfill': covered(['gnubok_backfill_feed']),
  'POST /api/extensions/ext/zettle/transaction-sync': gap('P3', EXT_SYNC_SWITCH),
}

/**
 * The exact number of 'gap' entries today. Covering a gap means lowering
 * this; adding one means raising it in the same diff, visibly.
 * 144 -> 150 (2026-10-19): the six digital mailbox doors (Kivra, Billo),
 * public API to follow once the dashboard flow is proven in production.
 * 150 -> 146 (2026-10-23, crm#1385): the four feed backfills are covered by
 * gnubok_backfill_feed.
 * 146 -> 147 (2026-10-23): the orderunderlag retry on a booked order
 * (crm#1032). Agents book through webshop-orders.book, which archives the
 * underlag itself; the retry repairs a dashboard booking where it failed.
 * 155 -> 156 (2026-10-26, crm#1395): changing a connected bank account's
 * ledger account on any connection, dashboard first like the pickers.
 * 156 -> 155 (2026-10-26, PH 175 / issue #50): the skattekonto account is
 * covered by PATCH /settings/skattekonto-account.
 * 155 -> 156 (2026-10-26): paying a salary run through the bank, dashboard
 * only in v1.
 * 156 -> 157 (2026-10-27, accounted#104): excluding a customer from
 * reminders, a P3 gap like the collections exclusion.
 * 157 -> 159 (2026-10-27): archiving a mistakenly connected bank account
 * (PH 222) and stopping an earlier inbox address (crm#1209), dashboard only
 * like their siblings removal and rotate.
 * 159 -> 164 (2026-10-27, K3 kapitel 23): pågående arbeten (settings, uppdrag,
 * the year's booking), dashboard first behind NEXT_PUBLIC_CONTRACT_REVENUE_ENABLED.
 * 164 -> 166 (2026-10-27, K3 kapitel 20): register and book finansiella
 * leasingavtal, dashboard first behind NEXT_PUBLIC_FINANCE_LEASE_ENABLED.
 * 166 -> 167 (2026-10-27, #523, K3 build): the monthly currency
 * revaluation, dashboard first behind NEXT_PUBLIC_FX_MONTHLY_REVALUATION_ENABLED.
 * 167 -> 166 (2026-10-27): PATCH /api/pending-operations/:id is removed; no
 * page called it, and reject and restage covers the edit.
 * 166 -> 167 (2026-10-27): switching how the semesterlöneskuld is booked,
 * dashboard only: the switch posts a catch-up verifikat behind a previewed
 * confirm; stäm av per datum has its v1 door.
 * 167 -> 168 (2026-10-27, accounted#111): K3 component replacement, dashboard
 * first; the operation follows with the K3 doors.
 * 168 -> 169 (2026-10-27, accounted#111): the K3 nedskrivning vouchers,
 * dashboard first; the operation follows with the K3 doors.
 * 169 -> 170 (2026-10-27, accounted#111): the K3 uppskjuten skatt inputs,
 * dashboard first; the operation follows with the K3 doors.
 * 170 -> 171 (2026-10-27, accounted#111): the K3 18.7 development model,
 * dashboard first; the operation follows with the K3 doors.
 * 171 -> 172 (2026-10-27, accounted#111): a building's tax plan, dashboard
 * first; the operation follows with the K3 doors.
 * 172 -> 178 (2026-10-27, accounted#111): the K3 transition (start, note facts,
 * drop, preview, commit) and the split at it, dashboard first; the
 * operations follow with the K3 doors.
 * 178 -> 167 (2026-10-27, accounted#111): the K3 doors (lib/operations/k3.ts)
 * cover the eleven K3 gaps above.
 * 167 -> 168 (2026-10-29, Bolaget W5): a building's or vehicle's
 * identification fields on the asset register, dashboard first behind
 * BOLAGET_COMPANY_IDS.
 * 168 -> 169 (2026-10-29, merge with the year-end stock count): deleting a
 * draft stock count, dashboard only; a signed count is kept.
 * 169 -> 167 (2026-10-30, crm#1506): editing and deleting an own skill,
 * through gnubok_create_skill (company_skill_id, delete: true).
 * 167 -> 166 (2026-11-04, crm#1663): the ledger account of a connected bank
 * account, through gnubok_change_bank_ledgers.
 * 166 -> 167 (2026-11-07, accounted#111): stop using pågående arbeten (the
 * settings' DELETE), dashboard first behind NEXT_PUBLIC_CONTRACT_REVENUE_ENABLED.
 * 167 -> 168 (2026-11-12): unlink a supplier invoice from a linked verifikat
 * (POST /api/supplier-invoices/:id/unlink-voucher), dashboard first; the v1
 * route and the MCP tool are a follow-up.
 * 168 -> 169 (2026-11-14, crm#1849): mark a verifikat the momsredovisning
 * shapes catch as a correction (POST /api/reports/vat-declaration/
 * not-momsredovisning), dashboard first; a staged MCP tool is a follow-up.
 * 169 -> 168 (2026-11-15, crm#1849): that mark, and its withdrawal, through
 * the staged gnubok_mark_not_momsredovisning and
 * gnubok_withdraw_not_momsredovisning.
 * 163 -> 162 (2026-11-19, crm#1967): confirming the opening balance review,
 * through the staged gnubok_acknowledge_opening_balance_review.
 * 162 -> 163 (2026-11-20): saving an enskild firma's NE-bilaga sida 2 inputs
 * (PUT .../ef-declaration/inputs), new and dashboard-only in this step; the
 * MCP preview takes the same figures per call.
 * 163 -> 162 (2026-11-24): sending an invoice to the customer's Kivra or
 * Billo mailbox, through the staged gnubok_send_invoice with channel kivra
 * or billo.
 * 162 -> 159 (2026-11-25): renaming, removing and changing a learned booking
 * rule, through the staged gnubok_rename_counterparty_template and
 * gnubok_update_counterparty_template.
 * 159 -> 160 (2026-11-25): the switch of the nightly top-up from Fortnox
 * on a Fortnox connection (PUT .../arcim-migration/fortnox-topup), new and
 * dashboard-only, as the nightly syncs of the webshop integrations.
 */
export const GAP_CEILING = 160
