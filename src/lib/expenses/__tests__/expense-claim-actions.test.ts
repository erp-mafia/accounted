import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { OperationContext } from '@/lib/operations/types'

vi.mock('@/lib/api/v1/check-period-lock', () => ({
  checkPeriodLock: vi.fn(async () => ({ locked: false })),
}))
vi.mock('@/lib/operations/inbox-pair-guard', () => ({
  refuseWhenPairBooked: vi.fn(async () => null),
}))
vi.mock('@/lib/bookkeeping/account-validation', () => ({
  findUnresolvableAccounts: vi.fn(async () => []),
}))
vi.mock('@/lib/bookkeeping/engine', () => ({
  findFiscalPeriod: vi.fn(async () => 'period-1'),
}))

import { createExpenseClaim } from '../expense-claim-actions'

const COMPANY = 'company-1'
const USER = 'user-1'

const { supabase, enqueue, reset } = createQueuedMockSupabase()
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
const ctx = {
  supabase: supabase as unknown as SupabaseClient,
  companyId: COMPANY,
  userId: USER,
  log,
} as unknown as OperationContext

const INPUT = {
  description: 'Toner',
  expense_date: '2026-11-16',
  amount: 329,
  vat_amount: 65.8,
  currency: 'SEK' as const,
  expense_account: '5460',
  claimant_name: 'Joakim',
  inbox_item_id: 'inbox-1',
}

function previewOf(outcome: Awaited<ReturnType<typeof createExpenseClaim>>): Record<string, unknown> {
  if (!outcome.ok || !outcome.dryRun) throw new Error(`expected a dry run preview, got ${JSON.stringify(outcome)}`)
  return outcome.preview as Record<string, unknown>
}

describe('createExpenseClaim dry run (the staged preview)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  // crm#2018: the approver saw document_id null for a claim staged with
  // inbox_item_id only, and the verifikat was posted without underlag.
  it('previews the inbox item\'s own document as the receipt when only inbox_item_id is sent', async () => {
    enqueue({ data: { created_journal_entry_id: null, created_supplier_invoice_id: null, document_id: 'doc-item' } }) // inbox item read
    enqueue({ data: { entity_type: 'aktiebolag' } }) // companies entity_type

    const preview = previewOf(await createExpenseClaim(ctx, INPUT, { dryRun: true }))

    expect(preview).toMatchObject({ document_id: 'doc-item', inbox_item_id: 'inbox-1' })
  })

  it('previews document_id for a claim without an inbox item', async () => {
    const { inbox_item_id: _omitted, ...withoutItem } = INPUT
    enqueue({ data: { id: 'doc-upload' } }) // document belongs to the company
    enqueue({ data: { entity_type: 'aktiebolag' } }) // companies entity_type

    const preview = previewOf(await createExpenseClaim(ctx, { ...withoutItem, document_id: 'doc-upload' }, { dryRun: true }))

    expect(preview).toMatchObject({ document_id: 'doc-upload', inbox_item_id: null })
  })

  it('still refuses an inbox item that is booked already', async () => {
    enqueue({ data: { created_journal_entry_id: null, created_supplier_invoice_id: 'si-1', document_id: 'doc-item' } }) // inbox item read

    const outcome = await createExpenseClaim(ctx, INPUT, { dryRun: true })

    expect(outcome).toMatchObject({ ok: false, code: 'INBOX_ITEM_ALREADY_BOOKED', details: { inbox_item_id: 'inbox-1', supplier_invoice_id: 'si-1' } })
  })
})
