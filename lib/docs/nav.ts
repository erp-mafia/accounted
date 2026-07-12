/**
 * Single source of truth for the /docs/api sidebar navigation.
 *
 * Stripe-pattern grouping: top-level sections (Getting started, Cookbooks,
 * API reference, Concepts, Errors, Changelog) with nested links. Used by
 * the DocsLayout sidebar AND by the landing page resource grid AND by the
 * /llms-full.txt aggregator so additions land in every surface from one
 * edit.
 */

export interface DocsNavLink {
  label: string
  href: string
  /** Optional one-line summary shown on landing-page cards. */
  summary?: string
}

export interface DocsNavSection {
  label: string
  links: DocsNavLink[]
}

export const DOCS_NAV: DocsNavSection[] = [
  {
    label: 'Getting started',
    links: [
      { label: 'Introduction', href: '/docs/api', summary: 'What the Accounted REST API is and how to authenticate.' },
      { label: 'Quickstart', href: '/docs/api/cookbook/quickstart', summary: 'Send your first invoice in five minutes.' },
      { label: 'Authentication', href: '/docs/api#authentication', summary: 'API keys, scopes, test mode.' },
      { label: 'Connect with Claude', href: '/docs/api/connect-claude', summary: 'Connect Claude via the MCP server: OAuth connector or npx gnubok-mcp bridge.' },
    ],
  },
  {
    label: 'Cookbooks',
    links: [
      { label: 'Send your first invoice', href: '/docs/api/cookbook/send-first-invoice', summary: 'Create a customer, draft an invoice, send it, mark it paid.' },
      { label: 'Ingest and categorise bank transactions', href: '/docs/api/cookbook/ingest-bank-transactions', summary: 'Push CSV/CAMT into the engine, get AI suggestions, commit.' },
      { label: 'Compute and review a VAT declaration', href: '/docs/api/cookbook/file-vat-declaration', summary: 'Compute momsdeklaration rutor 05-62 and reconcile before manual Skatteverket submission.' },
      { label: 'Run payroll and generate AGI', href: '/docs/api/cookbook/run-payroll-and-agi', summary: 'Calculate, approve, mark paid, book, generate AGI XML for manual Skatteverket upload.' },
      { label: 'Set up webhooks and verify signatures', href: '/docs/api/cookbook/webhooks', summary: 'Subscribe to events, verify HMAC, handle retries idempotently.' },
      { label: 'Year-end closing', href: '/docs/api/cookbook/year-end-closing', summary: 'Lock periods, run year-end, set opening balances.' },
    ],
  },
  {
    label: 'Concepts',
    links: [
      { label: 'Webhooks', href: '/docs/api/webhooks', summary: 'Event types, delivery model, retries, signature verification.' },
      { label: 'Versioning', href: '/docs/api/versioning', summary: 'How API versions are pinned, upgraded, and deprecated.' },
      { label: 'Idempotency', href: '/docs/api/versioning#idempotency', summary: 'Safe retries on every write via Idempotency-Key.' },
      { label: 'Dry-run', href: '/docs/api/versioning#dry-run', summary: 'Preview every write before committing.' },
    ],
  },
  {
    label: 'API reference',
    links: [
      { label: 'Overview', href: '/docs/api/reference', summary: 'All resources, grouped by domain.' },
      { label: 'Companies', href: '/docs/api/reference/companies' },
      { label: 'Customers', href: '/docs/api/reference/customers' },
      { label: 'Invoices', href: '/docs/api/reference/invoices' },
      { label: 'Articles', href: '/docs/api/reference/articles' },
      { label: 'Suppliers', href: '/docs/api/reference/suppliers' },
      { label: 'Supplier invoices', href: '/docs/api/reference/supplier-invoices' },
      { label: 'Transactions', href: '/docs/api/reference/transactions' },
      { label: 'Journal entries', href: '/docs/api/reference/journal-entries' },
      { label: 'Fiscal periods', href: '/docs/api/reference/fiscal-periods' },
      { label: 'Accounts', href: '/docs/api/reference/accounts' },
      { label: 'Documents', href: '/docs/api/reference/documents' },
      { label: 'Inbox items', href: '/docs/api/reference/inbox-items' },
      { label: 'Dimensions', href: '/docs/api/reference/dimensions' },
      { label: 'Employees', href: '/docs/api/reference/employees' },
      { label: 'Salary runs', href: '/docs/api/reference/salary-runs' },
      { label: 'Reports', href: '/docs/api/reference/reports' },
      { label: 'Imports', href: '/docs/api/reference/imports' },
      { label: 'Compliance check', href: '/docs/api/reference/compliance' },
      { label: 'Reconciliation', href: '/docs/api/reference/reconciliation' },
      { label: 'Webhooks', href: '/docs/api/reference/webhooks' },
      { label: 'Operations', href: '/docs/api/reference/operations' },
      { label: 'Voucher gap explanations', href: '/docs/api/reference/voucher-gap-explanations' },
    ],
  },
  {
    label: 'Reference',
    links: [
      { label: 'Errors', href: '/docs/api/errors', summary: 'Every stable error code, status, and remediation.' },
      { label: 'Changelog', href: '/docs/api/changelog', summary: 'Per-version release notes.' },
      { label: 'OpenAPI 3.1 spec', href: '/api/v1/openapi.json', summary: 'Machine-readable spec for client generation.' },
      { label: 'llms.txt', href: '/llms.txt', summary: 'Agent-discoverable index.' },
      { label: 'llms-full.txt', href: '/llms-full.txt', summary: 'Full docs concatenated for LLM ingestion.' },
    ],
  },
]
