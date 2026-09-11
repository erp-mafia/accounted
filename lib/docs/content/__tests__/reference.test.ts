/**
 * The docs.accounted.se reference pages built from the v1 endpoint registry.
 *
 * Coverage (#2518): an endpoint whose path matched no RESOURCES entry was
 * dropped from every page without a sound (cash-accounts, bank-connections,
 * settings, skatteverket, vacation-year-close and health were missing). Every
 * registered endpoint must land on exactly one page, and no page may be empty.
 *
 * Tables (#2515): each endpoint section renders its query parameters, request
 * body and response fields from the same schemas the OpenAPI spec publishes.
 */

import { describe, expect, it } from 'vitest'
import { listEndpoints } from '@/lib/api/v1/registry'
import { buildResourcePages } from '../reference'

const pages = buildResourcePages()

function section(slug: string, operation: string): string {
  const page = pages.find((p) => p.slug === slug)
  expect(page, `page ${slug}`).toBeDefined()
  const start = page!.markdown.indexOf(`**\`${operation}\`**`)
  expect(start, `${operation} on ${slug}`).toBeGreaterThan(-1)
  const end = page!.markdown.indexOf('\n---\n', start)
  return page!.markdown.slice(start, end === -1 ? undefined : end)
}

describe('reference page coverage', () => {
  it('puts every registered endpoint on exactly one page', () => {
    const seen = new Map<string, string[]>()
    for (const page of pages) {
      for (const ep of page.endpoints) {
        const key = `${ep.method} ${ep.path}`
        seen.set(key, [...(seen.get(key) ?? []), page.slug])
      }
    }
    const missing = listEndpoints()
      .map((ep) => `${ep.method} ${ep.path}`)
      .filter((key) => !seen.has(key))
    const duplicated = [...seen].filter(([, slugs]) => slugs.length > 1).map(([key, slugs]) => `${key}: ${slugs.join(', ')}`)
    expect(missing).toEqual([])
    expect(duplicated).toEqual([])
  })

  it('has no empty page', () => {
    expect(pages.filter((p) => p.endpoints.length === 0).map((p) => p.slug)).toEqual([])
  })

  it('files the previously unlisted endpoints where a reader looks for them', () => {
    const slugOf = (method: string, path: string) =>
      pages.find((p) => p.endpoints.some((ep) => ep.method === method && ep.path === path))?.slug
    expect(slugOf('GET', '/api/v1/companies/:companyId/cash-accounts')).toBe('bank-accounts')
    expect(slugOf('POST', '/api/v1/companies/:companyId/bank-connections/:connectionId/sync')).toBe('bank-accounts')
    expect(slugOf('PATCH', '/api/v1/companies/:companyId/settings')).toBe('companies')
    expect(slugOf('GET', '/api/v1/companies/:companyId/skatteverket/vat-declarations')).toBe('skatteverket')
    expect(slugOf('POST', '/api/v1/companies/:companyId/salary/vacation-year-close')).toBe('salary-runs')
    expect(slugOf('GET', '/api/v1/health')).toBe('health')
    // Reconciliation's account-keyed routes stay on the reconciliation page,
    // not on the chart-of-accounts page their path also matches.
    expect(slugOf('GET', '/api/v1/companies/:companyId/reconciliation/accounts')).toBe('reconciliation')
  })
})

describe('endpoint tables', () => {
  it('renders registered query parameters with type and requiredness', () => {
    const md = section('skatteverket', 'skatteverket.vat_declarations.get')
    expect(md).toContain('**Query parameters**')
    expect(md).toMatch(/\| `period_type` \| [^|\n]*"monthly"/)
  })

  it('advertises dry_run on a dry-run-capable endpoint', () => {
    const md = section('journal-entries', 'journal-entries.create-draft')
    expect(md).toMatch(/\| `dry_run` \| string \| no \|/)
  })

  it('renders request body fields', () => {
    const md = section('journal-entries', 'journal-entries.create-draft')
    expect(md).toContain('**Request body**')
    expect(md).toMatch(/\| `fiscal_period_id` \| string \| yes \|/)
    expect(md).toMatch(/\| `lines` \| object\[\] \| yes \|/)
  })

  it('renders the list item fields of a response, nullable types escaped for the table', () => {
    const md = section('accounts', 'accounts.list')
    expect(md).toContain('**Response fields**')
    expect(md).toContain('| `accounts[].sru_code` | string \\| null |')
    expect(md).toContain('| `accounts[].account_type` | "asset" \\| "equity"')
  })
})
