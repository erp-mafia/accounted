import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))
vi.mock('@/lib/salary/personnummer', () => ({
  encryptPersonnummer: vi.fn((v: string) => `enc:${v}`),
  decryptPersonnummer: vi.fn((v: string) => v.replace(/^enc:/, '')),
}))

import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { BrfRegisterError } from '../errors'
import {
  apartmentCapitalReconciliation,
  apartmentRegisterCsv,
  apartmentRegisterExtract,
  assignInitialHolder,
  createApartment,
  recordTransfer,
  releasePledge,
  setMemberPersonalNumber,
} from '../apartment-register'

const { supabase, enqueue, reset, calls } = createQueuedMockSupabase()
const client = supabase as unknown as Parameters<typeof createApartment>[0]

const apartment = {
  id: 'a1',
  company_id: 'company-1',
  apartment_number: '1203',
  lantmateriet_number: '1203',
  location: 'Storgatan 1, 2 tr',
  rooms: '3.0',
  kvm: '78.50',
  other_spaces: 'Förråd',
  upplaten_med: 'bostadsratt',
  andelstal_arsavgift: '0.012500',
  andelstal_kapital: '0.012500',
  insats: '150000.00',
  upplatelseavgift: '25000.00',
  upplatelse_date: '1998-01-01',
  ekonomisk_plan_registered_on: '1997-11-03',
  notes: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
})

describe('createApartment', () => {
  it('maps a duplicate beteckning to BRF_APARTMENT_NUMBER_TAKEN', async () => {
    enqueue({ error: { code: '23505', message: 'duplicate' } })
    await expect(
      createApartment(client, 'company-1', 'user-1', { apartment_number: '1203', location: 'x', upplaten_med: 'bostadsratt' }),
    ).rejects.toMatchObject({ code: 'BRF_APARTMENT_NUMBER_TAKEN' })
  })
})

describe('assignInitialHolder', () => {
  it('refuses a share that would take the open holdings above the whole apartment', async () => {
    enqueue({ data: apartment }) // apartment read
    enqueue({ data: { id: 'm2' } }) // member read
    enqueue({ data: [{ id: 'h1', apartment_id: 'a1', member_id: 'm1', share: '0.600000', to_date: null }] }) // open holdings
    await expect(
      assignInitialHolder(client, 'company-1', 'user-1', 'a1', { member_id: 'm2', share: 0.5, from_date: '2026-01-01' }),
    ).rejects.toMatchObject({ code: 'BRF_HOLDING_EXCEEDS_APARTMENT' })
  })

  it('refuses a member outside the register', async () => {
    enqueue({ data: apartment })
    enqueue({ data: null })
    await expect(
      assignInitialHolder(client, 'company-1', 'user-1', 'a1', { member_id: 'm9', share: 0.5, from_date: '2026-01-01' }),
    ).rejects.toBeInstanceOf(BrfRegisterError)
  })
})

describe('recordTransfer', () => {
  const input = {
    from_member_id: 'm1',
    to_member_id: 'm2',
    share: 1,
    transfer_date: '2026-03-01',
    kind: 'sale' as const,
    price: 2_000_000,
  }

  it('checks that the agreement belongs to the company before calling the RPC', async () => {
    enqueue({ data: apartment })
    enqueue({ data: null }) // document lookup
    await expect(
      recordTransfer(client, 'company-1', 'a1', { ...input, agreement_document_id: '11111111-1111-4111-8111-111111111111' }),
    ).rejects.toMatchObject({ code: 'BRF_TRANSFER_DOCUMENT_NOT_FOUND' })
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('maps an RPC refusal to its typed error', async () => {
    enqueue({ data: apartment })
    enqueue({ data: { ok: false, code: 'BRF_TRANSFER_BUYER_NOT_MEMBER' } })
    await expect(recordTransfer(client, 'company-1', 'a1', input)).rejects.toMatchObject({
      code: 'BRF_TRANSFER_BUYER_NOT_MEMBER',
    })
  })

  it('reads the transfer back after a successful RPC', async () => {
    enqueue({ data: apartment })
    enqueue({ data: { ok: true, transfer_id: 't1' } })
    enqueue({ data: { id: 't1', apartment_id: 'a1', share: '1.000000', kind: 'sale' } })
    const row = await recordTransfer(client, 'company-1', 'a1', input)
    expect(row.id).toBe('t1')
    expect(supabase.rpc).toHaveBeenCalledWith(
      'record_brf_transfer',
      expect.objectContaining({
        p_apartment_id: 'a1',
        p_input: expect.objectContaining({
          from_member_id: 'm1',
          to_member_id: 'm2',
          share: 1,
          kind: 'sale',
          price: 2_000_000,
          ku55_uppgifter: 'I',
          forvarv_genom_arv_gava_bodelning: false,
        }),
      }),
    )
  })
})

describe('releasePledge', () => {
  it('refuses to release twice', async () => {
    enqueue({ data: { id: 'p1', released_on: '2026-01-01', notes: null } })
    await expect(releasePledge(client, 'company-1', 'p1', { released_on: '2026-02-01' })).rejects.toMatchObject({
      code: 'BRF_PLEDGE_ALREADY_RELEASED',
    })
  })
})

describe('setMemberPersonalNumber', () => {
  it('stores the ciphertext, never the plaintext', async () => {
    enqueue({ data: { id: 'm1' } })
    enqueue({ data: null })
    await setMemberPersonalNumber(client, 'company-1', 'm1', '850101-1234')
    const update = calls.find((c) => c.table === 'association_members' && c.method === 'update')
    expect(update?.args[0]).toEqual({ personal_number_ciphertext: 'enc:850101-1234' })
  })
})

describe('apartmentRegisterExtract and CSV', () => {
  it('joins current holders and open pledges onto each apartment', async () => {
    enqueue({ data: [apartment] })
    enqueue({ data: [{ id: 'h1', apartment_id: 'a1', member_id: 'm1', share: '0.500000', from_date: '2020-01-01', to_date: null }, { id: 'h2', apartment_id: 'a1', member_id: 'm2', share: '0.500000', from_date: '2021-01-01', to_date: null }] })
    enqueue({ data: [{ id: 'p1', apartment_id: 'a1', creditor: 'Banken AB', notified_on: '2024-05-01', reference: 'L-1', released_on: null }] })
    enqueue({ data: [{ id: 'm1', member_number: '2', name: 'Bo Berg', postal_address: null, admitted_on: '2020-01-01', exited_on: null }, { id: 'm2', member_number: '1', name: 'Anna Alm', postal_address: null, admitted_on: '2021-01-01', exited_on: null }] })
    const rows = await apartmentRegisterExtract(client, 'company-1')
    expect(rows).toHaveLength(1)
    expect(rows[0].holders.map((h) => h.member_number)).toEqual(['1', '2'])
    expect(rows[0].pledges).toEqual([{ creditor: 'Banken AB', notified_on: '2024-05-01', reference: 'L-1' }])
    expect(rows[0].insats).toBe(150000)
    const csv = apartmentRegisterCsv(rows)
    expect(csv.split('\n')[0]).toContain('Lägenhetsbeteckning;Lägenhetsnummer (Lantmäteriet);Belägenhet')
    expect(csv).toContain('Anna Alm (1, 50.00 %), Bo Berg (2, 50.00 %)')
    expect(csv).toContain('Banken AB 2024-05-01 L-1')
  })
})

describe('apartmentCapitalReconciliation', () => {
  it('sums insatser and upplåtelseavgifter of bostadsrätter against 2083 and 2087', async () => {
    enqueue({ data: [apartment, { ...apartment, id: 'a2', apartment_number: '1204', upplaten_med: 'hyresratt', insats: '999.00' }] })
    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [
        { account_number: '2083', closing_credit: 150000, closing_debit: 0 },
        { account_number: '2087', closing_credit: 20000, closing_debit: 0 },
      ],
    } as never)
    const result = await apartmentCapitalReconciliation(client, 'company-1', 'fp-1')
    expect(result.apartments_upplatna).toBe(1)
    expect(result.lines[0]).toMatchObject({ register_amount: 150000, ledger_balance: 150000, difference: 0 })
    expect(result.lines[1]).toMatchObject({ register_amount: 25000, ledger_balance: 20000, difference: -5000 })
    expect(result.is_reconciled).toBe(false)
  })
})
