/**
 * Whether the aktiebok suggests a fåmansföretag (IL 56 kap. 2 §): four or
 * fewer delägare together hold more than half of the votes. The aktiebok
 * only knows the holders; IL counts close relatives (närstående) as one
 * delägare, looks through companies to the people who own them, and has a
 * second test (an independent business area run by one delägare). So the
 * aktiebok only suggests an answer; the person confirms it per inkomstår,
 * and the confirmed answer is what KU31 field 061 or 062 uses.
 */
import { roundOre } from '@/lib/money'

export interface FamansHolder {
  party_id: string
  votes: number
}

export interface FamansDerivation {
  /** True when the four largest holders by votes hold more than half of the votes. */
  derived: boolean
  /** Their share of the votes, in percent (two decimals). */
  top_four_votes_pct: number
  holders: number
}

export function deriveFamansforetag(holders: readonly FamansHolder[]): FamansDerivation {
  const total = holders.reduce((n, h) => n + h.votes, 0)
  if (total <= 0) return { derived: false, top_four_votes_pct: 0, holders: 0 }
  const topFour = [...holders].sort((a, b) => b.votes - a.votes).slice(0, 4).reduce((n, h) => n + h.votes, 0)
  const pct = roundOre((topFour / total) * 100)
  return { derived: topFour * 2 > total, top_four_votes_pct: pct, holders: holders.length }
}
