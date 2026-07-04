/**
 * Auto-generated API reference pages.
 *
 * Iterates lib/api/v1/registry.ts ENDPOINTS, groups by resource (derived
 * from the URL path), and renders one Markdown page per resource. Stripe-
 * style: each endpoint section has the description, useWhen, doNotUseFor,
 * pitfalls, scope, idempotent/reversible/dryRun flags, and a worked example.
 *
 * To make this work, every v1 route file needs to import-side-effect call
 * registerEndpoint(): which they all do at module load time. The doc
 * builder triggers that load via lib/api/v1/load-routes.ts.
 *
 * Adding a new endpoint means editing the route file's registerEndpoint
 * call; the docs then surface it on the next build with no manual sync.
 */

import { listEndpoints, type EndpointDefinition, type HttpMethod } from '@/lib/api/v1/registry'
// Side-effect import: every v1 route file's top-level registerEndpoint()
// call runs as a result of loading this module, populating the shared
// ENDPOINTS map that listEndpoints() reads from.
import '@/lib/api/v1/load-routes'

interface ResourceGroup {
  /** URL slug, used in /docs/api/reference/{slug}. */
  slug: string
  /** Display label for headings + nav. */
  label: string
  /** One-line description for the resource landing card. */
  description: string
  /** URL pattern segment that identifies endpoints belonging to this resource. */
  matcher: (path: string) => boolean
}

const RESOURCES: ResourceGroup[] = [
  { slug: 'companies', label: 'Companies', description: 'List and read companies the API key can access.', matcher: (p) => /\/companies(?:\/:companyId)?$/.test(p) },
  { slug: 'customers', label: 'Customers', description: 'CRM-side: who you invoice. Business and individual (sole-trader) customers with VIES validation.', matcher: (p) => /\/customers(\/|$)/.test(p) },
  { slug: 'invoices', label: 'Invoices', description: 'Outbound invoicing: draft, send, mark paid, credit, PDF download. Mixed-rate VAT supported.', matcher: (p) => /\/invoices(\/|$)/.test(p) },
  { slug: 'suppliers', label: 'Suppliers', description: 'AP-side counterparties. Mirrors customers on the supplier vertical.', matcher: (p) => /\/suppliers(\/|$)/.test(p) },
  { slug: 'supplier-invoices', label: 'Supplier invoices', description: 'AP lifecycle: register, approve, mark paid, credit. With ROT/RUT and reverse-charge support.', matcher: (p) => /\/supplier-invoices(\/|$)/.test(p) },
  { slug: 'transactions', label: 'Transactions', description: 'Bank transactions: ingest, categorise, match to invoices, reconcile.', matcher: (p) => /\/transactions(\/|$)/.test(p) },
  { slug: 'reconciliation', label: 'Reconciliation', description: 'Run bank-to-ledger reconciliation and read the current matching status.', matcher: (p) => /\/reconciliation(\/|$)/.test(p) },
  { slug: 'journal-entries', label: 'Journal entries', description: 'The bookkeeping engine surface: verifikation lifecycle (draft, commit, reverse, correct).', matcher: (p) => /\/journal-entries(\/|$)/.test(p) },
  { slug: 'voucher-gap-explanations', label: 'Voucher gap explanations', description: 'Documented explanations for gaps in the voucher series, per BFNAR 2013:2.', matcher: (p) => /\/voucher-gap/.test(p) },
  { slug: 'fiscal-periods', label: 'Fiscal periods', description: 'Period lifecycle: lock, close, year-end, opening balances, FX revaluation. Async via the operations substrate.', matcher: (p) => /\/fiscal-periods(\/|$)/.test(p) },
  { slug: 'accounts', label: 'Accounts', description: 'Read the chart of accounts (BAS).', matcher: (p) => /\/accounts(\/|$)/.test(p) },
  { slug: 'documents', label: 'Documents', description: 'Multipart upload, signed-URL download (15-min TTL), link to journal entries.', matcher: (p) => /\/documents(\/|$)/.test(p) },
  { slug: 'employees', label: 'Employees', description: 'Payroll roster: CRUD with personnummer masking on list endpoints.', matcher: (p) => /\/employees(\/|$)/.test(p) },
  { slug: 'salary-runs', label: 'Salary runs', description: 'Payroll lifecycle: create, calculate, approve, mark paid, book, generate AGI XML.', matcher: (p) => /\/salary-runs(\/|$)/.test(p) },
  { slug: 'reports', label: 'Reports', description: 'Read-only reports: trial balance, P&L, balance sheet, GL, VAT, salary journal, SIE export, +9 more.', matcher: (p) => /\/reports(\/|$)/.test(p) },
  { slug: 'imports', label: 'Imports', description: 'Bulk async ingest: SIE files (Fortnox/Visma/BL/SpeedLedger/Bokio migrations) and bank statements (11 formats).', matcher: (p) => /\/imports(\/|$)/.test(p) },
  { slug: 'compliance', label: 'Compliance check', description: 'Pre-flight verification: voucher gaps, year-end readiness, before submitting to Skatteverket.', matcher: (p) => /\/compliance(\/|$)/.test(p) },
  { slug: 'webhooks', label: 'Webhooks', description: 'Subscribe to events with HMAC-signed delivery, exponential retries, and dead-letter replay.', matcher: (p) => /\/webhooks|\/webhook-deliveries/.test(p) },
  { slug: 'operations', label: 'Operations', description: 'Poll long-running async operations (year-end closing, imports, currency revaluation).', matcher: (p) => /\/operations(\/|$)/.test(p) },
]

/** Discover the resource a given endpoint path belongs to. Returns null if it doesn't fit any. */
function classifyEndpoint(path: string): ResourceGroup | null {
  for (const r of RESOURCES) {
    if (r.matcher(path)) return r
  }
  return null
}

export interface BuiltResourcePage {
  slug: string
  label: string
  description: string
  endpoints: EndpointDefinition[]
  markdown: string
}

const METHOD_ORDER: Record<HttpMethod, number> = { GET: 0, POST: 1, PATCH: 2, PUT: 3, DELETE: 4 }

function endpointAnchor(ep: EndpointDefinition): string {
  return `${ep.method.toLowerCase()}-${ep.operation.replace(/\./g, '-')}`
}

function renderEndpoint(ep: EndpointDefinition): string {
  const lines: string[] = []
  const methodBadge = ep.method
  lines.push(`### \`${methodBadge}\` ${ep.path} {#${endpointAnchor(ep)}}`)
  lines.push('')
  lines.push(`**\`${ep.operation}\`**${ep.scope ? ` · scope \`${ep.scope}\`` : ' · public'}`)
  lines.push('')
  lines.push(ep.summary)
  lines.push('')
  lines.push(ep.description)
  lines.push('')
  lines.push(`**Use when:** ${ep.useWhen}`)
  lines.push('')
  lines.push(`**Don't use for:** ${ep.doNotUseFor}`)
  lines.push('')
  if (ep.pitfalls.length > 0) {
    lines.push('**Pitfalls**')
    for (const p of ep.pitfalls) lines.push(`- ${p}`)
    lines.push('')
  }
  const flags: string[] = []
  flags.push(`**Risk:** ${ep.risk}`)
  flags.push(`**Idempotent:** ${ep.idempotent ? 'yes' : 'no'}`)
  flags.push(`**Reversible:** ${ep.reversible ? 'yes' : 'no'}`)
  flags.push(`**Dry-run supported:** ${ep.dryRunSupported ? 'yes' : 'no'}`)
  lines.push(flags.join(' · '))
  lines.push('')
  if (ep.example.request) {
    lines.push('**Example request**')
    lines.push('')
    lines.push('```json')
    lines.push(JSON.stringify(ep.example.request, null, 2))
    lines.push('```')
    lines.push('')
  }
  lines.push('**Example response**')
  lines.push('')
  lines.push('```json')
  lines.push(JSON.stringify(ep.example.response, null, 2))
  lines.push('```')
  lines.push('')
  return lines.join('\n')
}

// Module-level memoisation. The endpoint registry is populated once at
// module load (via the side-effect import of load-routes) and is then
// immutable for the process lifetime. The Markdown serialisation is
// pure derivation: reusing a single result avoids repeated work on the
// .md route handlers (which Next.js doesn't statically pre-render) AND
// halves the cost on each generateMetadata + page render pair on the
// HTML routes. (Greptile P2, round 1.)
let cachedPages: BuiltResourcePage[] | null = null

export function buildResourcePages(): BuiltResourcePage[] {
  if (cachedPages) return cachedPages

  const all = listEndpoints()
  const byResource = new Map<string, EndpointDefinition[]>()
  for (const ep of all) {
    const r = classifyEndpoint(ep.path)
    if (!r) continue
    if (!byResource.has(r.slug)) byResource.set(r.slug, [])
    byResource.get(r.slug)!.push(ep)
  }

  const pages = RESOURCES.map((r) => {
    const endpoints = (byResource.get(r.slug) ?? []).sort((a, b) => {
      const m = METHOD_ORDER[a.method] - METHOD_ORDER[b.method]
      if (m !== 0) return m
      return a.path.localeCompare(b.path)
    })

    const lines: string[] = []
    lines.push(`# ${r.label}`)
    lines.push('')
    lines.push(`> ${r.description}`)
    lines.push('')

    if (endpoints.length === 0) {
      lines.push('*No endpoints registered yet for this resource.*')
    } else {
      lines.push('## Endpoints')
      lines.push('')
      for (const ep of endpoints) {
        lines.push(`- [\`${ep.method}\` \`${ep.path}\`](#${endpointAnchor(ep)}): ${ep.summary}`)
      }
      lines.push('')
      lines.push('---')
      lines.push('')
      for (const ep of endpoints) {
        lines.push(renderEndpoint(ep))
        lines.push('---')
        lines.push('')
      }
    }

    return {
      slug: r.slug,
      label: r.label,
      description: r.description,
      endpoints,
      markdown: lines.join('\n'),
    }
  })

  cachedPages = pages
  return pages
}

export function buildReferenceOverviewMd(): string {
  const lines: string[] = []
  lines.push('# API reference')
  lines.push('')
  lines.push(`> Every endpoint exposed by the Accounted REST API, grouped by resource. Auto-generated from the same Zod registry that powers the [OpenAPI 3.1 spec](/api/v1/openapi.json), the MCP tool surface, and runtime validators: there is no separate doc-source to keep in sync.`)
  lines.push('')
  lines.push('## Resources')
  lines.push('')
  for (const r of RESOURCES) {
    lines.push(`### [${r.label}](/docs/api/reference/${r.slug})`)
    lines.push('')
    lines.push(r.description)
    lines.push('')
  }
  return lines.join('\n')
}

export const RESOURCE_SLUGS = RESOURCES.map((r) => r.slug)
