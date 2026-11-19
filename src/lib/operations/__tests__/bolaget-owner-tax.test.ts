import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/bolaget/gate', () => ({ bolagetGate: vi.fn() }))
vi.mock('@/lib/bolaget/owner-tax/k10', () => ({ loadK10Year: vi.fn(), saveK10Inputs: vi.fn() }))
vi.mock('@/lib/bolaget/owner-tax/ku20', () => ({ loadKu20Status: vi.fn() }))
vi.mock('@/lib/bolaget/owner-tax/loans', () => ({ createOwnerLoan: vi.fn(), updateOwnerLoan: vi.fn(), setLoanInterest: vi.fn() }))
vi.mock('@/lib/bolaget/owner-tax/loans-view', () => ({ loadOwnerLoansView: vi.fn() }))

import { bolagetGate } from '@/lib/bolaget/gate'
import { loadK10Year } from '@/lib/bolaget/owner-tax/k10'
import { loadKu20Status } from '@/lib/bolaget/owner-tax/ku20'
import { createOwnerLoan } from '@/lib/bolaget/owner-tax/loans'
import { loadOwnerLoansView } from '@/lib/bolaget/owner-tax/loans-view'
import { computeK10 } from '@/lib/bolaget/owner-tax/k10-math'
import { k10Parameters } from '@/lib/bolaget/owner-tax/k10-parameters'
import { operationForPendingType } from '../registry'
import {
  BOLAGET_OWNER_TAX_OPERATIONS,
  k10Get,
  k10InputsSet,
  ku20StatusGet,
  ownerLoansCreate,
  ownerLoansGet,
  ownerLoansSetInterest,
  ownerLoansUpdate,
} from '../bolaget-owner-tax'
import type { OperationContext } from '../types'

const ctx = { supabase: {}, companyId: 'company-1', userId: 'user-1', log: { warn: vi.fn() } } as unknown as OperationContext
const PARTY = '22222222-2222-4222-8222-222222222222'
const LOAN = '33333333-3333-4333-8333-333333333333'

const RESULT = computeK10({
  params: k10Parameters(2026)!,
  shares_at_start: 1_000,
  total_shares_at_start: 1_000,
  uses_basic_amount: true,
  payroll_base: { amount: 0, source: 'payroll', detail_sv: '' },
  own_pay: { amount: 0, source: 'payroll', detail_sv: '' },
  cost_basis: { amount: 25_000, source: 'register', detail_sv: '' },
  saved_dividend_space: { amount: 0, source: 'owner', detail_sv: '' },
  dividend: { amount: 0, source: 'ledger', detail_sv: '' },
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(bolagetGate).mockResolvedValue(null)
})

describe('Bolaget owner tax operations', () => {
  it('are dark outside the rollout and for a form without an aktiebok', async () => {
    vi.mocked(bolagetGate).mockResolvedValueOnce('BOLAGET_DISABLED')
    expect(await k10Get.run(ctx, { income_year: 2026 }, { dryRun: false })).toEqual({ ok: false, code: 'BOLAGET_DISABLED' })
    vi.mocked(bolagetGate).mockResolvedValueOnce('BOLAGET_NOT_FOR_LEGAL_FORM')
    expect(await ownerLoansCreate.run(ctx, { party_id: PARTY, direction: 'borrows', principal: 1, start_date: '2026-01-01' }, { dryRun: true })).toEqual({ ok: false, code: 'BOLAGET_NOT_FOR_LEGAL_FORM' })
    expect(createOwnerLoan).not.toHaveBeenCalled()
  })

  it('reads the K10 year in its output shape, without the payroll employees behind the owner\'s pay', async () => {
    vi.mocked(loadK10Year).mockResolvedValue({
      income_year: 2026,
      supported: true,
      supported_years: [2026],
      unsupported_reason_sv: null,
      parameters: k10Parameters(2026),
      start_date: '2025-12-31',
      famansforetag: { value: true, confirmed: false, top_four_votes_pct: 100 },
      total_shares_at_start: 1_000,
      payroll: { year: 2025, total: 0, runs: 0, opening_balance_amount: 0, employees: 0 },
      owners: [
        {
          party_id: PARTY,
          name: 'Anna Ek',
          identity: 'XXXXXXXX-1234',
          shares_at_start: 1_000,
          dividend_received: 0,
          inputs: { saved_dividend_space: 0, cost_basis_override: null, payroll_base_override: null, own_pay_override: null, uses_basic_amount: true, note: null, updated_at: null },
          inputs_saved: false,
          cost_basis: { register_amount: 25_000, contributions_amount: 0, amount: 25_000, complete: true, gaps: [], gaps_sv: [] },
          own_pay_employees: [{ employee_id: 'emp-1', name: 'Anna Ek', amount: 600_000 }],
          result: RESULT,
          warnings: [],
        },
      ],
      company_holders: [],
    })
    const outcome = await k10Get.run(ctx, k10Get.input.parse({ income_year: '2026' }), { dryRun: false })
    expect(outcome.ok).toBe(true)
    const data = (outcome as { data: Record<string, unknown> }).data
    expect(k10Get.output.safeParse(data).success).toBe(true)
    expect(JSON.stringify(data)).not.toContain('own_pay_employees')
    expect(vi.mocked(loadK10Year).mock.calls[0]![1]).toBe(2026)
  })

  it('reads the loans and the KU20 status in their output shapes', async () => {
    vi.mocked(loadOwnerLoansView).mockResolvedValue({ as_of: '2026-10-29', loans: [], reconciliation: [{ account: '2893', register_amount: 1, ledger_amount: 1, difference: 0, matches: true, owner_loan_ids: [] }], flagged: 0 })
    const loans = await ownerLoansGet.run(ctx, {}, { dryRun: false })
    expect(ownerLoansGet.output.safeParse((loans as { data: unknown }).data).success).toBe(true)
    vi.mocked(loadKu20Status).mockResolvedValue({
      income_year: 2026,
      deadline: '2027-01-31',
      file_supported: true,
      famansforetag: { value: true, confirmed: true },
      recipients: [{ party_id: PARTY, name: 'Anna Ek', identity: 'XXXXXXXX-1234', interest: 8_000, tax_withheld: 2_400, reported_interest: 8_000, reported_tax: 2_400, delagare: true, expected_tax: 2_400, reason: null }],
      legal_person_interest: 0,
      contact: { name: null, phone: null, email: null },
      blockers: [{ code: 'KU20_CONTACT_MISSING', message_sv: 'x' }],
      warnings: [],
      ready: false,
    })
    const status = await ku20StatusGet.run(ctx, ku20StatusGet.input.parse({ income_year: '2026' }), { dryRun: false })
    expect(ku20StatusGet.output.safeParse((status as { data: unknown }).data).success).toBe(true)
  })

  it('never takes a personnummer: the inputs are strict', () => {
    expect(ownerLoansCreate.input.safeParse({ party_name: 'Bo', direction: 'lends', principal: 1, start_date: '2026-01-01', personnummer: '198001011234' }).success).toBe(false)
    expect(k10InputsSet.input.safeParse({ party_id: PARTY, income_year: 2026, personnummer: '198001011234' }).success).toBe(false)
    const shape = (ku20StatusGet.output as unknown as { shape: Record<string, unknown> }).shape
    expect(Object.keys(shape)).not.toContain('personnummer')
  })

  it('takes only the owner loan accounts and the known statuses', () => {
    const base = { party_id: PARTY, direction: 'lends', principal: 1, start_date: '2026-01-01' }
    expect(ownerLoansCreate.input.safeParse({ ...base, account: '1685' }).success).toBe(true)
    expect(ownerLoansCreate.input.safeParse({ ...base, account: '1360' }).success).toBe(true)
    expect(ownerLoansCreate.input.safeParse({ ...base, account: '1930' }).success).toBe(false)
    expect(ownerLoansUpdate.input.safeParse({ owner_loan_id: LOAN, status: 'forgiven' }).success).toBe(false)
    expect(ownerLoansSetInterest.input.safeParse({ owner_loan_id: LOAN, income_year: 2026, interest_amount: -1 }).success).toBe(false)
  })

  it('stages every write under its pending type with a Swedish title; none of them books', async () => {
    const writes = BOLAGET_OWNER_TAX_OPERATIONS.filter((o) => o.kind === 'write')
    expect(writes.map((o) => o.mcp?.stage?.pendingType)).toEqual(['set_k10_owner_inputs', 'create_owner_loan', 'update_owner_loan', 'set_owner_loan_interest'])
    for (const op of writes) expect(operationForPendingType(op.mcp!.stage!.pendingType)).toBe(op)
    expect(writes.every((o) => o.risk !== 'high')).toBe(true)
    expect(ownerLoansCreate.mcp?.stage?.title({ direction: 'borrows' })).toBe('Lån från ägare eller närstående')
    expect(ownerLoansCreate.mcp?.stage?.title({ direction: 'lends', kind: 'security' })).toBe('Säkerhet för ägare eller närstående')
    expect(k10InputsSet.mcp?.stage?.title({ income_year: 2026 })).toBe('K10-underlag 2026')
  })

  it('names the loan counterparty by party_id or by name', async () => {
    vi.mocked(createOwnerLoan).mockResolvedValueOnce({ ok: true, dryRun: true, preview: {} })
    await ownerLoansCreate.run(ctx, { party_name: 'Bo Ek', party_kind: 'person', direction: 'borrows', principal: 500, start_date: '2026-03-01' }, { dryRun: true })
    expect(vi.mocked(createOwnerLoan).mock.calls[0]![1]).toMatchObject({ party: { party_id: null, name: 'Bo Ek', kind: 'person', org_number: null }, principal: 500 })
  })

  it('has no door for the KU20 file or the PDFs', () => {
    const ids = BOLAGET_OWNER_TAX_OPERATIONS.map((o) => o.id)
    expect(ids).toEqual(['k10.get', 'owner-loans.get', 'ku20.status.get', 'k10-inputs.set', 'owner-loans.create', 'owner-loans.update', 'owner-loans.set-interest'])
  })
})
