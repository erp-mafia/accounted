import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { SalesInvoiceDto } from '@/lib/providers/dto'
import { eventBus } from '@/lib/events/bus'
import { BookkeepingDatabaseError } from '@/lib/bookkeeping/errors'
import { createTableMockSupabase } from '@/tests/helpers'
import { planMigratedDeduction, type MigratedDeductionPlan, type PlanInvoice } from '../migrated-deduction-plan'

const { createJournalEntry, findFiscalPeriod, encryptPersonnummer, activateAccounts } = vi.hoisted(() => ({
  createJournalEntry: vi.fn(),
  findFiscalPeriod: vi.fn(),
  encryptPersonnummer: vi.fn(),
  activateAccounts: vi.fn(),
}))

// The real createMigratedDeductionEntry runs; only the engine under it is mocked.
vi.mock('@/lib/bookkeeping/engine', () => ({ createJournalEntry, findFiscalPeriod }))
vi.mock('@/lib/bookkeeping/chart-of-accounts-service', () => ({ activateAccounts }))
vi.mock('@/lib/salary/personnummer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/personnummer')>()),
  encryptPersonnummer,
}))

import {
  applyMigratedDeduction,
  ensureDeductionAccounts,
  repairMigratedInvoiceStatus,
} from '../migrated-deduction-apply'

const RPC = 'rpc:apply_migrated_invoice_deduction'
const TODAY = '2026-10-14'
const NOW = new Date('2026-10-14T10:00:00Z')
// A Luhn-valid test personnummer, and its 12-digit form the planner hands on.
const BUYER = '19121212-1212'
const BUYER_12 = '191212121212'
const ENCRYPTED = 'v1:ciphertext-blob'
const TRAIL = { provider: 'visma', consentId: 'consent-1', correlationId: 'corr-1' }
const OPTIONS = { bookingDate: TODAY, invoiceNumber: '1042', trail: TRAIL }

const mock = createTableMockSupabase()
const supabase = mock.supabase as unknown as SupabaseClient

function invoice(overrides: Partial<PlanInvoice> = {}): PlanInvoice {
  return {
    id: 'inv-1',
    invoice_number: '1042',
    status: 'sent',
    currency: 'SEK',
    total: 10000,
    paid_amount: 0,
    deduction_total: 0,
    items: [
      { id: 'item-work', sort_order: 1, line_type: 'product', quantity: 12, unit: 'tim', line_total: 6000, vat_amount: 1500 },
      { id: 'item-material', sort_order: 2, line_type: 'product', quantity: 1, unit: 'st', line_total: 2000, vat_amount: 500 },
    ],
    payment_count: 0,
    reclassification_voucher_id: null,
    ...overrides,
  }
}

// 6 000 + 1 500 moms of RUT work: a 50 % deduction of 3 750.
function dto(withDeduction = true): SalesInvoiceDto {
  return {
    id: 'visma-1',
    invoiceNumber: '1042',
    issueDate: '2026-08-28',
    currencyCode: 'SEK',
    status: 'sent',
    supplier: { name: '', identifications: [] },
    customer: { name: 'Privatkund', identifications: [] },
    lines: [
      {
        id: '1',
        lineExtensionAmount: { value: 6000, currencyCode: 'SEK' },
        householdWork: { workType: 'STAD', providerWorkType: '9', hours: 12 },
      },
      { id: '2', lineExtensionAmount: { value: 2000, currencyCode: 'SEK' } },
    ],
    legalMonetaryTotal: { payableAmount: { value: 10000, currencyCode: 'SEK' } },
    paymentStatus: { paid: false, balance: { value: 10000, currencyCode: 'SEK' }, source: 'enum' },
    householdDeduction: withDeduction
      ? { kind: 'rut', amount: 3750, buyers: [{ personnummer: BUYER, amount: 3750 }], providerState: 'open' }
      : undefined,
  }
}

function applyPlan(overrides: Partial<PlanInvoice> = {}): Extract<MigratedDeductionPlan, { outcome: 'apply' }> {
  const plan = planMigratedDeduction(invoice(overrides), dto(), { today: TODAY, now: NOW })
  if (plan.outcome !== 'apply') throw new Error(`expected an apply plan, got ${plan.outcome}`)
  return plan
}

function statusPlan(): Extract<MigratedDeductionPlan, { outcome: 'status_only' }> {
  const plan = planMigratedDeduction(invoice({ paid_amount: 1000 }), dto(false), { today: TODAY, now: NOW })
  if (plan.outcome !== 'status_only') throw new Error(`expected a status_only plan, got ${plan.outcome}`)
  return plan
}

/** The args object of every apply_migrated_invoice_deduction call, in order. */
function rpcArgs(): Array<Record<string, unknown>> {
  return mock.findCalls(RPC, 'rpc').map((args) => args[0] as Record<string, unknown>)
}

const DRY_RUN_OK = { data: { ok: true, applied: false, status: 'sent', remaining_amount: 10000 } }
const APPLIED = { data: { ok: true, applied: true, status: 'sent', remaining_amount: '6250.00' } }

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mock.reset()
  findFiscalPeriod.mockResolvedValue('fp-2026')
  createJournalEntry.mockResolvedValue({ id: 'je-1' })
  encryptPersonnummer.mockReturnValue(ENCRYPTED)
})

describe('applyMigratedDeduction', () => {
  it('runs the dry run before any voucher, then books, then writes with the voucher', async () => {
    mock.setTable(RPC, [DRY_RUN_OK, APPLIED])

    const outcome = await applyMigratedDeduction(supabase, 'company-1', 'user-1', applyPlan(), OPTIONS)

    expect(outcome).toEqual({ ok: true, applied: true, status: 'sent', remainingAmount: 6250, journalEntryId: 'je-1' })
    const [check, write] = rpcArgs()
    expect(check).toMatchObject({ p_dry_run: true, p_journal_entry_id: null, p_invoice_id: 'inv-1', p_company_id: 'company-1' })
    expect(write).toMatchObject({ p_dry_run: false, p_journal_entry_id: 'je-1', p_invoice_id: 'inv-1', p_company_id: 'company-1' })
    const [checkOrder, writeOrder] = mock.supabase.rpc.mock.invocationCallOrder
    const [bookOrder] = createJournalEntry.mock.invocationCallOrder
    expect(checkOrder).toBeLessThan(bookOrder)
    expect(bookOrder).toBeLessThan(writeOrder)
  })

  it('books debit 1513 / credit 1510 for the deduction, dated the booking day, sourced to the invoice', async () => {
    mock.setTable(RPC, [DRY_RUN_OK, APPLIED])

    await applyMigratedDeduction(supabase, 'company-1', 'user-1', applyPlan(), OPTIONS)

    expect(findFiscalPeriod).toHaveBeenCalledExactlyOnceWith(supabase, 'company-1', TODAY)
    expect(createJournalEntry).toHaveBeenCalledTimes(1)
    const [client, companyId, userId, input] = createJournalEntry.mock.calls[0]
    expect(client).toBe(supabase)
    expect(companyId).toBe('company-1')
    expect(userId).toBe('user-1')
    const description = 'RUT-avdrag faktura 1042, omföring vid systembyte'
    expect(input).toEqual({
      fiscal_period_id: 'fp-2026',
      entry_date: TODAY,
      description,
      source_type: 'rot_rut_reclassification',
      source_id: 'inv-1',
      lines: [
        { account_number: '1513', debit_amount: 3750, credit_amount: 0, line_description: description },
        { account_number: '1510', debit_amount: 0, credit_amount: 3750, line_description: description },
      ],
    })
  })

  it('a dry-run refusal books nothing and returns the code', async () => {
    mock.setTable(RPC, { data: { ok: false, code: 'DRIFT' } })

    const outcome = await applyMigratedDeduction(supabase, 'company-1', 'user-1', applyPlan(), OPTIONS)

    expect(outcome).toEqual({ ok: false, kind: 'refused', code: 'DRIFT', journalEntryId: null })
    expect(findFiscalPeriod).not.toHaveBeenCalled()
    expect(createJournalEntry).not.toHaveBeenCalled()
    expect(rpcArgs()).toHaveLength(1)
  })

  it('a dry run that errors books nothing (stage check)', async () => {
    const rpcError = { message: 'connection reset', code: '08006' }
    mock.setTable(RPC, { error: rpcError })

    const outcome = await applyMigratedDeduction(supabase, 'company-1', 'user-1', applyPlan(), OPTIONS)

    expect(outcome).toEqual({ ok: false, kind: 'error', stage: 'check', error: rpcError, journalEntryId: null })
    expect(createJournalEntry).not.toHaveBeenCalled()
    expect(rpcArgs()).toHaveLength(1)
  })

  it('reuses the voucher an earlier run posted instead of booking another', async () => {
    mock.setTable(RPC, [DRY_RUN_OK, APPLIED])

    const plan = applyPlan({ reclassification_voucher_id: 'je-earlier' })
    expect(plan.reuseVoucherId).toBe('je-earlier')
    const outcome = await applyMigratedDeduction(supabase, 'company-1', 'user-1', plan, OPTIONS)

    expect(createJournalEntry).not.toHaveBeenCalled()
    expect(findFiscalPeriod).not.toHaveBeenCalled()
    const [check, write] = rpcArgs()
    expect(check).toMatchObject({ p_dry_run: true, p_journal_entry_id: null })
    expect(write).toMatchObject({ p_dry_run: false, p_journal_entry_id: 'je-earlier' })
    expect(outcome).toMatchObject({ ok: true, journalEntryId: 'je-earlier' })
  })

  it.each([
    ['a unique violation (23505)', new BookkeepingDatabaseError('create_draft_entry', 'duplicate key value', '23505')],
    [
      'the reclassification index in the cause',
      new BookkeepingDatabaseError(
        'commit_entry',
        'duplicate key value violates unique constraint "journal_entries_rot_rut_reclassification_live_unique"',
      ),
    ],
  ])('on a duplicate voucher (%s) looks up the live one and uses it', async (_label, duplicate) => {
    mock.setTable(RPC, [DRY_RUN_OK, APPLIED])
    mock.setTable('journal_entries', { data: { id: 'je-winner' } })
    createJournalEntry.mockRejectedValue(duplicate)

    const outcome = await applyMigratedDeduction(supabase, 'company-1', 'user-1', applyPlan(), OPTIONS)

    expect(outcome).toMatchObject({ ok: true, journalEntryId: 'je-winner' })
    expect(rpcArgs()[1]).toMatchObject({ p_dry_run: false, p_journal_entry_id: 'je-winner' })
    expect(mock.findCalls('journal_entries', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['source_type', 'rot_rut_reclassification'],
      ['source_id', 'inv-1'],
      ['status', 'posted'],
    ])
  })

  it('a duplicate whose live voucher cannot be found fails at book and writes nothing', async () => {
    const duplicate = new BookkeepingDatabaseError('create_draft_entry', 'duplicate key value', '23505')
    mock.setTable(RPC, [DRY_RUN_OK, APPLIED])
    mock.setTable('journal_entries', { data: null })
    createJournalEntry.mockRejectedValue(duplicate)

    const outcome = await applyMigratedDeduction(supabase, 'company-1', 'user-1', applyPlan(), OPTIONS)

    expect(outcome).toEqual({ ok: false, kind: 'error', stage: 'book', error: duplicate, journalEntryId: null })
    expect(rpcArgs()).toHaveLength(1)
  })

  it('an engine error that is not a duplicate fails at book without a lookup or a write', async () => {
    mock.setTable(RPC, [DRY_RUN_OK, APPLIED])
    findFiscalPeriod.mockResolvedValue(null)

    const outcome = await applyMigratedDeduction(supabase, 'company-1', 'user-1', applyPlan(), OPTIONS)

    expect(outcome).toMatchObject({ ok: false, kind: 'error', stage: 'book', journalEntryId: null })
    expect((outcome as { error: Error }).error.message).toBe(`No open fiscal period found for booking date ${TODAY}`)
    expect(createJournalEntry).not.toHaveBeenCalled()
    expect(mock.tables()).not.toContain('journal_entries')
    expect(rpcArgs()).toHaveLength(1)
  })

  it('sends the encrypted personnummer and its last four digits, never the plain one', async () => {
    mock.setTable(RPC, [DRY_RUN_OK, APPLIED])
    const plan = applyPlan()

    await applyMigratedDeduction(supabase, 'company-1', 'user-1', plan, OPTIONS)

    expect(encryptPersonnummer).toHaveBeenCalledWith(BUYER_12)
    const calls = rpcArgs()
    expect(calls).toHaveLength(2)
    for (const args of calls) {
      expect(args.p_deduction).toEqual({
        deduction_type: 'rut',
        deduction_total: 3750,
        personnummer_encrypted: ENCRYPTED,
        personnummer_last4: '1212',
        paid_on: null,
        items: plan.items,
      })
      expect(args.p_expected).toEqual(plan.expected)
      expect(args.p_trail).toEqual({ provider: 'visma', consent_id: 'consent-1', correlation_id: 'corr-1' })
      const wire = JSON.stringify(args)
      expect(wire).not.toContain(BUYER_12)
      expect(wire).not.toContain(BUYER)
    }
  })

  it('an RPC error after the voucher reports stage apply with the voucher id', async () => {
    const rpcError = { message: 'deadlock detected', code: '40P01' }
    mock.setTable(RPC, [DRY_RUN_OK, { error: rpcError }])

    const outcome = await applyMigratedDeduction(supabase, 'company-1', 'user-1', applyPlan(), OPTIONS)

    expect(outcome).toEqual({ ok: false, kind: 'error', stage: 'apply', error: rpcError, journalEntryId: 'je-1' })
  })

  it('a refusal after the voucher keeps the voucher id for the next run', async () => {
    mock.setTable(RPC, [DRY_RUN_OK, { data: { ok: false, code: 'VOUCHER_INVALID' } }])

    const outcome = await applyMigratedDeduction(supabase, 'company-1', 'user-1', applyPlan(), OPTIONS)

    expect(outcome).toEqual({ ok: false, kind: 'refused', code: 'VOUCHER_INVALID', journalEntryId: 'je-1' })
  })
})

describe('repairMigratedInvoiceStatus', () => {
  it('calls the RPC with no deduction, no voucher and no dry run', async () => {
    mock.setTable(RPC, { data: { ok: true, applied: true, status: 'partially_paid', remaining_amount: 9000 } })
    const plan = statusPlan()

    const outcome = await repairMigratedInvoiceStatus(supabase, 'company-1', plan, TRAIL)

    expect(outcome).toEqual({ ok: true, applied: true, status: 'partially_paid', remainingAmount: 9000, journalEntryId: null })
    expect(rpcArgs()).toEqual([
      {
        p_company_id: 'company-1',
        p_invoice_id: 'inv-1',
        p_expected: plan.expected,
        p_deduction: null,
        p_journal_entry_id: null,
        p_dry_run: false,
        p_trail: { provider: 'visma', consent_id: 'consent-1', correlation_id: 'corr-1' },
      },
    ])
    expect(createJournalEntry).not.toHaveBeenCalled()
    expect(encryptPersonnummer).not.toHaveBeenCalled()
  })

  it('returns the refusal code', async () => {
    mock.setTable(RPC, { data: { ok: false, code: 'STATUS_NOT_REPAIRABLE' } })

    const outcome = await repairMigratedInvoiceStatus(supabase, 'company-1', statusPlan(), TRAIL)

    expect(outcome).toEqual({ ok: false, kind: 'refused', code: 'STATUS_NOT_REPAIRABLE', journalEntryId: null })
  })

  it('reports an RPC error at stage apply', async () => {
    const rpcError = { message: 'boom' }
    mock.setTable(RPC, { error: rpcError })

    const outcome = await repairMigratedInvoiceStatus(supabase, 'company-1', statusPlan(), TRAIL)

    expect(outcome).toEqual({ ok: false, kind: 'error', stage: 'apply', error: rpcError, journalEntryId: null })
  })
})

describe('ensureDeductionAccounts', () => {
  it.each([true, false])('activates 1510 and 1513 and answers ok=%s', async (ok) => {
    activateAccounts.mockResolvedValue({ ok })
    const ctx = { supabase, companyId: 'company-1', userId: 'user-1', log: { error: vi.fn() } as never }

    await expect(ensureDeductionAccounts(ctx)).resolves.toBe(ok)
    expect(activateAccounts).toHaveBeenCalledExactlyOnceWith(ctx, ['1510', '1513'])
  })
})
