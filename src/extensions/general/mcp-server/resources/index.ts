import type { McpResource, ResourceContext } from './types'
import { companyCurrentResource } from './company-current'
import { chartOfAccountsResource } from './chart-of-accounts'
import { periodActiveResource } from './period-active'
import { recentActivityResource } from './recent-activity'
import { capabilitiesResource } from './capabilities'
import { vatTreatmentsResource } from './vat-treatments'
import { attentionResource } from './attention'
import { ledgerContextResource } from './ledger-context'
import { bookingPacksResource } from './booking-packs'
import { reconciliationSummaryResource } from './reconciliation-summary'
import { arkivMapResource } from './arkiv-map'
import { arkivMissingResource } from './arkiv-missing'
import { arkivGraphResource } from './arkiv-graph'

export const dataResources: McpResource[] = [
  companyCurrentResource,
  chartOfAccountsResource,
  periodActiveResource,
  recentActivityResource,
  capabilitiesResource,
  vatTreatmentsResource,
  attentionResource,
  ledgerContextResource,
  bookingPacksResource,
  reconciliationSummaryResource,
  arkivMapResource,
  arkivMissingResource,
  arkivGraphResource,
]

export function findResource(uri: string): McpResource | null {
  // Strip any query string for matching
  const baseUri = uri.split('?')[0]
  return dataResources.find((r) => r.uri === baseUri) ?? null
}

/**
 * Accounted://company/{company_id}/{resource}: any data resource for one
 * company the key reaches, `resource` being its URI after Accounted://
 * (attention, period/active, ...; `context` is company/current). An encoded
 * slash (period%2Factive, RFC 6570 simple expansion) reads the same. The
 * caller resolves the company like a tool call's company_id (crm#1637: the
 * unscoped URIs only ever read the default company).
 */
const COMPANY_RESOURCE_RE =
  /^Accounted:\/\/company\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([^?]+)(\?.*)?$/i

export function findCompanyScopedResource(
  uri: string
): { companyId: string; resource: McpResource; uri: string } | null {
  const match = COMPANY_RESOURCE_RE.exec(uri)
  if (!match) return null
  let path: string
  try {
    path = decodeURIComponent(match[2])
  } catch {
    // A malformed percent-escape names no resource: answered as not found.
    return null
  }
  const inner = `${path === 'context' ? companyCurrentResource.uri : `Accounted://${path}`}${match[3] ?? ''}`
  const resource = findResource(inner)
  return resource ? { companyId: match[1].toLowerCase(), resource, uri: inner } : null
}

export function parseResourceQuery(uri: string): URLSearchParams | undefined {
  const qIndex = uri.indexOf('?')
  if (qIndex < 0) return undefined
  return new URLSearchParams(uri.slice(qIndex + 1))
}

export type { McpResource, ResourceContext }
