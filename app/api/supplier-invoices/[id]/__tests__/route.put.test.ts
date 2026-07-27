import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse, createMockRouteParams } from '@/tests/helpers'

/**
 * PUT /api/supplier-invoices/[id] (#1206).
 *
 * Two behaviours are pinned here:
 *   - Editing is allowed for every unsettled status, 'overdue' included. The
 *     overdue cron flips unbooked invoices there just by aging, and the old
 *     registered-only gate then made them permanently read-only: you could not
 *     even extend the due date to un-overdue them.
 *   - The write recomputes the overdue label from the due date it lands on, in
 *     both directions, instead of waiting up to a day for the next cron run.
 *
 * Dates are pinned far in the past/future so the assertions hold whatever the
 * wall-clock date is when the suite runs.
 */

const PAST = '2000-01-01'
const FUTURE = '2999-01-01'

const updatePayloads: Record<string, unknown>[] = []
const singleResults: { data: unknown; error: unknown }[] = []

// Capturing chain: .single() walks a queue (first the existing-row read, then
// the update's returning row) and .update() records the exact payload written.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const chain: any = {
  select: () => chain,
  update: (payload: Record<string, unknown>) => {
    updatePayloads.push(payload)
    return chain
  },
  eq: () => chain,
  // The write paths pin their compare-and-swap predicates with .in()/.is(),
  // so the chain has to accept them too.
  in: () => chain,
  is: () => chain,
  single: () => Promise.resolve(singleResults.shift() ?? { data: null, error: null }),
  maybeSingle: () => Promise.resolve(singleResults.shift() ?? { data: null, error: null }),
}
const mockSupabase = { from: () => chain, rpc: () => chain }

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { PUT } from '../route'

describe('PUT /api/supplier-invoices/[id]', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    updatePayloads.length = 0
    singleResults.length = 0
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
  })

  function putRequest(body: Record<string, unknown>) {
    return PUT(
      createMockRequest('/api/supplier-invoices/si-1', { method: 'PUT', body }),
      createMockRouteParams({ id: 'si-1' }),
    )
  }

  /** Row shape the route reads before validating the body. */
  function existingRow(overrides: Record<string, unknown> = {}) {
    return {
      data: {
        status: 'registered',
        due_date: FUTURE,
        remaining_amount: 1000,
        is_credit_note: false,
        approved_at: null,
        ...overrides,
      },
      error: null,
    }
  }

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await putRequest({ notes: 'x' })
    expect(response.status).toBe(401)
  })

  it('returns 404 when the invoice does not exist', async () => {
    singleResults.push({ data: null, error: null })

    const response = await putRequest({ notes: 'x' })
    expect(response.status).toBe(404)
  })

  it('returns 400 for a settled invoice', async () => {
    singleResults.push(existingRow({ status: 'paid' }))

    const response = await putRequest({ notes: 'x' })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_EDIT_INVALID_STATUS')
    expect(updatePayloads).toHaveLength(0)
  })

  it('rejects an invalid body before writing anything', async () => {
    singleResults.push(existingRow())

    const response = await putRequest({ due_date: 'not-a-date' })

    expect(response.status).toBe(400)
    expect(updatePayloads).toHaveLength(0)
  })

  it('edits an overdue invoice and un-flips it when the due date moves forward', async () => {
    singleResults.push(existingRow({ status: 'overdue', due_date: PAST }))
    singleResults.push({ data: { id: 'si-1', status: 'registered' }, error: null })

    const response = await putRequest({ due_date: FUTURE })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(updatePayloads).toHaveLength(1)
    expect(updatePayloads[0]).toMatchObject({ due_date: FUTURE, status: 'registered' })
  })

  it('un-flips to approved when the invoice had been attested', async () => {
    singleResults.push(
      existingRow({ status: 'overdue', due_date: PAST, approved_at: '2026-01-01T08:00:00Z' }),
    )
    singleResults.push({ data: { id: 'si-1', status: 'approved' }, error: null })

    const response = await putRequest({ due_date: FUTURE })

    expect(response.status).toBe(200)
    expect(updatePayloads[0]).toMatchObject({ status: 'approved' })
  })

  it('marks the invoice overdue right away when the due date moves into the past', async () => {
    singleResults.push(existingRow({ status: 'registered', due_date: FUTURE }))
    singleResults.push({ data: { id: 'si-1', status: 'overdue' }, error: null })

    const response = await putRequest({ due_date: PAST })

    expect(response.status).toBe(200)
    expect(updatePayloads[0]).toMatchObject({ due_date: PAST, status: 'overdue' })
  })

  it('leaves the status out of the payload when it does not change', async () => {
    singleResults.push(existingRow({ status: 'registered', due_date: FUTURE }))
    singleResults.push({ data: { id: 'si-1', status: 'registered' }, error: null })

    const response = await putRequest({ notes: 'Betalas via autogiro' })

    expect(response.status).toBe(200)
    expect(updatePayloads[0]).toEqual({ notes: 'Betalas via autogiro' })
  })

  it('keeps a still-past-due invoice on overdue when only metadata changes', async () => {
    singleResults.push(existingRow({ status: 'overdue', due_date: PAST }))
    singleResults.push({ data: { id: 'si-1', status: 'overdue' }, error: null })

    const response = await putRequest({ payment_reference: '1234567890' })

    expect(response.status).toBe(200)
    expect(updatePayloads[0]).toEqual({ payment_reference: '1234567890' })
  })

  it('reports a conflict when the compare-and-swap matches no row', async () => {
    // The status is derived from facts read a moment ago, so the write pins
    // them. Zero matched rows means the cron (or another writer) changed the row
    // in between: better a retryable 409 than a silently stale label.
    singleResults.push(existingRow({ status: 'overdue', due_date: PAST }))
    singleResults.push({ data: null, error: null })

    const response = await putRequest({ due_date: FUTURE })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('SI_EDIT_CONFLICT')
  })

  it('does not un-flip a credit note into a payable label', async () => {
    // Credit notes are created registered/remaining 0 and are never payables:
    // the cron ignores them in both directions.
    singleResults.push(
      existingRow({ status: 'registered', due_date: PAST, remaining_amount: 0, is_credit_note: true }),
    )
    singleResults.push({ data: { id: 'si-1', status: 'registered' }, error: null })

    const response = await putRequest({ notes: 'Kreditnota' })

    expect(response.status).toBe(200)
    expect(updatePayloads[0]).toEqual({ notes: 'Kreditnota' })
  })
})
