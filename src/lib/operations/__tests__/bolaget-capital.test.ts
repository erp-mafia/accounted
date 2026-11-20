import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/bolaget/gate', () => ({ bolagetGate: vi.fn() }))
vi.mock('@/lib/bolaget/capital/view', () => ({ loadCapitalView: vi.fn() }))
vi.mock('@/lib/bolaget/capital/ku31', () => ({ loadKu31Status: vi.fn() }))
vi.mock('@/lib/bolaget/capital/dividends', () => ({ createDividend: vi.fn(), bookDividend: vi.fn(), payDividend: vi.fn() }))
vi.mock('@/lib/bolaget/capital/contributions', () => ({ createShareholderContribution: vi.fn() }))
vi.mock('@/lib/bolaget/capital/capital-changes', () => ({ createCapitalChange: vi.fn(), bookCapitalChange: vi.fn() }))

import { bolagetGate } from '@/lib/bolaget/gate'
import { loadCapitalView } from '@/lib/bolaget/capital/view'
import { loadKu31Status } from '@/lib/bolaget/capital/ku31'
import { bookDividend, createDividend } from '@/lib/bolaget/capital/dividends'
import { createShareholderContribution } from '@/lib/bolaget/capital/contributions'
import { operationForPendingType } from '../registry'
import {
  BOLAGET_CAPITAL_OPERATIONS,
  capitalChangesBook,
  capitalChangesCreate,
  capitalEventsGet,
  dividendsBook,
  dividendsCreate,
  dividendsPay,
  ku31StatusGet,
  shareholderContributionsCreate,
} from '../bolaget-capital'
import type { OperationContext } from '../types'

const ctx = { supabase: {}, companyId: 'company-1', userId: 'user-1', log: { warn: vi.fn() } } as unknown as OperationContext
const DIVIDEND = '22222222-2222-4222-8222-222222222222'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(bolagetGate).mockResolvedValue(null)
})

describe('Bolaget capital operations', () => {
  it('are dark outside the rollout and for a form without an aktiebok', async () => {
    vi.mocked(bolagetGate).mockResolvedValueOnce('BOLAGET_DISABLED')
    expect(await capitalEventsGet.run(ctx, {}, { dryRun: false })).toEqual({ ok: false, code: 'BOLAGET_DISABLED' })
    vi.mocked(bolagetGate).mockResolvedValueOnce('BOLAGET_NOT_FOR_LEGAL_FORM')
    expect(await dividendsCreate.run(ctx, { decided_on: '2026-05-01', decided_by: 'arsstamma', amount_per_share: 1 }, { dryRun: true })).toEqual({
      ok: false,
      code: 'BOLAGET_NOT_FOR_LEGAL_FORM',
    })
    expect(createDividend).not.toHaveBeenCalled()
  })

  it('reads the capital events and the KU31 status in their output shape', async () => {
    vi.mocked(loadCapitalView).mockResolvedValue({ dividends: [], contributions: [], capital_changes: [] })
    const events = await capitalEventsGet.run(ctx, {}, { dryRun: false })
    expect(capitalEventsGet.output.safeParse((events as { data: unknown }).data).success).toBe(true)

    vi.mocked(loadKu31Status).mockResolvedValue({
      income_year: 2026,
      deadline: '2027-01-31',
      schema_version: '12.0',
      file_supported: true,
      dividends: [],
      unbooked_dividends: 0,
      recipients: [{ party_id: 'p1', name: 'Anna Ek', kind: 'person', identity: 'XXXXXXXX-1234', amount: 100.5, reported_amount: 100, reported: true, reason: null }],
      famansforetag: true,
      famansforetag_derivation: { derived: true, top_four_votes_pct: 100, holders: 1 },
      contact: { name: 'Anna Ek', phone: '070', email: 'a@b.se' },
      last_generated_at: null,
      blockers: [],
      ready: true,
    })
    const status = await ku31StatusGet.run(ctx, ku31StatusGet.input.parse({ income_year: '2026' }), { dryRun: false })
    expect(status).toMatchObject({ ok: true, data: { income_year: 2026, ready: true } })
    expect(ku31StatusGet.output.safeParse((status as { data: unknown }).data).success).toBe(true)
    expect(vi.mocked(loadKu31Status).mock.calls[0]![1]).toBe(2026)
  })

  it('never takes a personnummer: the inputs are strict', () => {
    expect(dividendsCreate.input.safeParse({ decided_on: '2026-05-01', decided_by: 'arsstamma', amount_per_share: 1, personnummer: '198001011234' }).success).toBe(false)
    expect(shareholderContributionsCreate.input.safeParse({ holder_name: 'Bo', promised_on: '2026-01-01', amount: 1, personnummer: '198001011234' }).success).toBe(false)
    expect(capitalChangesCreate.input.safeParse({ kind: 'nyemission', decided_on: '2026-01-01', decided_by: 'styrelse', share_count: 1, allotments: [{ name: 'Bo', share_count: 1, personnummer: 'x' }] }).success).toBe(false)
  })

  it('only a stämma decides a dividend; only BAS 2098 or 2091 are its source', () => {
    expect(dividendsCreate.input.safeParse({ decided_on: '2026-05-01', decided_by: 'styrelse', amount_per_share: 1 }).success).toBe(false)
    expect(dividendsBook.input.safeParse({ dividend_id: DIVIDEND, source_account: '2099' }).success).toBe(false)
    expect(dividendsBook.input.safeParse({ dividend_id: DIVIDEND, source_account: '2091' }).success).toBe(true)
    expect(dividendsPay.input.safeParse({ dividend_id: DIVIDEND, bank_account: '1930' }).success).toBe(true)
    expect(dividendsPay.input.safeParse({ dividend_id: DIVIDEND, bank_account: '2898' }).success).toBe(false)
  })

  it('stages every write; the ones that post are high risk with a Swedish title', async () => {
    for (const op of BOLAGET_CAPITAL_OPERATIONS.filter((o) => o.kind === 'write')) {
      expect(op.mcp?.stage, op.id).toBeDefined()
      expect(operationForPendingType(op.mcp!.stage!.pendingType)).toBe(op)
    }
    expect([dividendsBook, dividendsPay, shareholderContributionsCreate, capitalChangesBook].map((o) => o.risk)).toEqual(['high', 'high', 'high', 'high'])
    expect(dividendsCreate.mcp?.stage?.title({ decided_on: '2026-05-01' })).toBe('Utdelning beslutad 2026-05-01')
    vi.mocked(bookDividend).mockResolvedValueOnce({ ok: true, dryRun: true, preview: {} })
    await dividendsBook.run({ ...ctx, pendingOperationId: 'po-1' }, { dividend_id: DIVIDEND }, { dryRun: true })
    expect(vi.mocked(bookDividend).mock.calls[0]![0]).toMatchObject({ pendingOperationId: 'po-1' })
  })

  it('names the contribution\'s holder by party_id or by name', async () => {
    vi.mocked(createShareholderContribution).mockResolvedValueOnce({ ok: true, dryRun: true, preview: {} })
    await shareholderContributionsCreate.run(ctx, { holder_name: 'Anna Ek', promised_on: '2026-03-01', amount: 500 }, { dryRun: true })
    expect(vi.mocked(createShareholderContribution).mock.calls[0]![1]).toMatchObject({ holder: { party_id: null, name: 'Anna Ek', kind: null, org_number: null }, amount: 500 })
  })

  it('has no door for the KU31 file: no operation answers personnummer', () => {
    const ids = BOLAGET_CAPITAL_OPERATIONS.map((o) => o.id)
    expect(ids).not.toContain('ku31.file.get')
    const shape = (ku31StatusGet.output as unknown as { shape: Record<string, unknown> }).shape
    expect(Object.keys(shape)).not.toContain('personnummer')
  })
})
