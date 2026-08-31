/**
 * Tests for POST /api/bookkeeping/fix-cash-mismatch.
 *
 * Exercises the remediation through the real withRouteContext wrapper with
 * auth/company/write mocked. The load-bearing assertion is the transaction
 * relink payload: reverseEntry (step 1 of the remediation) resets the whole
 * booked state on the linked row (journal_entry_id, is_business, category,
 * reconciliation_method: the #1950 return-to-Att-bokfora fix), so the relink
 * must restore the full booked triple, not just the journal_entry_id pointer.
 * Restoring only the pointer leaves a booked row with is_business NULL,
 * visible in Att bokfora while linked to a posted entry: the inverted #1950
 * symptom.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

vi.mock('@/lib/bookkeeping/engine', () => ({
  reverseEntry: vi.fn(),
}))

vi.mock('@/lib/bookkeeping/invoice-entries', () => ({
  createInvoicePaymentJournalEntry: vi.fn(),
}))

import { reverseEntry } from '@/lib/bookkeeping/engine'
import { createInvoicePaymentJournalEntry } from '@/lib/bookkeeping/invoice-entries'
import { POST } from '../route'

const mockReverseEntry = vi.mocked(reverseEntry)
const mockCreateClearing = vi.mocked(createInvoicePaymentJournalEntry)

const mock = createQueuedMockSupabase()

/** Queue the three findAffected reads for one affected payment. */
function enqueueOneAffectedPayment() {
  mock.enqueueMany([
    // journal_entries: posted cash-path payment JEs
    { data: [{ id: 'je-cash', source_id: 'inv-1', status: 'posted' }] },
    // invoices: the invoice still carries its own accrual JE
    {
      data: [
        {
          id: 'inv-1',
          invoice_number: 'F-100',
          journal_entry_id: 'je-invoice',
          customer: { name: 'Acme AB' },
        },
      ],
    },
    // invoice_payments: the affected payment, matched to a bank transaction
    {
      data: [
        {
          id: 'pay-1',
          invoice_id: 'inv-1',
          journal_entry_id: 'je-cash',
          amount: 1250,
          payment_date: '2026-01-15',
          transaction_id: 'tx-1',
        },
      ],
    },
  ])
}

beforeEach(() => {
  vi.clearAllMocks()
  mock.reset()
  requireAuthMock.mockResolvedValue({
    user: { id: 'user-1' },
    supabase: mock.supabase,
  })
  requireWriteMock.mockResolvedValue({ ok: true })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockReverseEntry.mockResolvedValue({ id: 'je-storno' } as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockCreateClearing.mockResolvedValue({ id: 'je-clearing' } as any)
})

describe('POST /api/bookkeeping/fix-cash-mismatch', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mock.supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const req = createMockRequest('/api/bookkeeping/fix-cash-mismatch', {
      method: 'POST',
      body: {},
    })
    const { status } = await parseJsonResponse(await POST(req, { params: Promise.resolve({}) }))

    expect(status).toBe(401)
    expect(mockReverseEntry).not.toHaveBeenCalled()
  })

  it('returns 400 for a non-uuid payment_id', async () => {
    const req = createMockRequest('/api/bookkeeping/fix-cash-mismatch', {
      method: 'POST',
      body: { payment_id: 'not-a-uuid' },
    })
    const { status } = await parseJsonResponse(await POST(req, { params: Promise.resolve({}) }))

    expect(status).toBe(400)
    expect(mockReverseEntry).not.toHaveBeenCalled()
  })

  it('returns fixed: 0 when no payments are affected', async () => {
    mock.enqueue({ data: [] }) // journal_entries: no cash-path JEs

    const req = createMockRequest('/api/bookkeeping/fix-cash-mismatch', {
      method: 'POST',
      body: {},
    })
    const { status, body } = await parseJsonResponse<{ fixed: number; results: unknown[] }>(
      await POST(req, { params: Promise.resolve({}) }),
    )

    expect(status).toBe(200)
    expect(body).toEqual({ fixed: 0, results: [] })
    expect(mockReverseEntry).not.toHaveBeenCalled()
  })

  it('relinks the transaction with the full booked triple, not just the pointer', async () => {
    enqueueOneAffectedPayment()
    mock.enqueueMany([
      // invoices: re-fetch for the clearing entry metadata
      { data: { id: 'inv-1', customer: { name: 'Acme AB' } } },
      // invoice_payments: relink update
      { data: null },
      // transactions: relink update (the payload under test)
      { data: null },
    ])

    const req = createMockRequest('/api/bookkeeping/fix-cash-mismatch', {
      method: 'POST',
      body: {},
    })
    const { status, body } = await parseJsonResponse<{
      fixed: number
      failed: number
      results: Array<{ ok: boolean; storno_journal_entry_id?: string; new_journal_entry_id?: string }>
    }>(await POST(req, { params: Promise.resolve({}) }))

    expect(status).toBe(200)
    expect(body.fixed).toBe(1)
    expect(body.failed).toBe(0)
    expect(body.results[0]).toMatchObject({
      ok: true,
      storno_journal_entry_id: 'je-storno',
      new_journal_entry_id: 'je-clearing',
    })

    expect(mockReverseEntry).toHaveBeenCalledWith(mock.supabase, 'company-1', 'user-1', 'je-cash')

    // The relink must restore everything reverseEntry reset: pointer AND the
    // booked triple. journal_entry_id alone leaves the row in Att bokfora.
    const txUpdate = mock.findCall('transactions', 'update')
    expect(txUpdate).toBeDefined()
    expect(txUpdate![0]).toEqual({
      journal_entry_id: 'je-clearing',
      is_business: true,
      category: 'income_services',
      reconciliation_method: null,
    })

    // And it targets exactly the matched transaction in the active company.
    const txEqCalls = mock
      .findCalls('transactions', 'eq')
      .map((args) => args as [string, string])
    expect(txEqCalls).toContainEqual(['id', 'tx-1'])
    expect(txEqCalls).toContainEqual(['company_id', 'company-1'])
  })

  it('keeps the payment relink to journal_entry_id only', async () => {
    enqueueOneAffectedPayment()
    mock.enqueueMany([
      { data: { id: 'inv-1', customer: { name: 'Acme AB' } } },
      { data: null }, // invoice_payments update
      { data: null }, // transactions update
    ])

    const req = createMockRequest('/api/bookkeeping/fix-cash-mismatch', {
      method: 'POST',
      body: {},
    })
    await parseJsonResponse(await POST(req, { params: Promise.resolve({}) }))

    const payUpdate = mock.findCall('invoice_payments', 'update')
    expect(payUpdate).toBeDefined()
    expect(payUpdate![0]).toEqual({ journal_entry_id: 'je-clearing' })
  })
})
