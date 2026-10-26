/**
 * Package doors: which doors START new work in a package, so that a package
 * switched off (./capabilities.ts: off or winding_down) refuses them with
 * PACKAGE_OFF, while every door that settles, corrects, reads or keeps a
 * register open keeps working. The founder's rule (Profiles and
 * Suggestions, 2026-10-16): "off" closes the start paths only; obligations
 * keep running.
 *
 * Pure data and matchers, no server imports: withRouteContext reads it on
 * every request and must stay light. The gate itself is ./package-gate.ts.
 *
 * Every write door of a switchable package is classified here exactly once,
 * as `start` or `continue`. __tests__/package-doors.test.ts (session routes,
 * v1 endpoints, operations, pending types) and the MCP server's
 * __tests__/package-doors.test.ts (its hand-written tools, and the pending
 * types each one stages) fail on a door of a switchable package that is in
 * neither list, on a stale entry, and on a start door that no gate reaches.
 * A new door therefore ships with a decision. Doors outside the switchable
 * packages (Bokföring, the platform, the agent, the byrå tools) are never
 * gated.
 *
 * What counts as a start: creating a new root record of the package from
 * nothing it already holds open: a new invoice, quote, order or recurring
 * schedule, a new supplier invoice, a new salary run, a new expense claim or
 * trip, a new asset, a new bank, till, webshop or mail connection. Not a
 * start: everything done to what already exists (send, book, pay, credit,
 * correct, match, file, disconnect, delete a draft), the registers the
 * package shares (customers, suppliers, articles, employees: Utlägg needs
 * employees without Lön), and every read. Each start door names the package
 * it starts, which may differ from the package its URL sits under (a webshop
 * order invoiced starts a customer invoice).
 *
 * Keys:
 *   - 'POST /api/invoices': a dashboard (session) route, as
 *     lib/operations/session-route-parity.ts spells it; extension routes by
 *     their public path ('POST /api/extensions/ext/<id>/...').
 *   - 'POST /api/v1/companies/:companyId/...': a hand-written v1 endpoint.
 *   - 'op:<operation id>': an operation (lib/operations/registry.ts): its v1
 *     endpoint, its generated MCP tool and its pending type at approval.
 *   - 'mcp:<tool>': a hand-written MCP tool.
 *   - 'pending:<type>': a pending operation type a hand-written tool stages,
 *     refused at approval while the package is off (staged before the
 *     switch, approved after).
 */
import type { PackageId } from './packages'
import type { SwitchablePackageId } from './profiles'

export interface PackageDoors {
  /** Doors that start new work in the package: refused while it is off or winding down. */
  readonly start: readonly string[]
  /** Every other write door of the package: never refused by a package switch. */
  readonly continue: readonly string[]
}

/**
 * The first path segment after /api/ of a dashboard route, and the package
 * its routes belong to (null: outside the switchable packages). Every
 * segment that has a write route is listed, so a new one is placed before it
 * ships (the guard test). Extension routes resolve through
 * EXTENSION_PACKAGES instead.
 */
export const SESSION_SEGMENT_PACKAGES: Readonly<Record<string, SwitchablePackageId | null>> = Object.freeze({
  invoices: 'customer-invoices',
  customers: 'customer-invoices',
  articles: 'customer-invoices',
  'sales-orders': 'customer-invoices',
  'rot-rut': 'customer-invoices',
  collections: 'customer-invoices',
  peppol: 'customer-invoices',
  'supplier-invoices': 'supplier-invoices-and-payments',
  suppliers: 'supplier-invoices-and-payments',
  payments: 'supplier-invoices-and-payments',
  betala: 'supplier-invoices-and-payments',
  attest: 'supplier-invoices-and-payments',
  salary: 'payroll',
  payslip: 'payroll',
  'expense-claims': 'expenses',
  mileage: 'expenses',
  assets: 'assets',
  'pos-sales': 'pos-and-webshop',
  'webshop-orders': 'pos-and-webshop',
  bank: 'bank',
  koppla: 'bank',
  arkiv: 'receipts-and-documents',
  'receipt-hunt': 'receipts-and-documents',
  inkorg: 'receipts-and-documents',
  // Kivra and Billo: connecting the company's mailbox starts a mail
  // connection (Kvitton och underlag); activating the company as a sender
  // only enables a delivery channel of documents that already exist.
  'digital-mailboxes': 'receipts-and-documents',
  // Outside the switchable packages: Bokföring's own surface, the platform,
  // the agent, the byrå tools and the machine endpoints.
  account: null,
  agent: null,
  agents: null,
  auth: null,
  billing: null,
  bookkeeping: null,
  byra: null,
  calendar: null,
  'cash-accounts': null,
  clients: null,
  community: null,
  company: null,
  connect: null,
  connector: null,
  deadlines: null,
  dimensions: null,
  documents: null,
  extensions: null,
  grants: null,
  import: null,
  kpi: null,
  legal: null,
  log: null,
  'mcp-oauth': null,
  notices: null,
  onboarding: null,
  parties: null,
  'pending-operations': null,
  reconciliation: null,
  reports: null,
  rules: null,
  sandbox: null,
  settings: null,
  // BankID signing of archive documents (lib/signing, the ledger kernel): the
  // requests, the signer's link and the member's own signing.
  signera: null,
  signing: null,
  'signing-requests': null,
  skatteverket: null,
  skills: null,
  stripe: null,
  support: null,
  'tax-assessment-notices': null,
  'tax-deadlines': null,
  team: null,
  transactions: null,
  user: null,
  vat: null,
  webhooks: null,
  packages: null,
})

/**
 * The package each first-party extension's routes belong to, by extension
 * id (null: outside the switchable packages). Every extension with a write
 * route is listed (the guard test).
 */
export const EXTENSION_PACKAGES: Readonly<Record<string, SwitchablePackageId | null>> = Object.freeze({
  'enable-banking': 'bank',
  'invoice-inbox': 'receipts-and-documents',
  mail: 'receipts-and-documents',
  'whatsapp-inbox': 'receipts-and-documents',
  woocommerce: 'pos-and-webshop',
  shopify: 'pos-and-webshop',
  zettle: 'pos-and-webshop',
  // A payment provider's feed into the inbox and payment links on invoices:
  // no package of its own.
  stripe: null,
  'arcim-migration': null,
  'cloud-backup': null,
  email: null,
  'mcp-server': null,
  skatteverket: null,
  tic: null,
})

const EXTENSION_ROUTE_PREFIX = '/api/extensions/ext/'

/** The package a dashboard route key ('POST /api/...') belongs to, or null. */
export function packageForSessionRoute(key: string): SwitchablePackageId | null {
  const path = key.slice(key.indexOf(' ') + 1)
  if (path.startsWith(EXTENSION_ROUTE_PREFIX)) {
    return EXTENSION_PACKAGES[path.slice(EXTENSION_ROUTE_PREFIX.length).split('/')[0]] ?? null
  }
  return SESSION_SEGMENT_PACKAGES[path.split('/')[2]] ?? null
}

const BANK: PackageDoors = {
  start: [
    'POST /api/bank/open-payments/connections',
    'POST /api/bank/open-payments/invites',
    'POST /api/extensions/ext/enable-banking/connect',
    'op:bank-feed.invite',
    'op:bank-feed.start',
    'mcp:gnubok_connect_bank',
  ],
  continue: [
    'DELETE /api/bank/open-payments/connections/:id',
    'POST /api/bank/open-payments/connections/:id/poll',
    'POST /api/bank/open-payments/connections/:id/restart',
    'POST /api/bank/open-payments/connections/:id/select',
    'POST /api/bank/open-payments/connections/:id/sync',
    'PATCH /api/bank/connections/:id/ledgers',
    'PATCH /api/extensions/ext/enable-banking/accounts',
    'POST /api/extensions/ext/enable-banking/attach',
    'DELETE /api/extensions/ext/enable-banking/disconnect',
    'POST /api/extensions/ext/enable-banking/sync',
    'POST /api/koppla/:token/connections',
    'DELETE /api/koppla/:token/connections/:id',
    'POST /api/koppla/:token/connections/:id/poll',
    'POST /api/koppla/:token/connections/:id/restart',
    'POST /api/koppla/:token/connections/:id/select',
    'POST /api/koppla/:token/connections/:id/sync',
    'POST /api/koppla/:token/verification/start',
    'POST /api/v1/companies/:companyId/bank-connections/:connectionId/sync',
    'op:bank-feed.disconnect',
    'op:bank-feed.restart',
    'op:bank-feed.select',
    'op:bank-feed.sync',
    'mcp:gnubok_sync_bank',
  ],
}

const CUSTOMER_INVOICES: PackageDoors = {
  start: [
    'POST /api/invoices',
    'POST /api/invoices/:id/convert',
    'POST /api/invoices/:id/convert-to-order',
    'POST /api/invoices/recurring',
    'POST /api/invoices/recurring/:id/run',
    'POST /api/invoices/self-billed',
    'POST /api/sales-orders',
    'POST /api/sales-orders/:id/create-invoice',
    'POST /api/webshop-orders/:id/create-invoice',
    'POST /api/v1/companies/:companyId/invoices',
    'POST /api/v1/companies/:companyId/invoices/bulk-create',
    'mcp:gnubok_convert_invoice',
    'mcp:gnubok_create_invoice',
    'mcp:gnubok_create_invoice_from_sales_order',
    'mcp:gnubok_create_recurring_schedule',
    'mcp:gnubok_create_sales_order',
    'mcp:gnubok_register_booked_invoice',
    'pending:convert_invoice',
    'pending:create_invoice',
    'pending:create_invoice_from_sales_order',
    'pending:create_recurring_schedule',
    'pending:create_sales_order',
  ],
  continue: [
    'POST /api/articles',
    'DELETE /api/articles/:id',
    'PATCH /api/articles/:id',
    // Collections: booking what the provider collected and paid out, and its
    // rebook, all for cases already open on existing invoices.
    'POST /api/collections/payments/:id/book',
    'POST /api/collections/payments/:id/rebook',
    'POST /api/collections/settlements/:id/book',
    'POST /api/collections/settlements/:id/duplicate',
    'POST /api/customers',
    'POST /api/customers/merge',
    'POST /api/customers/merge/undo',
    'DELETE /api/customers/:id',
    'PATCH /api/customers/:id',
    'PATCH /api/customers/:id/collections-exclusion',
    'DELETE /api/invoices/:id',
    'DELETE /api/invoices/:id/attachments/:documentId',
    'PATCH /api/invoices/:id',
    'POST /api/invoices/:id/attachments',
    'POST /api/invoices/:id/book',
    'POST /api/invoices/:id/cancel',
    'POST /api/invoices/:id/collection',
    'POST /api/invoices/:id/collection/actions',
    'POST /api/invoices/:id/collection/forwards',
    'POST /api/invoices/:id/collection/possible-payments',
    // Autogiro: the agreement and mandates are registers; a debit file and a
    // report collect or settle invoices already issued.
    'PUT /api/invoices/autogiro/settings',
    'POST /api/invoices/autogiro/mandates',
    'PATCH /api/invoices/autogiro/mandates/:id',
    'POST /api/invoices/autogiro/mandates/:id/cancel',
    'POST /api/invoices/autogiro/debit-files',
    'POST /api/invoices/autogiro/debit-files/:id/withdraw',
    'POST /api/invoices/autogiro/reports',
    'POST /api/invoices/autogiro/settle',
    // A kundförlust decision on an invoice already issued.
    'POST /api/invoices/:id/customer-loss',
    'POST /api/invoices/:id/finalize',
    'POST /api/invoices/:id/link-to-voucher',
    'POST /api/invoices/:id/mark-paid',
    'POST /api/invoices/:id/mark-sent',
    'POST /api/invoices/:id/peppol',
    'POST /api/invoices/:id/peppol/send',
    'POST /api/invoices/:id/digital-mailbox/send',
    'POST /api/invoices/:id/quote-status',
    'POST /api/invoices/:id/refresh-exchange-rate',
    'POST /api/invoices/:id/resend',
    'POST /api/invoices/:id/send',
    'POST /api/invoices/:id/send-payment-confirmation',
    'POST /api/invoices/bulk-book',
    'POST /api/invoices/preview-email',
    'POST /api/invoices/preview-pdf',
    'DELETE /api/invoices/recurring/:id',
    'PATCH /api/invoices/recurring/:id',
    'POST /api/rot-rut/beslut/import',
    'POST /api/rot-rut/payout-file',
    'PATCH /api/rot-rut/payout-requests/:id',
    'POST /api/rot-rut/payout-requests/:id/link-voucher',
    'POST /api/rot-rut/payout-requests/:id/reclaim',
    'POST /api/rot-rut/payout-requests/:id/settle',
    'DELETE /api/sales-orders/:id',
    'PATCH /api/sales-orders/:id',
    'POST /api/sales-orders/:id/deliver',
    'POST /api/sales-orders/:id/transition',
    'POST /api/v1/companies/:companyId/customers',
    'DELETE /api/v1/companies/:companyId/customers/:id',
    'PATCH /api/v1/companies/:companyId/customers/:id',
    'POST /api/v1/companies/:companyId/customers/bulk-create',
    'DELETE /api/v1/companies/:companyId/invoices/:id',
    'PATCH /api/v1/companies/:companyId/invoices/:id',
    'POST /api/v1/companies/:companyId/invoices/:id/credit',
    'POST /api/v1/companies/:companyId/invoices/:id/mark-paid',
    'POST /api/v1/companies/:companyId/invoices/:id/mark-sent',
    'POST /api/v1/companies/:companyId/invoices/:id/quote-status',
    'POST /api/v1/companies/:companyId/invoices/:id/send',
    'op:collections.cases.action',
    'op:collections.cases.open',
    'op:collections.payments.book',
    'op:collections.settlements.book',
    'op:customers.merge',
    'op:customers.merge.undo',
    'op:invoices.book',
    'op:invoices.bulk-book',
    'op:invoices.cancel',
    'op:invoices.customer-loss.record',
    // A set-off of two invoices already issued and registered.
    'op:invoices.setoff.book',
    'op:invoices.send-peppol',
    'op:peppol.register',
    'op:peppol.request-access',
    'mcp:gnubok_create_article',
    'mcp:gnubok_create_customer',
    'mcp:gnubok_credit_invoice',
    'mcp:gnubok_delete_draft_invoice',
    'mcp:gnubok_generate_rot_rut_file',
    'mcp:gnubok_import_rot_rut_beslut',
    'mcp:gnubok_link_invoice_to_voucher',
    'mcp:gnubok_link_rot_rut_payout_voucher',
    'mcp:gnubok_mark_invoice_as_paid',
    'mcp:gnubok_mark_invoice_as_sent',
    'mcp:gnubok_register_sales_order_delivery',
    'mcp:gnubok_send_invoice',
    'mcp:gnubok_set_quote_status',
    'mcp:gnubok_settle_rot_rut_payout',
    'mcp:gnubok_transition_sales_order',
    'mcp:gnubok_update_article',
    'mcp:gnubok_update_customer',
    'mcp:gnubok_update_invoice',
    'mcp:gnubok_update_recurring_schedule',
  ],
}

const SUPPLIER_INVOICES_AND_PAYMENTS: PackageDoors = {
  start: [
    'POST /api/extensions/ext/invoice-inbox/items/:id/convert',
    // The Inkorg's "Redan betald" registers a new supplier invoice and settles it in one step.
    'POST /api/inkorg/items/:id/register-and-settle',
    'POST /api/supplier-invoices',
    'POST /api/v1/companies/:companyId/supplier-invoices',
    'op:inbox-items.convert-to-supplier-invoice',
    'mcp:gnubok_create_supplier_invoice_from_inbox',
    'mcp:gnubok_register_booked_supplier_invoice',
    'pending:create_supplier_invoice_from_inbox',
  ],
  continue: [
    'POST /api/attest/:token/decision',
    'POST /api/betala/:token/signing',
    'POST /api/betala/:token/signing/:id/poll',
    'POST /api/betala/:token/signing/:id/restart',
    'POST /api/payments/allowance-requests',
    'POST /api/payments/orders',
    'POST /api/payments/orders/:id/cancel',
    'POST /api/payments/orders/:id/resolve',
    'POST /api/payments/orders/approve',
    'POST /api/payments/orders/skattekonto',
    'POST /api/payments/orders/unapprove',
    'POST /api/payments/signing',
    'POST /api/payments/signing-links',
    'DELETE /api/payments/signing-links/:id',
    'POST /api/payments/signing/:id/poll',
    'POST /api/payments/signing/:id/restart',
    'POST /api/payments/verification',
    'DELETE /api/supplier-invoices/:id',
    'PUT /api/supplier-invoices/:id',
    'POST /api/supplier-invoices/:id/approve',
    'POST /api/supplier-invoices/:id/bank-entered',
    'POST /api/supplier-invoices/:id/book',
    'POST /api/supplier-invoices/:id/credit',
    'PATCH /api/supplier-invoices/:id/items/:itemId',
    'POST /api/supplier-invoices/:id/link-to-voucher',
    'POST /api/supplier-invoices/:id/mark-paid',
    'POST /api/supplier-invoices/:id/payee',
    'POST /api/supplier-invoices/:id/reject',
    'POST /api/supplier-invoices/:id/uncredit',
    'PUT /api/supplier-invoices/attest-policy',
    'PUT /api/supplier-invoices/attest-policy/mail',
    'POST /api/supplier-invoices/payment-batches',
    'POST /api/supplier-invoices/payment-batches/:id/cancel',
    'POST /api/supplier-invoices/payment-batches/preview',
    'POST /api/suppliers',
    'DELETE /api/suppliers/:id',
    'PUT /api/suppliers/:id',
    'PATCH /api/v1/companies/:companyId/supplier-invoices/:id',
    'POST /api/v1/companies/:companyId/supplier-invoices/:id/approve',
    'POST /api/v1/companies/:companyId/supplier-invoices/:id/credit',
    'POST /api/v1/companies/:companyId/supplier-invoices/:id/mark-paid',
    'DELETE /api/v1/companies/:companyId/suppliers/:id',
    'POST /api/v1/companies/:companyId/suppliers/bulk-create',
    'op:payment-orders.approve',
    'op:payment-orders.cancel',
    'op:payment-orders.prepare',
    'op:payment-orders.unapprove',
    'op:payment-signing-links.create',
    'op:payments.verification-start',
    'op:supplier-invoices.attest-policy.update',
    'op:supplier-invoices.book',
    'op:supplier-invoices.delete',
    'op:supplier-invoices.mark-bank-entered',
    'op:supplier-invoices.reject',
    'op:supplier-invoices.uncredit',
    'op:supplier-invoices.update-item-account',
    'op:supplier-payees.confirm',
    'op:supplier-payment-batches.cancel',
    'op:supplier-payment-batches.create',
    'op:supplier-payment-batches.preview',
    'op:suppliers.create',
    'op:suppliers.update',
    'mcp:gnubok_approve_supplier_invoice',
    'mcp:gnubok_create_supplier',
    'mcp:gnubok_credit_supplier_invoice',
    'mcp:gnubok_link_supplier_invoice_to_voucher',
  ],
}

const RECEIPTS_AND_DOCUMENTS: PackageDoors = {
  start: [
    'POST /api/digital-mailboxes/:provider/receive',
    'POST /api/extensions/ext/mail/oauth/start',
    // A supplier portal is a new way in for underlag, as a connected mailbox is.
    'POST /api/inkorg/portals',
  ],
  continue: [
    'DELETE /api/digital-mailboxes/:provider/receive',
    'POST /api/digital-mailboxes/:provider/send',
    'DELETE /api/digital-mailboxes/:provider/send',
    'POST /api/digital-mailboxes/:provider/sync',
    'POST /api/arkiv/facts/:id/revert',
    'POST /api/arkiv/findings/:id',
    'PATCH /api/inkorg/portals/:id',
    'DELETE /api/inkorg/portals/:id',
    'POST /api/extensions/ext/invoice-inbox/inbox/rotate',
    'DELETE /api/extensions/ext/invoice-inbox/items/:id',
    'POST /api/extensions/ext/invoice-inbox/items/:id/book-direct',
    'PATCH /api/extensions/ext/invoice-inbox/items/:id/fields',
    'POST /api/extensions/ext/invoice-inbox/items/:id/match-transaction',
    'PUT /api/extensions/ext/invoice-inbox/items/:id/purchase-category',
    'POST /api/extensions/ext/invoice-inbox/items/:id/retry-extraction',
    'POST /api/extensions/ext/invoice-inbox/items/:id/suggest-booking',
    'POST /api/extensions/ext/invoice-inbox/items/:id/unmatch-transaction',
    'POST /api/extensions/ext/invoice-inbox/items/bulk-book',
    'POST /api/extensions/ext/invoice-inbox/upload',
    'POST /api/extensions/ext/invoice-inbox/upload/complete',
    'POST /api/extensions/ext/invoice-inbox/upload/create',
    // The receipt that came with an invoice lands on the invoice's booking: it starts nothing new.
    'POST /api/inkorg/items/:id/companion',
    // The one click books the item as book-direct does, and registers a
    // supplier invoice only while Leverantörsfakturor is on (its plan reads
    // the switch): it starts nothing a switched-off package would refuse.
    'POST /api/inkorg/items/:id/book',
    'DELETE /api/extensions/ext/mail/connections',
    'POST /api/extensions/ext/whatsapp-inbox/link/default-company',
    'POST /api/extensions/ext/whatsapp-inbox/link/revoke',
    'POST /api/extensions/ext/whatsapp-inbox/link/start',
    'POST /api/extensions/ext/whatsapp-inbox/link/unmute',
    'POST /api/receipt-hunt/run',
    'POST /api/v1/companies/:companyId/inbox-items',
    'POST /api/v1/companies/:companyId/inbox-items/:id/stamp',
    'op:inbox-items.delete',
    'op:inbox-items.match-supplier',
    'op:inbox-items.match-transaction',
    'op:inbox-items.set-purchase-category',
    'op:inbox-items.unmatch-transaction',
    'op:inbox-items.update-extracted-data',
    'mcp:gnubok_bulk_book_inbox_items',
    'mcp:gnubok_complete_document_upload',
    'mcp:gnubok_create_document_upload',
    'mcp:gnubok_propose_fact',
    'mcp:gnubok_resolve_missing',
    'mcp:gnubok_set_inbox_extracted_data',
    'mcp:gnubok_upload_document',
  ],
}

const EXPENSES: PackageDoors = {
  start: [
    'POST /api/expense-claims',
    'POST /api/mileage/trips',
    'op:expense-claims.create',
    'mcp:gnubok_log_mileage_trip',
    'pending:log_mileage_trip',
  ],
  continue: [
    'DELETE /api/expense-claims/:id',
    'POST /api/expense-claims/payouts',
    'POST /api/expense-claims/suggest-template',
    'POST /api/mileage/book',
    'POST /api/mileage/salary-push',
    'DELETE /api/mileage/trips/:id',
    'PATCH /api/mileage/trips/:id',
    'op:expense-claims.delete',
    'op:expense-claims.record-payout',
    'mcp:gnubok_book_mileage_period',
  ],
}

const PAYROLL: PackageDoors = {
  start: [
    'POST /api/salary/runs',
    'POST /api/v1/companies/:companyId/salary-runs',
    'mcp:gnubok_create_salary_run',
    'pending:create_salary_run',
  ],
  continue: [
    'POST /api/salary/employees',
    'DELETE /api/salary/employees/:id',
    'PATCH /api/salary/employees/:id',
    'DELETE /api/salary/employees/:id/absence',
    'POST /api/salary/employees/:id/absence',
    'POST /api/salary/employees/:id/benefits',
    'DELETE /api/salary/employees/:id/benefits/:benefitId',
    'PATCH /api/salary/employees/:id/benefits/:benefitId',
    'PUT /api/salary/employees/:id/opening-balances',
    'POST /api/salary/employees/:id/recurring-lines',
    'DELETE /api/salary/employees/:id/recurring-lines/:lineId',
    'PATCH /api/salary/employees/:id/recurring-lines/:lineId',
    'DELETE /api/salary/employees/:id/worked-hours',
    'POST /api/salary/employees/:id/worked-hours',
    'POST /api/salary/employees/:id/worked-hours/batch',
    'DELETE /api/salary/runs/:id',
    'PATCH /api/salary/runs/:id',
    'POST /api/salary/runs/:id/approve',
    'POST /api/salary/runs/:id/book',
    'POST /api/salary/runs/:id/calculate',
    'POST /api/salary/runs/:id/correct',
    'POST /api/salary/runs/:id/employees',
    'DELETE /api/salary/runs/:id/employees/:employeeId',
    'PATCH /api/salary/runs/:id/employees/:employeeId',
    'POST /api/salary/runs/:id/employees/:employeeId/expense-claims',
    'POST /api/salary/runs/:id/lines',
    'DELETE /api/salary/runs/:id/lines/:lineId',
    'PATCH /api/salary/runs/:id/lines/:lineId',
    'POST /api/salary/runs/:id/paid',
    'POST /api/salary/runs/:id/payment/pain001',
    'POST /api/salary/runs/:id/payslips/send',
    'POST /api/salary/runs/:id/revert',
    'POST /api/salary/runs/:id/review',
    'POST /api/salary/runs/:id/unapprove',
    'POST /api/v1/companies/:companyId/employees',
    'PATCH /api/v1/companies/:companyId/employees/:id',
    'DELETE /api/v1/companies/:companyId/employees/:id/absence',
    'PUT /api/v1/companies/:companyId/employees/:id/absence',
    'PUT /api/v1/companies/:companyId/employees/:id/opening-balances',
    'PUT /api/v1/companies/:companyId/employees/opening-balances',
    'DELETE /api/v1/companies/:companyId/salary-runs/:id',
    'PATCH /api/v1/companies/:companyId/salary-runs/:id',
    'POST /api/v1/companies/:companyId/salary-runs/:id/approve',
    'POST /api/v1/companies/:companyId/salary-runs/:id/book',
    'POST /api/v1/companies/:companyId/salary-runs/:id/calculate',
    'PATCH /api/v1/companies/:companyId/salary-runs/:id/employees/:employeeId',
    'POST /api/v1/companies/:companyId/salary-runs/:id/generate-agi',
    'PATCH /api/v1/companies/:companyId/salary-runs/:id/lines/:lineId',
    'POST /api/v1/companies/:companyId/salary-runs/:id/payment-file',
    'PATCH /api/v1/companies/:companyId/salary/settings',
    'POST /api/v1/companies/:companyId/salary/vacation-year-close',
    'op:agi-filings.mark',
    'op:employees.benefits.create',
    'op:employees.benefits.delete',
    'op:employees.benefits.update',
    'op:employees.delete',
    'op:employees.recurring-lines.create',
    'op:employees.recurring-lines.delete',
    'op:employees.recurring-lines.update',
    'op:employees.worked-days.delete',
    'op:employees.worked-days.upsert',
    'op:salary-runs.attach-expense-claims',
    'op:salary-runs.correct',
    'op:salary-runs.employees.add',
    'op:salary-runs.employees.remove',
    'op:salary-runs.lines.create',
    'op:salary-runs.lines.delete',
    'op:salary-runs.mark-paid',
    'op:salary-runs.revert',
    'op:salary-runs.send-payslips',
    'op:salary-runs.unapprove',
    'mcp:gnubok_book_salary_run',
    'mcp:gnubok_calculate_salary_run',
    'mcp:gnubok_close_vacation_year',
    'mcp:gnubok_create_employee',
    'mcp:gnubok_delete_absence',
    'mcp:gnubok_generate_agi',
    'mcp:gnubok_register_absence',
    'mcp:gnubok_set_employee_opening_balances',
    'mcp:gnubok_set_run_salary',
    'mcp:gnubok_update_employee',
    'mcp:gnubok_update_payslip_line',
    'mcp:gnubok_update_salary_run',
  ],
}

const ASSETS: PackageDoors = {
  start: [
    'POST /api/assets',
    'POST /api/v1/companies/:companyId/assets',
    'mcp:gnubok_create_asset',
    'pending:create_asset',
  ],
  continue: [
    'DELETE /api/assets/:id',
    'PATCH /api/assets/:id',
    'POST /api/assets/:id/dispose',
    'DELETE /api/v1/companies/:companyId/assets/:id',
    'PATCH /api/v1/companies/:companyId/assets/:id',
    'POST /api/v1/companies/:companyId/assets/:id/dispose',
    'mcp:gnubok_dispose_asset',
    'mcp:gnubok_post_annual_depreciation',
    'mcp:gnubok_update_asset',
  ],
}

const POS_AND_WEBSHOP: PackageDoors = {
  start: [
    'POST /api/extensions/ext/shopify/connect',
    'POST /api/extensions/ext/woocommerce/connect',
    'POST /api/extensions/ext/woocommerce/manual-connect',
    'POST /api/extensions/ext/zettle/connect',
    'POST /api/pos-sales/connections',
    'op:pos-sales.connect',
  ],
  continue: [
    'POST /api/extensions/ext/shopify/backfill',
    'DELETE /api/extensions/ext/shopify/disconnect',
    'POST /api/extensions/ext/shopify/sync',
    'POST /api/extensions/ext/shopify/transaction-sync',
    'POST /api/extensions/ext/woocommerce/backfill',
    'DELETE /api/extensions/ext/woocommerce/disconnect',
    'POST /api/extensions/ext/woocommerce/sync',
    'POST /api/extensions/ext/woocommerce/transaction-sync',
    'POST /api/extensions/ext/zettle/backfill',
    'DELETE /api/extensions/ext/zettle/disconnect',
    'POST /api/extensions/ext/zettle/sync',
    'POST /api/extensions/ext/zettle/transaction-sync',
    'POST /api/pos-sales/connections/:id/disconnect',
    'PATCH /api/pos-sales/connections/:id/settings',
    'POST /api/pos-sales/days/:id/book',
    'POST /api/pos-sales/fetch',
    'POST /api/webshop-orders/:id/book',
    'DELETE /api/webshop-orders/:id/mark-booked',
    'POST /api/webshop-orders/:id/mark-booked',
    'POST /api/webshop-orders/:id/underlag',
    'POST /api/webshop-orders/bulk-book',
    'PUT /api/webshop-orders/settings',
    'op:pos-sales.day-book',
    'op:pos-sales.disconnect',
    'op:pos-sales.fetch',
    'op:pos-sales.update-settings',
    'op:webshop-orders.book',
  ],
}
/** Every switchable package's doors. */
export const PACKAGE_DOORS: Readonly<Record<SwitchablePackageId, PackageDoors>> = Object.freeze({
  bank: BANK,
  'customer-invoices': CUSTOMER_INVOICES,
  'supplier-invoices-and-payments': SUPPLIER_INVOICES_AND_PAYMENTS,
  'receipts-and-documents': RECEIPTS_AND_DOCUMENTS,
  expenses: EXPENSES,
  payroll: PAYROLL,
  assets: ASSETS,
  'pos-and-webshop': POS_AND_WEBSHOP,
})

const START_PACKAGE = new Map<string, SwitchablePackageId>(
  (Object.entries(PACKAGE_DOORS) as Array<[SwitchablePackageId, PackageDoors]>).flatMap(([pkg, doors]) =>
    doors.start.map((key) => [key, pkg] as const),
  ),
)

/** The package a door key starts work in, or null when the door is not a start. */
export function startPackageForKey(key: string): SwitchablePackageId | null {
  return START_PACKAGE.get(key) ?? null
}

interface RoutePattern {
  method: string
  segments: string[]
  pkg: SwitchablePackageId
}

/** The start doors that are routes, split for matching a concrete path against them. */
const START_ROUTES: readonly RoutePattern[] = [...START_PACKAGE.entries()]
  .filter(([key]) => /^(POST|PUT|PATCH|DELETE) \//.test(key))
  .map(([key, pkg]) => {
    const [method, path] = key.split(' ')
    return { method, segments: path.split('/').filter(Boolean), pkg }
  })

function matches(pattern: readonly string[], path: readonly string[]): boolean {
  if (pattern.length !== path.length) return false
  return pattern.every((seg, i) => seg.startsWith(':') || seg === path[i])
}

/**
 * The package a request to a dashboard route starts work in, from its method
 * and its concrete path (`/api/invoices/abc/convert` matches
 * 'POST /api/invoices/:id/convert'). A static start route wins over a
 * pattern of the same shape. Null for every route that is not a start,
 * which is nearly all of them: the match is a short in-memory scan.
 */
export function startPackageForSessionRequest(method: string, pathname: string): SwitchablePackageId | null {
  const path = pathname.split('/').filter(Boolean)
  let viaPattern: SwitchablePackageId | null = null
  for (const route of START_ROUTES) {
    if (route.method !== method || !matches(route.segments, path)) continue
    if (route.segments.every((seg) => !seg.startsWith(':'))) return route.pkg
    viaPattern ??= route.pkg
  }
  return viaPattern
}

/**
 * The package a v1 endpoint starts work in: by its operation when the
 * endpoint is an operation's door, else by its method and path.
 */
export function startPackageForV1Endpoint(endpoint: { method: string; path: string; operation?: string }): SwitchablePackageId | null {
  return (endpoint.operation ? startPackageForKey(`op:${endpoint.operation}`) : null) ?? startPackageForKey(`${endpoint.method} ${endpoint.path}`)
}

/**
 * The package an MCP tool starts work in: a hand-written tool by its name, a
 * generated tool by the operation it was generated from.
 */
export function startPackageForTool(name: string, operationId?: string | null): SwitchablePackageId | null {
  return startPackageForKey(`mcp:${name}`) ?? (operationId ? startPackageForKey(`op:${operationId}`) : null)
}

/**
 * The package approving a pending operation of this type starts work in: a
 * hand-written tool's type by name, an operation's by the operation.
 */
export function startPackageForPendingType(type: string, operationId?: string | null): SwitchablePackageId | null {
  return startPackageForKey(`pending:${type}`) ?? (operationId ? startPackageForKey(`op:${operationId}`) : null)
}

/** Every package that has at least one start door: all switchable ones (the guard test). */
export function packagesWithStartDoors(): PackageId[] {
  return [...new Set(START_PACKAGE.values())]
}
