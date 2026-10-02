import { describe, it, expect } from 'vitest'
import { HISTORY_AGE_DAYS, historyReaderTier, isActingType, needsReadOnDemand, readLaneFor, readPlanFor } from '../lanes'

const now = new Date('2026-09-17T12:00:00Z')
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString()

describe('readLaneFor', () => {
  it('is live for anything from the last month, or without a date', () => {
    expect(readLaneFor({ created_at: daysAgo(3), journal_entry_id: 'je' }, now)).toBe('live')
    expect(readLaneFor({ created_at: daysAgo(HISTORY_AGE_DAYS) }, now)).toBe('live')
    expect(readLaneFor({}, now)).toBe('live')
  })

  it('splits older documents by whether a voucher holds them', () => {
    expect(readLaneFor({ created_at: daysAgo(31), journal_entry_id: 'je' }, now)).toBe('history_tied')
    expect(readLaneFor({ created_at: daysAgo(400), journal_entry_line_id: 'jel' }, now)).toBe('history_tied')
    expect(readLaneFor({ created_at: daysAgo(31), journal_entry_id: null }, now)).toBe('history_loose')
  })
})

describe('isActingType', () => {
  it('is every agreement, registration, filing, decision and minutes, plus the corporate records', () => {
    for (const t of ['agreement.loan', 'agreement.other', 'registration.bolagsverket', 'filing.bolagsverket', 'decision.skatteverket', 'minutes.agm', 'share_subscription_list', 'annual_report']) expect(isActingType(t)).toBe(true)
    for (const t of ['receipt', 'supplier_invoice', 'bank_statement', 'other', null, undefined]) expect(isActingType(t)).toBe(false)
  })
})

describe('readPlanFor', () => {
  it('reads live documents as before: the model inside the rollout, every page', () => {
    expect(readPlanFor({ lane: 'live', inRollout: true, docType: null, pagesRead: false })).toEqual({ lane: 'live', allowModel: true, maxModelPages: null })
    expect(readPlanFor({ lane: 'live', inRollout: false, docType: null, pagesRead: false })).toEqual({ lane: 'live', allowModel: false, maxModelPages: null })
    // Booked (on a verifikat), however new: the free text layer now, the model when someone opens it.
    expect(readPlanFor({ lane: 'live', inRollout: true, docType: null, pagesRead: false, tied: true })).toEqual({ lane: 'live', allowModel: false, maxModelPages: null })
  })

  it('reads voucher-tied history for its text layer only, once', () => {
    expect(readPlanFor({ lane: 'history_tied', inRollout: true, docType: null, pagesRead: false })).toEqual({ lane: 'history_tied', allowModel: false, maxModelPages: null, tier: 'extraction' })
    expect(readPlanFor({ lane: 'history_tied', inRollout: true, docType: 'agreement.loan', pagesRead: true })).toBeNull()
  })

  it('reads loose history one model page deep, then in full only for an acting type', () => {
    expect(readPlanFor({ lane: 'history_loose', inRollout: true, docType: null, pagesRead: false })).toEqual({ lane: 'history_loose', allowModel: true, maxModelPages: 1, tier: 'extraction' })
    expect(readPlanFor({ lane: 'history_loose', inRollout: true, docType: 'agreement.rental', pagesRead: true })).toEqual({ lane: 'history_loose', allowModel: true, maxModelPages: null, tier: 'extraction' })
    expect(readPlanFor({ lane: 'history_loose', inRollout: true, docType: 'receipt', pagesRead: true })).toBeNull()
    expect(readPlanFor({ lane: 'history_loose', inRollout: true, docType: null, pagesRead: true })).toBeNull()
  })
})

describe('needsReadOnDemand', () => {
  it('is true for never read, gated, capped or unconfigured reads, false once the model read every page', () => {
    expect(needsReadOnDemand({ pages_read_at: null, read_error: null })).toBe(true)
    expect(needsReadOnDemand({ pages_read_at: 'x', read_error: 'ai_gated' })).toBe(true)
    expect(needsReadOnDemand({ pages_read_at: 'x', read_error: 'partial:budget' })).toBe(true)
    expect(needsReadOnDemand({ pages_read_at: 'x', read_error: 'partial:ai_unconfigured' })).toBe(true)
    expect(needsReadOnDemand({ pages_read_at: 'x', read_error: null })).toBe(false)
    expect(needsReadOnDemand({ pages_read_at: 'x', read_error: 'download_failed: gone' })).toBe(false)
  })

  it('reads again what an earlier reader could not and a later one can: an oversized photo, a HEIC', () => {
    expect(needsReadOnDemand({ pages_read_at: 'x', read_error: 'read_failed: 400 messages.0.content.0.image.source.base64: image exceeds 5 MB maximum: 6721660 bytes > 5242880 bytes', mime_type: 'image/jpeg' })).toBe(true)
    expect(needsReadOnDemand({ pages_read_at: 'x', read_error: 'unsupported_mime', mime_type: 'image/heic' })).toBe(true)
    expect(needsReadOnDemand({ pages_read_at: 'x', read_error: 'unsupported_mime', mime_type: 'application/zip' })).toBe(false)
    expect(needsReadOnDemand({ pages_read_at: 'x', read_error: 'read_failed: Invalid PDF structure.', mime_type: 'application/pdf' })).toBe(false)
  })
})

describe('historyReaderTier', () => {
  it('is the extraction tier unless the environment moves history to the cheap one', () => {
    delete process.env.ARKIV_HISTORY_READER_TIER
    expect(historyReaderTier()).toBe('extraction')
    process.env.ARKIV_HISTORY_READER_TIER = 'cheap'
    expect(historyReaderTier()).toBe('cheap')
    expect(readPlanFor({ lane: 'history_loose', inRollout: true, docType: null, pagesRead: false })).toMatchObject({ tier: 'cheap' })
    process.env.ARKIV_HISTORY_READER_TIER = 'nonsense'
    expect(historyReaderTier()).toBe('extraction')
    delete process.env.ARKIV_HISTORY_READER_TIER
    // Live documents never carry a tier: the extraction tier reads what arrived today.
    expect(readPlanFor({ lane: 'live', inRollout: true, docType: null, pagesRead: false })).not.toHaveProperty('tier')
  })
})
