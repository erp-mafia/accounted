/**
 * Single source of truth for the /docs/api sidebar navigation.
 *
 * Stripe-pattern grouping: top-level sections (Getting started, Cookbooks,
 * API reference, Concepts, Errors, Changelog) with nested links. Used by
 * the DocsLayout sidebar AND by the landing page resource grid AND by the
 * /llms-full.txt aggregator so additions land in every surface from one
 * edit.
 *
 * The reference pages are not listed here by hand: one sidebar section per
 * group in RESOURCE_NAV_GROUPS, holding every page of RESOURCES
 * (content/reference-resources.ts), so a new reference page cannot be left
 * out of the sidebar.
 */

import { RESOURCES, RESOURCE_NAV_GROUPS } from './content/reference-resources'

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

/** One sidebar section per reference group, its pages in alphabetical order. */
const REFERENCE_NAV_SECTIONS: DocsNavSection[] = RESOURCE_NAV_GROUPS.map((group) => ({
  label: group,
  links: RESOURCES.filter((r) => r.group === group)
    .map((r) => ({ label: r.label, href: `/docs/api/reference/${r.slug}`, summary: r.description }))
    .sort((a, b) => a.label.localeCompare(b.label)),
}))

/**
 * The reference pages the landing page shows as cards, before "See all":
 * the resources a first integration reaches for.
 */
const FEATURED_REFERENCE_SLUGS = ['companies', 'customers', 'invoices', 'suppliers', 'supplier-invoices', 'transactions', 'journal-entries', 'reports']

export const FEATURED_REFERENCE_LINKS: DocsNavLink[] = FEATURED_REFERENCE_SLUGS.map((slug) => {
  const resource = RESOURCES.find((r) => r.slug === slug)
  if (!resource) throw new Error(`featured reference page ${slug} is not in RESOURCES`)
  return { label: resource.label, href: `/docs/api/reference/${resource.slug}`, summary: resource.description }
})

export const DOCS_NAV: DocsNavSection[] = [
  {
    label: 'Getting started',
    links: [
      { label: 'Introduction', href: '/docs/api', summary: 'What the Accounted REST API is and how to authenticate.' },
      { label: 'Quickstart', href: '/docs/api/cookbook/quickstart', summary: 'Send your first invoice in five minutes.' },
      { label: 'Authentication', href: '/docs/api#authentication', summary: 'API keys, scopes, test mode.' },
      { label: 'Connect with Claude', href: '/docs/api/connect-claude', summary: 'Connect Claude via the MCP server: OAuth connector, Claude Code plugin, or npx accounted-mcp bridge.' },
      { label: 'Anslut Claude (svenska)', href: '/docs/api/anslut-claude', summary: 'Samma guide på svenska: OAuth-connector, Claude Code-plugin eller npx accounted-mcp.' },
      { label: 'Command line (CLI)', href: '/docs/api/cli', summary: 'Every Accounted tool from a terminal, a script, or a shell agent such as Claude Code, Codex or Cursor: npm install -g accounted.' },
      { label: 'Kommandoraden (svenska)', href: '/docs/api/kommandorad', summary: 'Samma guide på svenska: alla Accounted-verktyg från terminalen, skript och agenter med npm install -g accounted.' },
    ],
  },
  {
    label: 'Cookbooks',
    links: [
      { label: 'Send your first invoice', href: '/docs/api/cookbook/send-first-invoice', summary: 'Create a customer, draft an invoice, send it, mark it paid.' },
      { label: 'Ingest and categorise bank transactions', href: '/docs/api/cookbook/ingest-bank-transactions', summary: 'Push CSV/CAMT into the engine, categorise, match payments.' },
      { label: 'Compute and review a VAT declaration', href: '/docs/api/cookbook/file-vat-declaration', summary: 'Compute momsdeklaration rutor 05-62 and reconcile before manual Skatteverket submission.' },
      { label: 'Run payroll and generate AGI', href: '/docs/api/cookbook/run-payroll-and-agi', summary: 'Calculate, approve, mark paid, book, generate AGI XML for manual Skatteverket upload.' },
      { label: 'Onboard a payroll customer', href: '/docs/api/cookbook/onboard-payroll-customer', summary: 'Provision a company, settings, employees, cutover balances, monthly inputs, payment file.' },
      { label: 'Set up webhooks and verify signatures', href: '/docs/api/cookbook/webhooks', summary: 'Subscribe to events, verify HMAC, handle retries idempotently.' },
      { label: 'Year-end closing', href: '/docs/api/cookbook/year-end-closing', summary: 'Run the pre-flight checks, then one year-end call that closes the year and opens the next.' },
    ],
  },
  {
    label: 'Concepts',
    links: [
      { label: 'Webhooks', href: '/docs/api/webhooks', summary: 'Event types, delivery model, retries, signature verification.' },
      { label: 'Versioning', href: '/docs/api/versioning', summary: 'How API versions are pinned, upgraded, and deprecated.' },
      { label: 'Idempotency', href: '/docs/api/versioning#idempotency', summary: 'Safe retries on every write via Idempotency-Key.' },
      { label: 'Dry-run', href: '/docs/api/versioning#dry-run', summary: 'Preview a write before committing, where the endpoint supports it.' },
    ],
  },
  {
    label: 'API reference',
    links: [{ label: 'Overview', href: '/docs/api/reference', summary: 'All resources, grouped by domain.' }],
  },
  ...REFERENCE_NAV_SECTIONS,
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
