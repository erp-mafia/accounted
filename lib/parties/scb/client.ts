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

export interface ScbCandidate {
  orgNumber: string
  name: string
  city: string | null
  industry: string | null
  legalForm: string | null
  /** SCB's own status text; active is Företagsstatus code 1. */
  status: string | null
  active: boolean
}

export interface ScbSearchResult {
  query: string
  /** How SCB was asked: a prefix match first, a contains match as fallback. */
  mode: 'starts_with' | 'contains'
  /** Rows SCB counted before the cap; above the cap the list is cut and the user should refine. */
  total: number
  truncated: boolean
  candidates: ScbCandidate[]
}

export interface ScbClient {
  variables(): Promise<unknown>
  categories(): Promise<unknown>
  lookupByOrgNumber(orgNumber: string): Promise<ScbLookupResult>
  searchByName(query: string): Promise<ScbSearchResult>
}

/** Candidates shown per search; SCB can return thousands for a short word. */
export const SCB_SEARCH_CAP = 25
/** Legal forms never offered in the picker: natural persons and estates. */
const NON_COMPANY_LEGAL_FORMS = new Set(['10', '91'])

/**
 * What we send SCB for a name: the AP prefix, supplier numbers and a
 * trailing legal form are noise ("Levfakt Telia Sverige AB (17)" becomes
 * "Telia Sverige"). SCB's name filter refuses an apostrophe.
 */
export function nameQuery(raw: string): string {
  return raw
    .replace(/^(levfakt|levfkt|lev\.?fakt\.?|leverantörsfaktura från\s*\d*|leverantörsfaktura|levbet\.?|kundbet\.?|kundfaktura|faktura från|faktura|kvitto|utgift|inköp)\s+/i, '')
    .replace(/[(),]/g, ' ')
    .replace(/\b\d{1,6}\b/g, ' ')
    .replace(/\s+(ab|aktiebolag|hb|kb|ltd|limited|oy|gmbh|inc|sarl|publ|filial)\.?\s*$/i, '')
    .replace(/'/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function nameSearchBody(query: string, mode: 'starts_with' | 'contains') {
  return {
    Variabler: [{ Variabel: 'Namn', Operator: mode === 'starts_with' ? 'BorjarPa' : 'Innehaller', Varde1: query, Varde2: '' }],
    Kategorier: [],
  }
}

function candidateFrom(row: ScbCompanyRow): ScbCandidate | null {
  const org = String(row.OrgNr ?? '').replace(/[^0-9]/g, '')
  const legalFormCode = String(row['Juridisk form, kod'] ?? '').trim()
  if (org.length !== 10 || NON_COMPANY_LEGAL_FORMS.has(legalFormCode)) return null
  const str = (k: string) => {
    const v = row[k]
    const t = v === null || v === undefined ? '' : String(v).trim()
    return t === '' ? null : t
  }
  return {
    orgNumber: org,
    name: str('Företagsnamn') ?? org,
    city: str('PostOrt'),
    industry: str('Bransch_1'),
    legalForm: str('Juridisk form'),
    status: str('Företagsstatus'),
    active: String(row['Företagsstatus, kod'] ?? '').trim() === '1',
  }
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
    async searchByName(raw) {
      const query = nameQuery(raw)
      if (query.length < 2) return { query, mode: 'starts_with', total: 0, truncated: false, candidates: [] }
      // Count first: a short word can match thousands and we never pull those.
      const run = async (mode: 'starts_with' | 'contains'): Promise<ScbSearchResult> => {
        const body = nameSearchBody(query, mode)
        const total = Number(await json<number | string>(config, 'POST', '/api/Je/RaknaForetag', body)) || 0
        if (total === 0) return { query, mode, total, truncated: false, candidates: [] }
        if (total > SCB_SEARCH_CAP * 4) return { query, mode, total, truncated: true, candidates: [] }
        const rows = await json<ScbCompanyRow[]>(config, 'POST', '/api/Je/HamtaForetag', body)
        const all = (Array.isArray(rows) ? rows : []).map(candidateFrom).filter((c): c is ScbCandidate => c !== null)
        // Active companies first, then by name; the cap keeps the picker a picker.
        all.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, 'sv'))
        return { query, mode, total, truncated: all.length > SCB_SEARCH_CAP, candidates: all.slice(0, SCB_SEARCH_CAP) }
      }
      const first = await run('starts_with')
      if (first.total > 0 || query.length < 4) return first
      return run('contains')
    },
  }
}
