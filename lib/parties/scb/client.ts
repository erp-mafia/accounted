import type { ScbConfig } from './config'
import { factsFromScbCompany, type ScbCompanyRow, type ScbFact } from './map'
import { isLegalPersonOrgNumber, toPeOrgNr } from './org-number'
import { scbJson } from './transport'

/**
 * The wire format of the current SokPaVar API. Everything SCB-shaped is in
 * this file; scripts/scb/discover.ts prints the live variable list and
 * category tables so the names below are checked, not remembered.
 */
export const SCB_JE_VARIABLES = [
  'Företagsnamn',
  'Firma',
  'PeOrgNr',
  'F-skattstatus',
  'Momsstatus',
  'Arbetsgivarstatus',
  'Företagsstatus',
  'Juridisk form',
  'Status hos Bolagsverket',
  'Storleksklass Anställda',
  'Bransch_1',
  'Bransch_1, text',
  'Postadress',
  'PostNr',
  'PostOrt',
  'COadress',
  'Säteskommun',
  'Säteslän',
  'Registreringsdatum',
  'Startdatum',
  'Slutdatum',
  'Telefon',
  'E-post',
  'Antal arbetsställen',
]

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

export function createScbClient(config: ScbConfig, deps: { json?: typeof scbJson } = {}): ScbClient {
  const json = deps.json ?? scbJson
  return {
    variables: () => json(config, 'GET', '/api/Je/Variabler'),
    categories: () => json(config, 'GET', '/api/Je/KategorierMedKodtabeller'),
    async lookupByOrgNumber(orgNumber) {
      if (!isLegalPersonOrgNumber(orgNumber)) {
        throw new Error('SCB-uppslag görs bara på organisationsnummer för juridiska personer.')
      }
      const peOrgNr = toPeOrgNr(orgNumber)
      const fetchedAt = new Date().toISOString()
      // One company by identity: the Je layout filtered on PeOrgNr, all
      // requested variables back. Verified shape lives in __tests__/fixtures.
      const body = {
        Företagsstatus: '',
        Registreringsstatus: '',
        variabler: SCB_JE_VARIABLES,
        Kategorier: [],
        Identiteter: [peOrgNr],
      }
      const rows = await json<ScbCompanyRow[] | { data?: ScbCompanyRow[] }>(config, 'POST', '/api/Je/HamtaForetag', body)
      const list = Array.isArray(rows) ? rows : (rows.data ?? [])
      const row = list.find((r) => String(Object.values(r).find((v) => typeof v === 'string' && v.replace(/[^0-9]/g, '') === peOrgNr) ?? '') !== '') ?? list[0] ?? null
      return { found: Boolean(row), peOrgNr, row, facts: row ? factsFromScbCompany(row) : [], fetchedAt }
    },
  }
}
