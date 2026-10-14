import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

const mock = vi.hoisted(() => ({ supabase: null as unknown, warn: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => mock.supabase }))
vi.mock('@/lib/auth/bankid', () => ({
  encryptPersonalNumberForStorage: (v: string) => `enc:${v}`,
  decryptStoredPersonalNumber: (v: string) => {
    if (!v.startsWith('enc:')) throw new Error('Unsupported state or unable to authenticate data')
    return v.slice(4)
  },
}))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: (...a: unknown[]) => mock.warn(...a), error: vi.fn(), child: vi.fn() }),
}))

import { rememberBatchPsu, rememberConnectionPsu, storedBatchPsu, storedConnectionPsu } from '../resource-psu'

const NUMBER = '199001011239'
let db: ReturnType<typeof createTableMockSupabase>

beforeEach(() => {
  vi.clearAllMocks()
  db = createTableMockSupabase({ bank_connection_psus: { data: null }, payment_batch_psus: { data: null } })
  mock.supabase = db.supabase
})

/** No log line may ever carry the personnummer, in any form. */
function expectNoNumberLogged() {
  expect(JSON.stringify(mock.warn.mock.calls)).not.toMatch(/19900101|900101|1239/)
}

describe('the PSU-ID a bank consent was created with', () => {
  it('reads back the stored number with its source, and null when none is kept', async () => {
    expect(await storedConnectionPsu('conn-1')).toBeNull()
    db.setTable('bank_connection_psus', { data: { psu_id_enc: `enc:${NUMBER}`, source: 'signatory_link' } })
    expect(await storedConnectionPsu('conn-1')).toEqual({ personalNumber: NUMBER, source: 'signatory_link' })
    expect(db.findCall('bank_connection_psus', 'eq')).toEqual(['connection_id', 'conn-1'])
    expect(mock.warn).not.toHaveBeenCalled()
  })

  it('falls back with one warn line and no value when the stored number cannot be decrypted', async () => {
    db.setTable('bank_connection_psus', { data: { psu_id_enc: '\\xdeadbeef', source: 'typed' } })
    expect(await storedConnectionPsu('conn-1')).toBeNull()
    expect(mock.warn).toHaveBeenCalledTimes(1)
    expect(mock.warn.mock.calls[0]).toEqual(['stored PSU-ID could not be decrypted; falling back', { connectionId: 'conn-1' }])
    expectNoNumberLogged()
  })

  it('falls back with one warn line when the row cannot be read', async () => {
    db.setTable('bank_connection_psus', { data: null, error: { message: 'permission denied for table bank_connection_psus' } })
    expect(await storedConnectionPsu('conn-1')).toBeNull()
    expect(mock.warn).toHaveBeenCalledTimes(1)
    expectNoNumberLogged()
  })

  it('upserts the number encrypted by connection id, and writes nothing for an invalid one', async () => {
    await rememberConnectionPsu({ connectionId: 'conn-1', companyId: 'co-1', personalNumber: '900101-1239', source: 'typed' })
    const [row, options] = db.findCall('bank_connection_psus', 'upsert') as [Record<string, unknown>, unknown]
    expect(row).toMatchObject({ connection_id: 'conn-1', company_id: 'co-1', psu_id_enc: `enc:${NUMBER}`, source: 'typed' })
    expect(JSON.stringify(row)).not.toContain(`"${NUMBER}"`)
    expect(options).toEqual({ onConflict: 'connection_id' })

    db.reset()
    await rememberConnectionPsu({ connectionId: 'conn-1', companyId: 'co-1', personalNumber: '12345', source: 'typed' })
    await rememberConnectionPsu({ connectionId: 'conn-1', companyId: 'co-1', personalNumber: null, source: 'typed' })
    expect(db.findCall('bank_connection_psus', 'upsert')).toBeUndefined()
  })

  it('never fails the caller when the write fails: one warn line, no value', async () => {
    db.setTable('bank_connection_psus', { data: null, error: { message: 'insert failed' } })
    await expect(rememberConnectionPsu({ connectionId: 'conn-1', companyId: 'co-1', personalNumber: NUMBER, source: 'on_file' })).resolves.toBeUndefined()
    expect(mock.warn).toHaveBeenCalledTimes(1)
    expectNoNumberLogged()
  })
})

describe('the PSU-ID a signing\'s payments were created with', () => {
  it('stores it per batch and reads it back; an undecryptable one falls back with a warn line', async () => {
    await rememberBatchPsu({ batchId: 'batch-1', companyId: 'co-1', personalNumber: NUMBER })
    const [row, options] = db.findCall('payment_batch_psus', 'upsert') as [Record<string, unknown>, unknown]
    expect(row).toEqual({ batch_id: 'batch-1', company_id: 'co-1', psu_id_enc: `enc:${NUMBER}` })
    expect(options).toEqual({ onConflict: 'batch_id' })

    expect(await storedBatchPsu('batch-1')).toBeNull()
    db.setTable('payment_batch_psus', { data: { psu_id_enc: `enc:${NUMBER}` } })
    expect(await storedBatchPsu('batch-1')).toBe(NUMBER)

    db.setTable('payment_batch_psus', { data: { psu_id_enc: 'garbage' } })
    expect(await storedBatchPsu('batch-1')).toBeNull()
    expect(mock.warn).toHaveBeenCalledTimes(1)
    expect(mock.warn.mock.calls[0]).toEqual(['stored PSU-ID could not be decrypted; falling back', { batchId: 'batch-1' }])
    expectNoNumberLogged()
  })
})
