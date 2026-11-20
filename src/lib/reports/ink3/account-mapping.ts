import coupling from './bas-ink3r-coupling.json'
import { INK3_FIELD_TABLES } from './field-table'

/**
 * Which INK3R box ("enligt redovisningen") an account's balance goes to.
 *
 * The base is BAS's own INK3R kopplingstabell (bas-ink3r-coupling.json,
 * INK3_P1_Intervall-241119.xlsx). Where its code disagrees with Skatteverket's
 * field table, the field table wins: BAS still names 8665 for 6.20 Årets
 * resultat, which the 2026P4 blankett files as 8663/8763, so 899x is marked
 * as the computed result here and never mapped.
 *
 * Kept apart from the INK2 mapping and from the förenklat årsbokslut
 * grouping on purpose: each follows its own published table.
 */

interface AccountRange {
  start: string
  end: string
}

interface CouplingPost {
  code: string
  row: string | null
  label: string | null
  accounts: string[]
  netSign?: string
  footnote?: number
  supersededBy?: string[]
}

/**
 * Accounts mapped although BAS leaves them to the company. BAS note 1: the
 * chart has no standard accounts for medlemsavgifter, gåvor or bidrag, and
 * the company must add the ones it couples to 8650-8652. Accounted seeds
 * 3901 Medlemsavgifter for an ideell förening, so it goes to 6.1 instead of
 * BAS's 39xx row (6.5 Övriga intäkter).
 */
export const INK3_ACCOUNT_EXTENSIONS: Readonly<Record<string, string>> = {
  '3901': '8650',
}

/** Where one account's balance lands on INK3R. */
export type Ink3AccountTarget =
  /** One box. */
  | { kind: 'field'; code: string }
  /**
   * BAS lists the account on a plus box and a minus box: the accounts sharing
   * this pair are netted, and the net goes to the box its sign names (6.11,
   * 6.12, 8810 between 6.16 and 6.17, 885x/8860/889x on 6.18).
   */
  | { kind: 'net'; plusCode: string; minusCode: string }
  /** 899x: årets resultat, computed from the other boxes (6.20), never read from the account. */
  | { kind: 'result' }

/** 'NNNN', 'NNNN-NNNN', 'NNNx', 'NNxx', 'NNNx-NNNx', 'NNxx-NNxx' as a string range. */
export function parseAccountSpec(spec: string): AccountRange {
  const trimmed = spec.trim()
  if (!/^\d[\dx]{3}(\s*-\s*\d[\dx]{3})?$/.test(trimmed)) {
    throw new Error(`Unparsed account spec in bas-ink3r-coupling.json: "${spec}"`)
  }
  const [low, high = low] = trimmed.split('-').map((part) => part.trim())
  return { start: low.replace(/x/g, '0'), end: high.replace(/x/g, '9') }
}

const POSTS = (coupling.posts as CouplingPost[]).map((post) => ({
  ...post,
  ranges: post.accounts.map(parseAccountSpec),
}))

function fieldSign(code: string): string | null {
  for (const table of Object.values(INK3_FIELD_TABLES)) {
    const field = table.byCode.get(code)
    if (field) return field.sign
  }
  return null
}

function resolveTarget(accountNumber: string): Ink3AccountTarget | null {
  const extension = INK3_ACCOUNT_EXTENSIONS[accountNumber]
  if (extension) return { kind: 'field', code: extension }

  const codes: string[] = []
  for (const post of POSTS) {
    if (!post.ranges.some((r) => accountNumber >= r.start && accountNumber <= r.end)) continue
    if (post.supersededBy) return { kind: 'result' }
    if (!codes.includes(post.code)) codes.push(post.code)
  }
  if (codes.length === 0) return null
  if (codes.length === 1) return { kind: 'field', code: codes[0] }
  const plus = codes.filter((code) => fieldSign(code) === '+')
  const minus = codes.filter((code) => fieldSign(code) === '-')
  if (codes.length === 2 && plus.length === 1 && minus.length === 1) {
    return { kind: 'net', plusCode: plus[0], minusCode: minus[0] }
  }
  throw new Error(`Account ${accountNumber} sits on ${codes.join(', ')} in the INK3R coupling`)
}

const cache = new Map<string, Ink3AccountTarget | null>()

/** The INK3R target of a four-digit account number, or null when the coupling has none. */
export function ink3AccountTarget(accountNumber: string): Ink3AccountTarget | null {
  if (!/^\d{4}$/.test(accountNumber)) return null
  if (!cache.has(accountNumber)) cache.set(accountNumber, resolveTarget(accountNumber))
  return cache.get(accountNumber) ?? null
}
