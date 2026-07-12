import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { encryptPersonnummer } from '@/lib/salary/personnummer'
import { importRotRutBeslutFile, type RotRutBeslutFile } from '../rot-rut-beslut-import'
import type { SupabaseClient } from '@supabase/supabase-js'

const { supabase, enqueue, reset } = createQueuedMockSupabase()
const db = supabase as unknown as SupabaseClient

const REQUEST_ID = '22222222-2222-4222-8222-222222222222'
// Skatteverket official example personnummer (synthetic).
const PNR = '193610058590'
const PNR2 = '193204029064'

const ORG_SETTINGS = { data: { org_number: '878000-3656' } }

function makeRequestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    name: 'ROT 2026-07-02',
    status: 'submitted',
    requested_total: 3000,
    decided_total: null,
    decided_at: null,
    skv_referensnummer: null,
    ...overrides,
  }
}

function makeItemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item-1',
    invoice_id: 'inv-1',
    requested_amount: 3000,
    invoice: {
      invoice_number: '96458',
      deduction_personnummer_encrypted: encryptPersonnummer(PNR),
    },
    ...overrides,
  }
}

function makeFile(overrides: Partial<RotRutBeslutFile> = {}): RotRutBeslutFile {
  return {
    version: '1',
    utforare: '168780003656',
    beslut: [
      {
        namn: 'ROT 2026-07-02',
        referensnummer: '20260000185-01',
        arenden: [{ personnummer: PNR, fakturanummer: '96458', godkantBelopp: 2000 }],
      },
    ],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
})

describe('importRotRutBeslutFile', () => {
  it('rejects a file whose utforare is another company', async () => {
    enqueue({ data: { org_number: '556123-4567' } })

    const result = await importRotRutBeslutFile(db, 'company-1', makeFile())

    expect(result).toEqual({ ok: false, code: 'ROT_RUT_BESLUT_WRONG_COMPANY' })
  })

  it('records the beslut on a name-matched request (fakturanummer match)', async () => {
    enqueue(ORG_SETTINGS)
    enqueue({ data: [makeRequestRow()] })
    enqueue({ data: [makeItemRow()] })
    enqueue({ data: null }) // apply_rot_rut_beslut rpc

    const result = await importRotRutBeslutFile(db, 'company-1', makeFile())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.imported).toBe(1)
    expect(result.results[0]).toMatchObject({
      status: 'imported',
      request_id: REQUEST_ID,
      decided_total: 2000,
      items_updated: 1,
      rejected: false,
    })
    expect(result.results[0].next).toContain(`/api/rot-rut/payout-requests/${REQUEST_ID}/settle`)
    // All writes go through the atomic RPC: items + header in one transaction.
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).toHaveBeenCalledWith('apply_rot_rut_beslut', {
      p_request_id: REQUEST_ID,
      p_items: [{ item_id: 'item-1', decided_amount: 2000 }],
      p_decided_total: 2000,
      p_skv_referensnummer: '20260000185-01',
      p_new_status: 'submitted',
    })
  })

  it('matches by personnummer when fakturanummer is absent', async () => {
    enqueue(ORG_SETTINGS)
    enqueue({ data: [makeRequestRow()] })
    enqueue({ data: [makeItemRow()] })
    enqueue({ data: null }) // apply_rot_rut_beslut rpc

    const file = makeFile()
    file.beslut[0].arenden = [{ personnummer: PNR, godkantBelopp: 1500 }]
    const result = await importRotRutBeslutFile(db, 'company-1', file)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.results[0]).toMatchObject({ status: 'imported', decided_total: 1500 })
  })

  it('flags a 0-kr beslut as rejected (avslag)', async () => {
    enqueue(ORG_SETTINGS)
    enqueue({ data: [makeRequestRow()] })
    enqueue({ data: [makeItemRow()] })
    enqueue({ data: null }) // apply_rot_rut_beslut rpc

    const file = makeFile()
    file.beslut[0].arenden = [{ personnummer: PNR, fakturanummer: '96458', godkantBelopp: 0 }]
    const result = await importRotRutBeslutFile(db, 'company-1', file)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.results[0]).toMatchObject({
      status: 'imported',
      decided_total: 0,
      rejected: true,
    })
    expect(result.results[0].next).toBeUndefined()
    expect(supabase.rpc).toHaveBeenCalledWith(
      'apply_rot_rut_beslut',
      expect.objectContaining({ p_new_status: 'rejected' }),
    )
  })

  it('is idempotent: a request with the same referensnummer already decided reports already_imported', async () => {
    enqueue(ORG_SETTINGS)
    enqueue({
      data: [
        makeRequestRow({
          skv_referensnummer: '20260000185-01',
          decided_at: '2026-07-10T00:00:00Z',
          decided_total: 2000,
        }),
      ],
    })

    const result = await importRotRutBeslutFile(db, 'company-1', makeFile())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.already_imported).toBe(1)
    expect(result.results[0]).toMatchObject({ status: 'already_imported', request_id: REQUEST_ID })
  })

  it('errors on ambiguous names instead of guessing', async () => {
    enqueue(ORG_SETTINGS)
    enqueue({ data: [makeRequestRow(), makeRequestRow({ id: 'other-request' })] })

    const result = await importRotRutBeslutFile(db, 'company-1', makeFile())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.errors).toBe(1)
    expect(result.results[0].status).toBe('error')
    expect(result.results[0].error).toContain('entydigt')
  })

  it('errors when no active request carries the name', async () => {
    enqueue(ORG_SETTINGS)
    enqueue({ data: [makeRequestRow({ name: 'Annat namn' })] })

    const result = await importRotRutBeslutFile(db, 'company-1', makeFile())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.results[0]).toMatchObject({ status: 'error' })
    expect(result.results[0].error).toContain('Ingen aktiv begäran')
  })

  it('applies nothing when an ärende matches no item (all-or-nothing)', async () => {
    enqueue(ORG_SETTINGS)
    enqueue({ data: [makeRequestRow()] })
    enqueue({ data: [makeItemRow()] })

    const file = makeFile()
    file.beslut[0].arenden = [
      { personnummer: PNR, fakturanummer: '96458', godkantBelopp: 2000 },
      // Second ärende matches nothing in the single-item request.
      { personnummer: PNR2, fakturanummer: '9265412', godkantBelopp: 2000 },
    ]
    const result = await importRotRutBeslutFile(db, 'company-1', file)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.results[0].status).toBe('error')
    // Only the three reads happened: settings, requests, items. No writes.
    expect((supabase.from as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('maps an RPC failure to an error outcome (nothing partially applied)', async () => {
    enqueue(ORG_SETTINGS)
    enqueue({ data: [makeRequestRow()] })
    enqueue({ data: [makeItemRow()] })
    enqueue({ error: { message: 'apply_rot_rut_beslut: item item-1 not found on request' } })

    const result = await importRotRutBeslutFile(db, 'company-1', makeFile())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.errors).toBe(1)
    expect(result.results[0]).toMatchObject({
      status: 'error',
      request_id: REQUEST_ID,
      error: expect.stringContaining('not found'),
    })
  })

  it('does not re-decide a request when a later beslut shares the name but not the referensnummer', async () => {
    enqueue(ORG_SETTINGS)
    enqueue({ data: [makeRequestRow()] })
    enqueue({ data: [makeItemRow()] }) // items for the first beslut
    enqueue({ data: null }) // apply_rot_rut_beslut rpc for the first beslut

    const file = makeFile()
    file.beslut.push({
      namn: 'ROT 2026-07-02',
      referensnummer: '20260000186-01',
      arenden: [{ personnummer: PNR, fakturanummer: '96458', godkantBelopp: 3000 }],
    })
    const result = await importRotRutBeslutFile(db, 'company-1', file)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.imported).toBe(1)
    expect(result.errors).toBe(1)
    expect(result.results[0]).toMatchObject({ status: 'imported', decided_total: 2000 })
    // The second beslut must NOT silently overwrite the first decision: the
    // in-memory request is now decided, so name matching finds nothing.
    expect(result.results[1]).toMatchObject({ status: 'error' })
    expect(result.results[1].error).toContain('Ingen aktiv begäran')
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('reports already_imported when the same referensnummer repeats within one file', async () => {
    enqueue(ORG_SETTINGS)
    enqueue({ data: [makeRequestRow()] })
    enqueue({ data: [makeItemRow()] })
    enqueue({ data: null }) // apply_rot_rut_beslut rpc for the first beslut

    const file = makeFile()
    file.beslut.push({ ...file.beslut[0] })
    const result = await importRotRutBeslutFile(db, 'company-1', file)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.imported).toBe(1)
    expect(result.already_imported).toBe(1)
    expect(result.results[1]).toMatchObject({
      status: 'already_imported',
      request_id: REQUEST_ID,
    })
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })
})
