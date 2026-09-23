import { describe, expect, it } from 'vitest'
import { computeSRUCode } from '@/lib/bookkeeping/bas-data/sru-mapping'
import { INK2R_ACCOUNT_MAPPINGS, isAccountInMapping } from '../account-mappings'
import { INK2R_SIGN_TWINS, type INK2RSRUCode } from '../types'
import official from '../official-ink2r-coupling.json'

/**
 * Pins the engine's BAS-to-INK2R ranges (and therefore the chart's sru_code)
 * to the official BAS kopplingstabell transcribed in official-ink2r-coupling.json.
 * When BAS publishes a new table: replace the JSON, run this test, fix the
 * ranges it names. Never the other way round.
 */

/** Expand one account spec from the file: 1088, 1000-1087, 112x, 17xx, 151x-155x, 30xx-37xx. */
function expandSpec(spec: string): number[] {
  const s = spec.replace(/\(.*?\)/g, '').trim()
  let m = s.match(/^(\d{4})\s*-\s*(\d{4})$/)
  if (m) return range(Number(m[1]), Number(m[2]))
  m = s.match(/^(\d{3})x\s*-\s*(\d{3})x$/)
  if (m) return range(Number(m[1]) * 10, Number(m[2]) * 10 + 9)
  m = s.match(/^(\d{2})xx\s*-\s*(\d{2})xx$/)
  if (m) return range(Number(m[1]) * 100, Number(m[2]) * 100 + 99)
  m = s.match(/^(\d{3})x$/)
  if (m) return range(Number(m[1]) * 10, Number(m[1]) * 10 + 9)
  m = s.match(/^(\d{2})xx$/)
  if (m) return range(Number(m[1]) * 100, Number(m[1]) * 100 + 99)
  m = s.match(/^(\d{4})$/)
  if (m) return [Number(m[1])]
  throw new Error(`unparsed account spec in official-ink2r-coupling.json: "${spec}"`)
}
function range(a: number, b: number): number[] {
  const out: number[] = []
  for (let n = a; n <= b; n++) out.push(n)
  return out
}

/**
 * Accounts we map although the official file does not list them. Each entry
 * is deliberate and commented in account-mappings.ts.
 */
const EXTENSIONS: Record<string, string> = {
  ...Object.fromEntries(range(2010, 2079).map((n) => [String(n), '7301'])),
  ...Object.fromEntries(range(4800, 4899).map((n) => [String(n), '7511'])),
  ...Object.fromEntries(range(2860, 2873).map((n) => [String(n), '7367'])),
  '1670': '7252',
  '2473': '7367',
}

function officialCodes(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  for (const post of official.posts) {
    const negativeSide = (post as { negativeSideAccounts?: string[] }).negativeSideAccounts ?? []
    const specs = [...post.accounts, ...negativeSide]
    for (const spec of specs) {
      for (const n of expandSpec(spec)) {
        const set = map.get(String(n)) ?? new Set<string>()
        set.add(post.code)
        map.set(String(n), set)
      }
    }
  }
  // 8810 is listed on 7420 (net +) and 7525 (net -): the chart shows 7420.
  // 899x is listed on 7450 (vinst) and 7550 (förlust): the chart shows 7450.
  return map
}

function engineCode(account: string): string | null {
  for (const mapping of INK2R_ACCOUNT_MAPPINGS) {
    if (isAccountInMapping(account, mapping)) return mapping.sruCode
  }
  return null
}

describe('INK2R ranges follow the official BAS kopplingstabell', () => {
  const officialMap = officialCodes()

  it('the file parses into a plausible number of accounts', () => {
    expect(official.posts.length).toBeGreaterThan(70)
    expect(officialMap.size).toBeGreaterThan(2500)
  })

  it('computeSRUCode agrees with the official table for every four-digit number', () => {
    const drift: string[] = []
    for (let n = 1000; n <= 9999; n++) {
      const account = String(n)
      const ours = computeSRUCode(account)
      const allowed = officialMap.get(account)
      if (allowed) {
        if (ours === null || !allowed.has(ours)) drift.push(`${account}: official ${[...allowed].join('/')} vs ours ${ours}`)
      } else if (ours !== null && EXTENSIONS[account] !== ours) {
        drift.push(`${account}: not in the official table, ours ${ours}`)
      }
    }
    expect(drift).toEqual([])
  })

  it('the engine maps every account the chart maps, except 899x which it computes', () => {
    const drift: string[] = []
    for (let n = 1000; n <= 9999; n++) {
      const account = String(n)
      const chart = computeSRUCode(account)
      const engine = engineCode(account)
      const expected = n >= 8990 && n <= 8999 ? null : chart
      if (engine !== expected) drift.push(`${account}: engine ${engine} vs chart ${chart}`)
    }
    expect(drift).toEqual([])
  })

  it('every official plus/minus row has a sign twin in the engine', () => {
    const twins = new Map(INK2R_SIGN_TWINS.map(([positive, negative]) => [positive, negative]))
    for (const post of official.posts) {
      if (!('negativeCode' in post) || post.code === '7450') continue
      expect(twins.get(post.code as INK2RSRUCode), `twin for ${post.code}`).toBe(post.negativeCode)
    }
  })

  it('every extension is on purpose and still not on the official table', () => {
    for (const [account, code] of Object.entries(EXTENSIONS)) {
      expect(officialMap.has(account), `${account} is now official; drop it from EXTENSIONS`).toBe(false)
      expect(computeSRUCode(account)).toBe(code)
    }
  })
})
