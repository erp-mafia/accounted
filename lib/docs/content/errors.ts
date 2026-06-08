/**
 * /docs/api/errors content — generated from the STRUCTURED_ERRORS registry.
 *
 * The registry lives in lib/errors/structured-errors.ts; we re-import it here
 * and build a Stripe-style catalogue page where every code is anchorable
 * (the docs_url field on every error envelope already points at this page).
 *
 * Adding a new error code in the registry automatically surfaces here on the
 * next build — no manual edits to keep in sync.
 */

import { listErrorCodes, getErrorEntry } from '@/lib/errors/structured-errors'

interface DomainGroup {
  label: string
  description: string
  /** Code prefix matchers — first match wins; codes without a match fall to 'Other'. */
  prefixes: string[]
}

const DOMAINS: DomainGroup[] = [
  { label: 'Generic', description: 'Cross-cutting codes returned by any endpoint.', prefixes: ['UNKNOWN_', 'INTERNAL_', 'VALIDATION_', 'UNAUTHORIZED', 'MFA_', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'RATE_LIMITED', 'NOT_IMPLEMENTED', 'COMPANY_CONTEXT_', 'IDEMPOTENCY_', 'INSUFFICIENT_SCOPE'] },
  { label: 'Bookkeeping engine', description: 'Errors from the journal-entry lifecycle (create, commit, reverse, correct).', prefixes: ['BOOKKEEPING_', 'JOURNAL_', 'VOUCHER_'] },
  { label: 'Periods + year-end', description: 'Fiscal period locking, year-end closing, opening balances, FX revaluation.', prefixes: ['PERIOD_', 'YEAR_END_', 'OPENING_BALANCE_', 'FX_'] },
  { label: 'Invoices', description: 'Customer invoice lifecycle: draft, send, mark paid, credit.', prefixes: ['INVOICE_', 'CREDIT_NOTE_', 'CUSTOMER_'] },
  { label: 'Supplier invoices', description: 'AP lifecycle: register, approve, mark paid, credit.', prefixes: ['SUPPLIER_INVOICE_', 'SUPPLIER_'] },
  { label: 'Transactions', description: 'Bank transaction ingest, categorisation, matching.', prefixes: ['TRANSACTION_', 'MATCH_INVOICE_', 'MATCH_SI_', 'MATCH_'] },
  { label: 'Reports', description: 'Report generation: VAT declaration, periodisk sammanställning, SIE export, INK2.', prefixes: ['REPORT_', 'VAT_', 'PS_', 'SIE_EXPORT_', 'TAX_DECL_'] },
  { label: 'Imports', description: 'SIE import, bank file import, opening-balance import, provider migration.', prefixes: ['SIE_IMPORT_', 'BANK_FILE_', 'OPENING_BALANCE_IMPORT_', 'REGISTER_IMPORT_', 'PROVIDER_MIGRATION_'] },
  { label: 'Documents', description: 'Document upload, link, signed-URL download, retention.', prefixes: ['DOCUMENT_'] },
  { label: 'Salary + AGI', description: 'Payroll lifecycle, AGI generation, KU declarations.', prefixes: ['SALARY_', 'AGI_', 'KU_', 'EMPLOYEE_'] },
  { label: 'Company + API keys', description: 'Multi-tenant + auth lifecycle.', prefixes: ['COMPANY_', 'API_KEY_'] },
  { label: 'Provider connections', description: 'External provider OAuth, sync, consent.', prefixes: ['PROVIDER_'] },
]

function classify(code: string): string {
  for (const group of DOMAINS) {
    for (const prefix of group.prefixes) {
      if (code.startsWith(prefix)) return group.label
    }
  }
  return 'Other'
}

function statusLabel(status: number): string {
  switch (status) {
    case 400: return 'Bad request'
    case 401: return 'Unauthorized'
    case 403: return 'Forbidden'
    case 404: return 'Not found'
    case 409: return 'Conflict'
    case 422: return 'Unprocessable'
    case 429: return 'Rate limited'
    case 500: return 'Server error'
    case 501: return 'Not implemented'
    default: return ''
  }
}

export function buildErrorReferenceMd(): string {
  const codes = listErrorCodes().sort()
  const grouped = new Map<string, string[]>()

  for (const code of codes) {
    const domain = classify(code)
    if (!grouped.has(domain)) grouped.set(domain, [])
    grouped.get(domain)!.push(code)
  }

  // Render groups in the order DOMAINS declares, with Other last.
  const orderedLabels = [...DOMAINS.map((d) => d.label), 'Other']

  const lines: string[] = []
  lines.push('# Errors')
  lines.push('')
  lines.push(`> Every error returned by the Accounted REST API uses a stable code from this catalogue. Codes never change once shipped — agents can pattern-match on them safely. The \`docs_url\` field on every error envelope points at the anchor for that specific code.`)
  lines.push('')
  lines.push('## Envelope shape')
  lines.push('')
  lines.push('```json')
  lines.push('{')
  lines.push('  "error": {')
  lines.push('    "code": "PERIOD_LOCKED",')
  lines.push('    "message": "Den valda perioden är låst.",')
  lines.push('    "message_en": "The selected period is locked.",')
  lines.push('    "remediation": {')
  lines.push('      "description": "Unlock via /fiscal-periods/{id}/unlock or pick an open period.",')
  lines.push('      "tool": "fiscal_periods.unlock"')
  lines.push('    },')
  lines.push('    "details": { "fiscal_period_id": "..." },')
  lines.push('    "docs_url": "https://app.gnubok.se/docs/api/errors#period_locked"')
  lines.push('  },')
  lines.push('  "meta": { "request_id": "req_...", "api_version": "..." }')
  lines.push('}')
  lines.push('```')
  lines.push('')
  lines.push(`The \`message\` field is Swedish (matches the dashboard); \`message_en\` is English (for agent and developer logs); \`remediation\` (when present) hints at the canonical fix and may include a \`tool\` reference into the MCP surface.`)
  lines.push('')

  for (const label of orderedLabels) {
    const codes = grouped.get(label)
    if (!codes || codes.length === 0) continue
    const desc = DOMAINS.find((d) => d.label === label)?.description ?? ''

    lines.push(`## ${label}`)
    lines.push('')
    if (desc) {
      lines.push(`*${desc}*`)
      lines.push('')
    }

    for (const code of codes) {
      const entry = getErrorEntry(code)
      if (!entry) continue
      const status = entry.httpStatus
      const statusName = statusLabel(status)
      lines.push(`### ${code}`)
      lines.push('')
      lines.push(`**HTTP \`${status}\`**${statusName ? ` — ${statusName}` : ''}`)
      lines.push('')
      lines.push(`${entry.message_en}`)
      lines.push('')
      if (entry.message_sv) {
        lines.push(`**Swedish:** ${entry.message_sv}`)
        lines.push('')
      }
      if (entry.remediation) {
        lines.push(`**Remediation:** ${entry.remediation.description}`)
        if (entry.remediation.tool) {
          lines.push(`Related tool: \`${entry.remediation.tool}\``)
        }
        if (entry.remediation.resource) {
          lines.push(`Related resource: \`${entry.remediation.resource}\``)
        }
        lines.push('')
      }
    }
  }

  return lines.join('\n')
}
