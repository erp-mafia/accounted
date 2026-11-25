/**
 * Which correction paths a posted verifikat offers (CLAUDE.md Hard Rule 1):
 * inline rättelse first in an open, unlocked period with the storno paths
 * still there; past a lock, a close or the lock date only the ändringsverifikat
 * moved to the first open period; nothing the server would refuse.
 */
import { describe, expect, it } from 'vitest'
import { correctionPaths, leadingCorrectionPath, LINE_RATTELSE_EXCLUDED_SOURCES, type CorrectionPathInput } from '../correction-paths'
import { periodLockVerdict } from '../period-status'

const posted = (over: Partial<CorrectionPathInput> = {}): CorrectionPathInput => ({
  status: 'posted',
  source_type: 'manual',
  stornoed: false,
  periodStatus: 'open',
  ...over,
})

describe('correctionPaths', () => {
  it('offers inline rättelse first in an open period, and keeps every storno path', () => {
    expect(correctionPaths(posted())).toEqual({
      inline: ['strike_lines', 'correct_metadata'],
      storno: ['correct_lines', 'correct_date', 'reverse'],
    })
  })

  // The period verdict as the period-status answer gives it (periodLockVerdict).
  const verdict = (date: string, lockThrough: string | null, period: { is_closed?: boolean; locked_at?: string | null }) =>
    periodLockVerdict(date, lockThrough, { id: 'fp-2026', ...period }).status.status

  it('reads an open, unlocked period after the lock date as open', () => {
    expect(verdict('2026-05-10', '2026-03-31', {})).toBe('open')
    expect(correctionPaths(posted({ periodStatus: verdict('2026-05-10', '2026-03-31', {}) })).inline).toEqual([
      'strike_lines',
      'correct_metadata',
    ])
  })

  it('offers only the ändringsverifikat in a locked period: Rätta datum and Återför book on the locked date', () => {
    const periodStatus = verdict('2026-05-10', null, { locked_at: '2026-06-01T08:00:00Z' })
    expect(correctionPaths(posted({ periodStatus }))).toEqual({ inline: [], storno: ['correct_lines'] })
  })

  it('offers only the ändringsverifikat in a closed year', () => {
    const periodStatus = verdict('2025-05-10', null, { is_closed: true })
    expect(correctionPaths(posted({ periodStatus }))).toEqual({ inline: [], storno: ['correct_lines'] })
  })

  it('offers only the ändringsverifikat behind the company lock date, in an otherwise open year', () => {
    const periodStatus = verdict('2026-03-10', '2026-03-31', {})
    expect(correctionPaths(posted({ periodStatus }))).toEqual({ inline: [], storno: ['correct_lines'] })
  })

  it('offers no inline path while the period is not known, as the period answer fails closed', () => {
    expect(correctionPaths(posted({ periodStatus: null }))).toEqual({ inline: [], storno: ['correct_lines'] })
  })

  it('offers nothing for a verifikat a posted storno already reverses, whatever the period', () => {
    for (const periodStatus of ['open', 'locked', 'closed', null] as const) {
      expect(correctionPaths(posted({ stornoed: true, periodStatus }))).toEqual({ inline: [], storno: [] })
    }
  })

  it('offers nothing for a storno or a draft', () => {
    expect(correctionPaths(posted({ source_type: 'storno' }))).toEqual({ inline: [], storno: [] })
    expect(correctionPaths(posted({ status: 'draft' }))).toEqual({ inline: [], storno: [] })
    expect(correctionPaths(posted({ status: 'reversed' }))).toEqual({ inline: [], storno: [] })
  })

  it('keeps a correction correctable: the chain just grows', () => {
    expect(correctionPaths(posted({ source_type: 'correction' })).inline).toEqual(['strike_lines', 'correct_metadata'])
  })

  it('offers no line striking for the entry types the RPC refuses, but still the text', () => {
    for (const source_type of ['year_end', 'vat_settlement']) {
      expect(correctionPaths(posted({ source_type })).inline).toEqual(['correct_metadata'])
    }
    expect(LINE_RATTELSE_EXCLUDED_SOURCES).toEqual(['storno', 'year_end', 'vat_settlement'])
  })

  it('leaves an opening balance to its own flows, in any period', () => {
    for (const periodStatus of ['open', 'locked', 'closed', null] as const) {
      expect(correctionPaths(posted({ source_type: 'opening_balance', periodStatus }))).toEqual({ inline: [], storno: [] })
    }
  })

  it('offers nothing past a lock for an entry whose date never moves', () => {
    for (const source_type of ['year_end', 'vat_settlement']) {
      for (const periodStatus of ['locked', 'closed'] as const) {
        expect(correctionPaths(posted({ source_type, periodStatus }))).toEqual({ inline: [], storno: [] })
      }
    }
  })
})

describe('leadingCorrectionPath', () => {
  it('leads with striking lines in an open period, not with a storno', () => {
    expect(leadingCorrectionPath(correctionPaths(posted()))).toBe('strike_lines')
  })

  it('leads with the text where lines are never struck', () => {
    expect(leadingCorrectionPath(correctionPaths(posted({ source_type: 'vat_settlement' })))).toBe('correct_metadata')
  })

  it('leads with the ändringsverifikat past a lock, and with nothing where nothing applies', () => {
    expect(leadingCorrectionPath(correctionPaths(posted({ periodStatus: 'locked' })))).toBe('correct_lines')
    expect(leadingCorrectionPath(correctionPaths(posted({ periodStatus: 'closed', source_type: 'year_end' })))).toBeNull()
    expect(leadingCorrectionPath(correctionPaths(posted({ stornoed: true })))).toBeNull()
  })
})
