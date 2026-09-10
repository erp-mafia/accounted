import { describe, it, expect } from 'vitest'
import {
  groupNotices,
  legacyNotices,
  makeNotice,
  noticesFromParseIssues,
  resolveNotices,
  sortNotices,
} from '../notices'

describe('import notices', () => {
  it('groups by tier and keeps emission order inside a tier', () => {
    const groups = groupNotices([
      makeNotice('a', 'info'),
      makeNotice('b', 'action'),
      makeNotice('c', 'notice'),
      makeNotice('d', 'action'),
    ])
    expect(groups.actions.map((n) => n.code)).toEqual(['b', 'd'])
    expect(groups.notices.map((n) => n.code)).toEqual(['c'])
    expect(groups.infos.map((n) => n.code)).toEqual(['a'])
  })

  it('sorts actions first, then notices, then info, stably', () => {
    const sorted = sortNotices([
      makeNotice('i1', 'info'),
      makeNotice('n1', 'notice'),
      makeNotice('a1', 'action'),
      makeNotice('n2', 'notice'),
    ])
    expect(sorted.map((n) => n.code)).toEqual(['a1', 'n1', 'n2', 'i1'])
  })

  it('wraps free-text warnings as legacy notices in the notice tier', () => {
    expect(legacyNotices(['x', 'y'])).toEqual([
      { code: 'legacy', severity: 'notice', params: { text: 'x' } },
      { code: 'legacy', severity: 'notice', params: { text: 'y' } },
    ])
    expect(legacyNotices(undefined)).toEqual([])
  })

  it('maps parser issues onto the tiers and drops errors', () => {
    const out = noticesFromParseIssues([
      { row: 3, message: 'Ogiltigt datum', severity: 'warning' },
      { row: 0, message: 'Decimalavgränsare ser fel ut', severity: 'warning' },
      { line: 12, message: 'Okänd tagg', severity: 'info' },
      { row: 5, message: 'Blockerande', severity: 'error' },
    ])
    expect(out).toEqual([
      { code: 'parse_issue_row', severity: 'notice', params: { row: 3, message: 'Ogiltigt datum' } },
      { code: 'parse_issue', severity: 'notice', params: { message: 'Decimalavgränsare ser fel ut' } },
      { code: 'parse_issue_row', severity: 'info', params: { row: 12, message: 'Okänd tagg' } },
    ])
  })

  it('prefers the structured list and falls back to legacy strings', () => {
    const structured = resolveNotices({
      notices: [makeNotice('sie_ib_rounding', 'info'), makeNotice('sie_ib_unbalanced', 'action')],
      warnings: ['ignored when notices exist'],
    })
    expect(structured.map((n) => n.code)).toEqual(['sie_ib_unbalanced', 'sie_ib_rounding'])

    const legacy = resolveNotices({ warnings: ['369 konton bytte namn'] })
    expect(legacy).toEqual([
      { code: 'legacy', severity: 'notice', params: { text: '369 konton bytte namn' } },
    ])
  })

  it('excludes codes a dedicated card already renders, by code and never by text', () => {
    const out = resolveNotices(
      {
        notices: [
          makeNotice('sie_vouchers_skipped', 'action', { count: 3, parts: '3 tomma' }),
          makeNotice('legacy', 'notice', { text: '3 verifikationer hoppades över' }),
        ],
      },
      ['sie_vouchers_skipped']
    )
    expect(out.map((n) => n.code)).toEqual(['legacy'])
  })
})
