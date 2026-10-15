import { describe, expect, it } from 'vitest'
import coupling from '../bas-ink3r-coupling.json'
import { INK3_ACCOUNT_EXTENSIONS, ink3AccountTarget, parseAccountSpec } from '../account-mapping'
import { INK3_FIELD_TABLES } from '../field-table'

/**
 * Pins the INK3R account mapping to BAS's kopplingstabell
 * (bas-ink3r-coupling.json, INK3_P1_Intervall-241119.xlsx) and to
 * Skatteverket's 2026P4 field codes. When BAS publishes a new table:
 * replace the JSON, run this, fix what it names.
 */

const table = INK3_FIELD_TABLES['2026P4']

function accountsIn(spec: string): string[] {
  const { start, end } = parseAccountSpec(spec)
  const out: string[] = []
  for (let n = Number(start); n <= Number(end); n++) out.push(String(n))
  return out
}

describe('INK3R mapping follows the BAS kopplingstabell', () => {
  it('parses every account spec in the file', () => {
    expect(coupling.posts.length).toBe(44)
    for (const post of coupling.posts) for (const spec of post.accounts) expect(() => parseAccountSpec(spec)).not.toThrow()
    expect(parseAccountSpec('121x-128x')).toEqual({ start: '1210', end: '1289' })
    expect(parseAccountSpec('10xx')).toEqual({ start: '1000', end: '1099' })
    expect(parseAccountSpec('8865-8869')).toEqual({ start: '8865', end: '8869' })
  })

  it('uses only codes that are on the 2026P4 blankett, except the superseded 8665', () => {
    for (const post of coupling.posts) {
      if ('supersededBy' in post) {
        expect(post.code).toBe('8665')
        expect(table.byCode.has('8665')).toBe(false)
        for (const c of post.supersededBy as string[]) expect(table.byCode.get(c)?.ruta).toBe('6.20')
        continue
      }
      const field = table.byCode.get(post.code)
      expect(field, post.code).toBeDefined()
      expect(field!.blankett).toBe('INK3R')
      expect(field!.column === 'bokforing' || field!.ruta!.startsWith('5.'), post.code).toBe(true)
    }
  })

  it('sends every account BAS lists to that row, or nets it with the twin row BAS also lists', () => {
    const drift: string[] = []
    for (const post of coupling.posts) {
      if ('supersededBy' in post) continue
      for (const spec of post.accounts) {
        for (const account of accountsIn(spec)) {
          if (INK3_ACCOUNT_EXTENSIONS[account]) continue
          const target = ink3AccountTarget(account)
          const ok =
            (target?.kind === 'field' && target.code === post.code)
            || (target?.kind === 'net' && (target.plusCode === post.code || target.minusCode === post.code))
          if (!ok) drift.push(`${account}: BAS ${post.code}, ours ${JSON.stringify(target)}`)
        }
      }
    }
    expect(drift).toEqual([])
  })

  it('leaves 899x to the computed result (6.20)', () => {
    for (const account of accountsIn('899x')) expect(ink3AccountTarget(account)).toEqual({ kind: 'result' })
  })
})

describe('INK3R mapping: named accounts', () => {
  it.each([
    ['1930', { kind: 'field', code: '8730' }],
    ['1630', { kind: 'field', code: '8728' }],
    ['1510', { kind: 'field', code: '8727' }],
    ['2069', { kind: 'field', code: '8735' }],
    ['2068', { kind: 'field', code: '8735' }],
    ['2440', { kind: 'field', code: '8742' }],
    ['2510', { kind: 'field', code: '8741' }],
    ['2611', { kind: 'field', code: '8743' }],
    ['2990', { kind: 'field', code: '8744' }],
    ['3010', { kind: 'field', code: '8653' }],
    ['3985', { kind: 'field', code: '8654' }],
    ['4010', { kind: 'field', code: '8750' }],
    ['6991', { kind: 'field', code: '8751' }],
    ['7010', { kind: 'field', code: '8752' }],
    ['7832', { kind: 'field', code: '8753' }],
    ['7740', { kind: 'field', code: '8754' }],
    ['8012', { kind: 'net', plusCode: '8655', minusCode: '8755' }],
    ['8250', { kind: 'net', plusCode: '8656', minusCode: '8756' }],
    ['8310', { kind: 'field', code: '8657' }],
    ['8370', { kind: 'field', code: '8757' }],
    ['8410', { kind: 'field', code: '8758' }],
    ['8810', { kind: 'net', plusCode: '8659', minusCode: '8760' }],
    ['8811', { kind: 'field', code: '8760' }],
    ['8819', { kind: 'field', code: '8659' }],
    ['8820', { kind: 'field', code: '8660' }],
    ['8830', { kind: 'field', code: '8761' }],
    ['8850', { kind: 'net', plusCode: '8660', minusCode: '8761' }],
    ['8862', { kind: 'field', code: '8761' }],
    ['8866', { kind: 'field', code: '8660' }],
    ['8910', { kind: 'field', code: '8762' }],
  ])('%s', (account, target) => {
    expect(ink3AccountTarget(account)).toEqual(target)
  })

  it('maps 3901 Medlemsavgifter to 6.1 (BAS note 1), not BAS\'s 39xx row', () => {
    expect(INK3_ACCOUNT_EXTENSIONS).toEqual({ '3901': '8650' })
    expect(ink3AccountTarget('3901')).toEqual({ kind: 'field', code: '8650' })
    expect(table.byCode.get('8650')?.ruta).toBe('6.1')
    const basRow = coupling.posts.find((p) => p.accounts.some((spec) => accountsIn(spec).includes('3901')))
    expect(basRow?.code).toBe('8654')
  })

  it.each(['2099', '2010', '7700', '1200', '9999', '123'])('has no INK3R box for %s', (account) => {
    expect(ink3AccountTarget(account)).toBeNull()
  })
})
