import type { McpResource, ResourceContext } from './types'
import { companyCurrentResource } from './company-current'
import { chartOfAccountsResource } from './chart-of-accounts'
import { periodActiveResource } from './period-active'
import { recentActivityResource } from './recent-activity'
import { capabilitiesResource } from './capabilities'
import { vatTreatmentsResource } from './vat-treatments'
import { attentionResource } from './attention'
import { ledgerContextResource } from './ledger-context'

export const dataResources: McpResource[] = [
  companyCurrentResource,
  chartOfAccountsResource,
  periodActiveResource,
  recentActivityResource,
  capabilitiesResource,
  vatTreatmentsResource,
  attentionResource,
  ledgerContextResource,
]

export function findResource(uri: string): McpResource | null {
  // Strip any query string for matching
  const baseUri = uri.split('?')[0]
  return dataResources.find((r) => r.uri === baseUri) ?? null
}

export function parseResourceQuery(uri: string): URLSearchParams | undefined {
  const qIndex = uri.indexOf('?')
  if (qIndex < 0) return undefined
  return new URLSearchParams(uri.slice(qIndex + 1))
}

export type { McpResource, ResourceContext }
