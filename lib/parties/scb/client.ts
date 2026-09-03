import type { ScbConfig } from './config'
import { factsFromScbCompany, type ScbCompanyRow, type ScbFact } from './map'
import { isLegalPersonOrgNumber, toPeOrgNr } from './org-number'
import { scbJson } from './transport'

/**
 * The wire format of the current SokPaVar API, checked against the live
 * service on 2026-09-03 (scripts/scb/discover.ts, help page at
 * <base>/help). A search is a list of variable filters; an identity lookup
 * is one filter on "OrgNr (10 siffror)" with operator ArLikaMed, and
 * without Företagsstatus/Registreringsstatus so a deregistered company is
 * still returned (an empty string there is rejected with 400). The row
 * comes back with every purchased column, codes and texts side by side.
 */
export const SCB_ORG_VARIABLE = 'OrgNr (10 siffror)'

export interface ScbLookupResult {
  found: boolean
  peOrgNr: string
  row: ScbCompanyRow | null
  facts: ScbFact[]
  fetchedAt: string
}

export interface ScbClient {
  variables(): Promise<unknown>
  categories(): Promise<unknown>
  lookupByOrgNumber(orgNumber: string): Promise<ScbLookupResult>
}

export function identityLookupBody(orgNumber10: string) {
  return {
    Variabler: [{ Variabel: SCB_ORG_VARIABLE, Operator: 'ArLikaMed', Varde1: orgNumber10, Varde2: '' }],
    Kategorier: [],
  }
}

export function createScbClient(config: ScbConfig, deps: { json?: typeof scbJson } = {}): ScbClient {
  const json = deps.json ?? scbJson
  return {
    variables: () => json(config, 'GET', '/api/Je/Variabler'),
    categories: () => json(config, 'GET', '/api/Je/KategorierMedKodtabeller'),
    async lookupByOrgNumber(orgNumber) {
      if (!isLegalPersonOrgNumber(orgNumber)) {
        throw new Error('SCB-uppslag görs bara på organisationsnummer för juridiska personer.')
      }
      const org10 = orgNumber.replace(/[^0-9]/g, '')
      const peOrgNr = toPeOrgNr(org10)
      const fetchedAt = new Date().toISOString()
      const rows = await json<ScbCompanyRow[]>(config, 'POST', '/api/Je/HamtaForetag', identityLookupBody(org10))
      const list = Array.isArray(rows) ? rows : []
      const row = list.find((r) => String(r.OrgNr ?? r.PeOrgNr ?? '').replace(/[^0-9]/g, '').endsWith(org10)) ?? null
      return { found: Boolean(row), peOrgNr, row, facts: row ? factsFromScbCompany(row) : [], fetchedAt }
    },
  }
}
