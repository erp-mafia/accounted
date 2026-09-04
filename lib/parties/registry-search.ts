/**
 * Parties: what to ask SCB for a party without an org number.
 *
 * The picker used to search on the whole display name, which for an
 * assistant-written voucher is a sentence. This plans the search from the
 * name candidates read out of the party's name and its voucher texts:
 * Swedish legal persons first, the cleaned head last, and nothing at all
 * when the best reading is a foreign company, which SCB cannot hold.
 */
import { extractNameCandidates, type NameCandidate } from './name-extract'
import { nameQuery, type ScbSearchResult } from './scb/client'

export interface ForeignReading {
  name: string
  legalForm?: string
  country?: string
}

export interface RegistryQueryPlan {
  /** Queries worth trying, best first. Empty when the party looks foreign. */
  queries: string[]
  /** The best reading of the counterpart when it is not a Swedish legal person. */
  foreign: ForeignReading | null
  candidates: NameCandidate[]
}

export interface RegistryCandidatesResult extends ScbSearchResult {
  /** Every query the server tried or would try, best first. */
  queries: string[]
  foreign: ForeignReading | null
  /**
   * What the model read out of a text the rules could not anchor (a bank
   * memo), when a model is configured. Shown as "läst ur verifikatet"; the
   * search ran on it. Null when the rules found a name or no model answered.
   */
  aiRead: { name: string; country: string | null } | null
}

/** True when nothing in the texts anchored a name: only cleaned heads remain. */
export function needsModelReading(plan: RegistryQueryPlan): boolean {
  return plan.foreign === null && plan.candidates.every((c) => c.source === 'head')
}

export const MAX_REGISTRY_QUERIES = 3

export function planRegistryQueries(input: { legalName: string | null; displayName: string; voucherTexts: string[] }): RegistryQueryPlan {
  const texts = [input.legalName, input.displayName, ...input.voucherTexts].filter((t): t is string => !!t && t.trim().length > 0)
  const seen = new Set<string>()
  const candidates: NameCandidate[] = []
  for (const text of texts) {
    for (const c of extractNameCandidates(text)) {
      const k = c.name.toLowerCase()
      if (seen.has(k)) continue
      seen.add(k)
      candidates.push(c)
    }
  }
  const swedishForm = candidates.filter((c) => c.source === 'legal_form' && !c.foreign)
  const foreignAnchored = candidates.filter((c) => c.foreign && c.source !== 'head')
  const foreign = swedishForm.length === 0 && foreignAnchored.length > 0 ? foreignAnchored[0]! : null
  const ordered = foreign
    ? []
    : [...swedishForm, ...candidates.filter((c) => c.source !== 'legal_form' && !c.foreign), ...candidates.filter((c) => c.source === 'head')]
  const queries: string[] = []
  for (const c of ordered) {
    const q = nameQuery(c.name)
    if (q.length < 2 || queries.includes(q)) continue
    queries.push(q)
    if (queries.length >= MAX_REGISTRY_QUERIES) break
  }
  return {
    queries,
    foreign: foreign ? { name: foreign.name, ...(foreign.legalForm ? { legalForm: foreign.legalForm } : {}), ...(foreign.country ? { country: foreign.country } : {}) } : null,
    candidates,
  }
}
