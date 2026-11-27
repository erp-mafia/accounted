// AUTO-GENERATED: do not edit. Run `npm run crontabs:generate` to regenerate.
//
// Every job in the `crons` array of vercel.json with the maxDuration its route
// declares. scripts/__tests__/generate-crontabs.test.ts fails CI when this
// file drifts from vercel.json or from a route.

export interface ScheduledJob {
  /** The scheduled path, e.g. /api/payments/orders/status/cron. */
  path: string
  /** Five-field cron expression, UTC. */
  schedule: string
  /** The route's maxDuration: the platform kills a run that passes it. */
  maxDurationSeconds: number
}

export const SCHEDULED_JOBS: readonly ScheduledJob[] = [
  { path: '/api/import/sie/invariants/cron', schedule: '15 4 * * 1', maxDurationSeconds: 300 },
  { path: '/api/import/sie/worker/cron', schedule: '* * * * *', maxDurationSeconds: 300 },
  { path: '/api/deadlines/status/cron', schedule: '0 6 * * *', maxDurationSeconds: 300 },
  { path: '/api/invoices/recurring/cron', schedule: '0 * * * *', maxDurationSeconds: 300 },
  { path: '/api/settings/booking-templates/sync/cron', schedule: '30 4 * * *', maxDurationSeconds: 60 },
  { path: '/api/tax-deadlines/cron', schedule: '0 0 * * *', maxDurationSeconds: 300 },
  { path: '/api/extensions/enable-banking/sync/cron', schedule: '0 * * * *', maxDurationSeconds: 300 },
  { path: '/api/extensions/enable-banking/health-probe/cron', schedule: '30 4 * * *', maxDurationSeconds: 300 },
  { path: '/api/extensions/tic/budget/cron', schedule: '20 6 * * *', maxDurationSeconds: 300 },
  { path: '/api/bank/open-payments/sync/cron', schedule: '*/10 * * * *', maxDurationSeconds: 300 },
  { path: '/api/bank/open-payments/switch-reminders/cron', schedule: '30 6 * * *', maxDurationSeconds: 300 },
  { path: '/api/bank/open-payments/unended-consents/cron', schedule: '5 4 * * *', maxDurationSeconds: 300 },
  { path: '/api/extensions/stripe/transactions/cron', schedule: '30 3 * * *', maxDurationSeconds: 300 },
  { path: '/api/extensions/woocommerce/orders/cron', schedule: '45 3 * * *', maxDurationSeconds: 300 },
  { path: '/api/extensions/shopify/orders/cron', schedule: '15 3 * * *', maxDurationSeconds: 300 },
  { path: '/api/extensions/zettle/orders/cron', schedule: '30 3 * * *', maxDurationSeconds: 300 },
  { path: '/api/pos-sales/cron', schedule: '25 * * * *', maxDurationSeconds: 300 },
  { path: '/api/spend/cron', schedule: '*/5 * * * *', maxDurationSeconds: 300 },
  { path: '/api/documents/verify/cron', schedule: '0 3 * * *', maxDurationSeconds: 300 },
  { path: '/api/documents/reanchor/cron', schedule: '30 3 * * *', maxDurationSeconds: 120 },
  { path: '/api/sandbox/cleanup/cron', schedule: '0 4 * * *', maxDurationSeconds: 300 },
  { path: '/api/events/cleanup/cron', schedule: '0 2 * * *', maxDurationSeconds: 300 },
  { path: '/api/permissions/shadow-log/cleanup/cron', schedule: '15 2 * * *', maxDurationSeconds: 300 },
  { path: '/api/events/dispatch/cron', schedule: '* * * * *', maxDurationSeconds: 60 },
  { path: '/api/extensions/cloud-backup/auto-sync/cron', schedule: '0 * * * *', maxDurationSeconds: 300 },
  { path: '/api/idempotency/cleanup/cron', schedule: '30 * * * *', maxDurationSeconds: 300 },
  { path: '/api/pending-operations/expire/cron', schedule: '30 2 * * *', maxDurationSeconds: 300 },
  { path: '/api/extensions/skatteverket/ombud/sync/cron', schedule: '50 * * * *', maxDurationSeconds: 60 },
  { path: '/api/extensions/skatteverket/skattekonto/sync/cron', schedule: '0 * * * *', maxDurationSeconds: 120 },
  { path: '/api/extensions/skatteverket/agi/kvittenser/cron', schedule: '*/15 * * * *', maxDurationSeconds: 60 },
  { path: '/api/extensions/skatteverket/vat/kvittenser/cron', schedule: '30 */2 * * *', maxDurationSeconds: 60 },
  { path: '/api/webhooks/dispatch/cron', schedule: '* * * * *', maxDurationSeconds: 300 },
  { path: '/api/extensions/whatsapp-inbox/sweep/cron', schedule: '* * * * *', maxDurationSeconds: 300 },
  { path: '/api/extensions/whatsapp-inbox/retention/cron', schedule: '15 4 * * *', maxDurationSeconds: 300 },
  { path: '/api/extensions/invoice-inbox/sweep/cron', schedule: '*/2 * * * *', maxDurationSeconds: 300 },
  { path: '/api/extensions/invoice-inbox/underlag-reconcile/cron', schedule: '45 5 * * *', maxDurationSeconds: 300 },
  { path: '/api/extensions/arcim-migration/worker/cron', schedule: '* * * * *', maxDurationSeconds: 300 },
  { path: '/api/extensions/arcim-migration/document-import/cron', schedule: '* * * * *', maxDurationSeconds: 800 },
  { path: '/api/extensions/arcim-migration/complete-invoice-lines/cron', schedule: '20 * * * *', maxDurationSeconds: 300 },
  { path: '/api/extensions/arcim-migration/cleanup/cron', schedule: '*/5 * * * *', maxDurationSeconds: 300 },
  { path: '/api/extensions/arcim-migration/register-repair/cron', schedule: '*/5 * * * *', maxDurationSeconds: 300 },
  { path: '/api/extensions/arcim-migration/fortnox-topup/cron', schedule: '0 2,4 * * *', maxDurationSeconds: 800 },
  { path: '/api/bookkeeping/accruals/post-due/cron', schedule: '15 5 * * *', maxDurationSeconds: 300 },
  { path: '/api/bookkeeping/auto-lock/cron', schedule: '40 1 * * *', maxDurationSeconds: 300 },
  { path: '/api/receipt-hunt/cron', schedule: '30 5 * * *', maxDurationSeconds: 300 },
  { path: '/api/peppol/inbound/cron', schedule: '*/10 * * * *', maxDurationSeconds: 300 },
  { path: '/api/digital-mailboxes/cron', schedule: '3-59/10 * * * *', maxDurationSeconds: 300 },
  { path: '/api/billing/usage/cron', schedule: '0 6 1 * *', maxDurationSeconds: 300 },
  { path: '/api/agent/categorize/cron', schedule: '*/10 * * * *', maxDurationSeconds: 300 },
  { path: '/api/peppol/outbound/status/cron', schedule: '5,20,35,50 * * * *', maxDurationSeconds: 300 },
  { path: '/api/peppol/daily-report/cron', schedule: '0 5 * * *', maxDurationSeconds: 300 },
  { path: '/api/payments/orders/status/cron', schedule: '*/15 * * * *', maxDurationSeconds: 300 },
  { path: '/api/parties/resolver/cron', schedule: '45 5 * * *', maxDurationSeconds: 300 },
  { path: '/api/vendor-logos/cron', schedule: '20 * * * *', maxDurationSeconds: 300 },
  { path: '/api/documents/read/cron', schedule: '*/5 * * * *', maxDurationSeconds: 300 },
  { path: '/api/documents/classify/cron', schedule: '2-59/5 * * * *', maxDurationSeconds: 300 },
  { path: '/api/documents/jobs/cron', schedule: '* * * * *', maxDurationSeconds: 300 },
  { path: '/api/arkiv/derive/cron', schedule: '40 4 * * *', maxDurationSeconds: 300 },
  { path: '/api/arkiv/lint/cron', schedule: '10 5 * * *', maxDurationSeconds: 300 },
  { path: '/api/community/sync/cron', schedule: '23 * * * *', maxDurationSeconds: 60 },
  { path: '/api/collections/sync/cron', schedule: '*/10 * * * *', maxDurationSeconds: 300 },
  { path: '/api/collections/ladder/cron', schedule: '15 6 * * *', maxDurationSeconds: 300 },
  { path: '/api/reminders/batch/cron', schedule: '45 6 * * *', maxDurationSeconds: 300 },
  { path: '/api/reports/ledger-account-days/build/cron', schedule: '*/10 * * * *', maxDurationSeconds: 60 },
  { path: '/api/supplier-invoices/attest-mail/cron', schedule: '*/5 * * * *', maxDurationSeconds: 300 },
  { path: '/api/supplier-invoices/attest-mail/follow-up/cron', schedule: '15 6 * * *', maxDurationSeconds: 300 },
  { path: '/api/health/cron-runs/cron', schedule: '7-59/10 * * * *', maxDurationSeconds: 60 },
]
