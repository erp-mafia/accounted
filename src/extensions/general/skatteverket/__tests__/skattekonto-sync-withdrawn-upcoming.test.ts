/**
 * Tests for upcoming rows Skatteverket withdraws.
 *
 * SKV's kommandeTransaktioner is its whole current forecast. A kommande row
 * one sync stored and a later response no longer carries (a debit that will
 * not happen, or one reissued with another date, amount or text) used to stay
 * in skattekonto_transactions as "upcoming" for good: nothing ever removed it,
 * so the app kept announcing a draw Skatteverket had cancelled.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { computeDedupKey } from '@/lib/skatteverket/skattekonto-dedup'

const { supabase, enqueue, reset, findCalls, calls } = createQueuedMockSupabase()

/** The builder calls of the delete chain only, so its own filters are judged. */
function deleteChain(): { method: string; args: unknown[] }[] {
  const start = calls.findIndex(c => c.table === 'skattekonto_transactions' && c.method === 'delete')
  if (start < 0) return []
  const chain: { method: string; args: unknown[] }[] = []
  for (const c of calls.slice(start + 1)) {
    if (c.table !== 'skattekonto_transactions' || c.method === 'select') break
    chain.push({ method: c.method, args: c.args })
  }
  return chain
}

const getSaldoMock = vi.fn()
const getTransaktionerMock = vi.fn()
vi.mock('../lib/skattekonto-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/skattekonto-client')>()),
  getSaldo: (...args: unknown[]) => getSaldoMock(...args),
  getTransaktioner: (...args: unknown[]) => getTransaktionerMock(...args),
}))

vi.mock('../lib/agi-tax-settlement', () => ({
  settleAgiTaxPayments: vi.fn().mockResolvedValue(undefined),
}))

import { syncSkattekonto } from '../lib/skattekonto-sync'
import type { ExtensionContext } from '@/lib/extensions/types'

function makeCtx(): ExtensionContext {
  return {
    supabase,
    companyId: 'company-1',
    userId: 'user-1',
    settings: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    },
    emit: vi.fn().mockResolvedValue(undefined),
  } as unknown as ExtensionContext
}

function makeSaldo() {
  return {
    nastaAvstamningsdatum: '2026-12-05',
    senastUppdaterad: '2026-11-25T03:04:57Z',
    informationstext: [],
    saldoSkatteverket: 535,
    saldoKronofogden: 0,
    rantaSkatteverket: 0,
    rantaKronofogden: 0,
    ocrNummer: '1234567897',
  }
}

// The kommande row an early sync stored: a monthly F-skatt debit.
const WITHDRAWN = {
  transaktionsidentitet: null,
  transaktionsdatum: '2026-12-14',
  forfallodatum: '2026-12-14',
  ranteberakningsdatum: '2026-12-15',
  transaktionstext: 'Debiterad preliminärskatt',
  beloppSkatteverket: 10213,
  beloppKronofogden: null,
}
const WITHDRAWN_KEY = computeDedupKey(WITHDRAWN)

describe('syncSkattekonto: upcoming rows Skatteverket withdrew', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    getSaldoMock.mockResolvedValue(makeSaldo())
  })

  it('removes a stored upcoming row the next response no longer carries', async () => {
    getTransaktionerMock.mockResolvedValue({ tidigareTransaktioner: [], kommandeTransaktioner: [], listed: true })

    enqueue({ data: { org_number: '556677-8899', entity_type: 'aktiebolag' } }) // company_settings
    enqueue({ data: [] }) // fiscal_periods: none
    enqueue({ data: [{ id: 'row-withdrawn', dedup_key: WITHDRAWN_KEY }] }) // stored upcoming rows
    enqueue({ data: [{ id: 'row-withdrawn' }] }) // delete

    await syncSkattekonto(makeCtx())

    expect(findCalls('skattekonto_transactions', 'delete')).toHaveLength(1)
    // The delete itself repeats the guards, so a row linked or ignored
    // between the read and the delete is kept.
    const chain = deleteChain()
    expect(chain).toContainEqual({ method: 'in', args: ['id', ['row-withdrawn']] })
    expect(chain).toContainEqual({ method: 'eq', args: ['company_id', 'company-1'] })
    expect(chain).toContainEqual({ method: 'eq', args: ['status', 'upcoming'] })
    expect(chain).toContainEqual({ method: 'eq', args: ['is_ignored', false] })
    expect(chain).toContainEqual({ method: 'is', args: ['journal_entry_id', null] })
  })

  it('removes nothing when the body carried no list at all', async () => {
    // The client fills in empty lists for a body without them; that is not
    // Skatteverket saying every upcoming row was withdrawn.
    getTransaktionerMock.mockResolvedValue({ tidigareTransaktioner: [], kommandeTransaktioner: [], listed: false })

    enqueue({ data: { org_number: '556677-8899', entity_type: 'aktiebolag' } }) // company_settings
    enqueue({ data: [] }) // fiscal_periods: none
    enqueue({ data: [{ id: 'row-withdrawn', dedup_key: WITHDRAWN_KEY }] }) // would be the read

    await syncSkattekonto(makeCtx())

    expect(findCalls('skattekonto_transactions', 'delete')).toHaveLength(0)
    expect(findCalls('skattekonto_transactions', 'eq')).not.toContainEqual(['status', 'upcoming'])
  })

  it('reads only unlinked, unignored upcoming rows the API wrote', async () => {
    getTransaktionerMock.mockResolvedValue({ tidigareTransaktioner: [], kommandeTransaktioner: [], listed: true })

    enqueue({ data: { org_number: '556677-8899', entity_type: 'aktiebolag' } }) // company_settings
    enqueue({ data: [] }) // fiscal_periods: none
    enqueue({ data: [] }) // stored upcoming rows: none

    await syncSkattekonto(makeCtx())

    const eqs = findCalls('skattekonto_transactions', 'eq')
    expect(eqs).toContainEqual(['source', 'api'])
    expect(eqs).toContainEqual(['status', 'upcoming'])
    expect(eqs).toContainEqual(['is_ignored', false])
    expect(findCalls('skattekonto_transactions', 'is')).toContainEqual(['journal_entry_id', null])
    expect(findCalls('skattekonto_transactions', 'delete')).toHaveLength(0)
  })

  it('keeps an upcoming row the response still carries', async () => {
    getTransaktionerMock.mockResolvedValue({
      tidigareTransaktioner: [],
      kommandeTransaktioner: [WITHDRAWN],
      listed: true,
    })

    enqueue({ data: { org_number: '556677-8899', entity_type: 'aktiebolag' } }) // company_settings
    enqueue({ data: [] }) // fiscal_periods: none
    enqueue({ data: [{ dedup_key: WITHDRAWN_KEY, status: 'upcoming' }] }) // existing dedup_key lookup
    enqueue({ data: null }) // upsert
    enqueue({ data: [{ id: 'row-current', dedup_key: WITHDRAWN_KEY }] }) // stored upcoming rows

    await syncSkattekonto(makeCtx())

    expect(findCalls('skattekonto_transactions', 'upsert')).toHaveLength(1)
    expect(findCalls('skattekonto_transactions', 'delete')).toHaveLength(0)
  })

  it('removes nothing when a kommande row came back unusable', async () => {
    // SKV has returned rows without beloppSkatteverket; such a row may be one
    // of the stored rows, so the response cannot prove anything withdrawn.
    getTransaktionerMock.mockResolvedValue({
      tidigareTransaktioner: [],
      kommandeTransaktioner: [{ ...WITHDRAWN, beloppSkatteverket: undefined }],
      listed: true,
    })

    enqueue({ data: { org_number: '556677-8899', entity_type: 'aktiebolag' } }) // company_settings
    enqueue({ data: [] }) // fiscal_periods: none
    enqueue({ data: [{ id: 'row-withdrawn', dedup_key: WITHDRAWN_KEY }] }) // would be the read

    await syncSkattekonto(makeCtx())

    expect(findCalls('skattekonto_transactions', 'delete')).toHaveLength(0)
    expect(findCalls('skattekonto_transactions', 'eq')).not.toContainEqual(['status', 'upcoming'])
  })

  it('a failed removal does not fail the sync', async () => {
    getTransaktionerMock.mockResolvedValue({ tidigareTransaktioner: [], kommandeTransaktioner: [], listed: true })

    enqueue({ data: { org_number: '556677-8899', entity_type: 'aktiebolag' } }) // company_settings
    enqueue({ data: [] }) // fiscal_periods: none
    enqueue({ data: [{ id: 'row-withdrawn', dedup_key: WITHDRAWN_KEY }] }) // stored upcoming rows
    enqueue({ data: null, error: { message: 'boom' } }) // delete fails

    await expect(syncSkattekonto(makeCtx())).resolves.toMatchObject({ upcoming: 0 })
  })
})
