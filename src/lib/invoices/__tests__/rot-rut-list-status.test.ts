import { describe, expect, it } from 'vitest'
import {
  ROT_RUT_LIST_FILTERS,
  matchesRotRutListFilter,
  parseRotRutListFilter,
  rotRutListStateOf,
  type RotRutListInvoice,
  type RotRutListRequest,
} from '../rot-rut-list-status'

function request(overrides: Partial<RotRutListRequest> & { status: string }): RotRutListRequest {
  return { id: `req-${overrides.status}`, created_at: '2026-01-01T00:00:00Z', ...overrides }
}

function invoice(
  overrides: Partial<RotRutListInvoice> & { requests?: RotRutListRequest[] } = {},
): RotRutListInvoice {
  const { requests, ...rest } = overrides
  return {
    status: 'paid',
    deduction_total: 3000,
    rot_rut_items: requests?.map((r) => ({ request: r })),
    ...rest,
  }
}

describe('rotRutListStateOf', () => {
  it('reads the active request as the invoice state', () => {
    expect(rotRutListStateOf(invoice({ requests: [request({ status: 'submitted' })] }))).toBe(
      'submitted',
    )
    expect(rotRutListStateOf(invoice({ requests: [request({ status: 'paid' })] }))).toBe('paid')
    expect(
      rotRutListStateOf(invoice({ requests: [request({ status: 'partially_paid' })] })),
    ).toBe('partially_paid')
  })

  it('lets the active request win over historical avslag and cancelled files', () => {
    const rows = [
      request({ status: 'rejected', created_at: '2026-03-01T00:00:00Z' }),
      request({ status: 'generated', created_at: '2026-02-01T00:00:00Z' }),
      request({ status: 'cancelled', created_at: '2026-04-01T00:00:00Z' }),
    ]
    expect(rotRutListStateOf(invoice({ requests: rows }))).toBe('generated')
  })

  it('falls back to the newest historical row when nothing is active', () => {
    const rows = [
      request({ status: 'cancelled', created_at: '2026-02-01T00:00:00Z' }),
      request({ status: 'rejected', created_at: '2026-03-01T00:00:00Z' }),
    ]
    expect(rotRutListStateOf(invoice({ requests: rows }))).toBe('rejected')
  })

  it('reads PostgREST array-shaped embeds too', () => {
    const row: RotRutListInvoice = {
      status: 'paid',
      deduction_total: 500,
      rot_rut_items: [{ request: [request({ status: 'submitted' })] }],
    }
    expect(rotRutListStateOf(row)).toBe('submitted')
  })

  it('marks a paid invoice with a deduction and no request as claimable', () => {
    expect(rotRutListStateOf(invoice({ requests: [] }))).toBe('claimable')
    expect(rotRutListStateOf(invoice({ rot_rut_items: undefined }))).toBe('claimable')
  })

  it('has nothing to say for unpaid invoices or invoices without a deduction', () => {
    expect(rotRutListStateOf(invoice({ status: 'sent' }))).toBeNull()
    expect(rotRutListStateOf(invoice({ status: 'overdue', deduction_total: 3000 }))).toBeNull()
    expect(rotRutListStateOf(invoice({ deduction_total: 0 }))).toBeNull()
    expect(rotRutListStateOf(invoice({ deduction_total: undefined }))).toBeNull()
  })

  it('ignores request rows with an unknown status', () => {
    expect(rotRutListStateOf(invoice({ requests: [request({ status: 'weird' })] }))).toBe(
      'claimable',
    )
  })
})

describe('matchesRotRutListFilter', () => {
  it('matches everything on all and the exact state otherwise', () => {
    const submitted = invoice({ requests: [request({ status: 'submitted' })] })
    const claimable = invoice({ requests: [] })
    const plain = invoice({ status: 'sent', deduction_total: 0 })
    expect(ROT_RUT_LIST_FILTERS.filter((f) => matchesRotRutListFilter(submitted, f))).toEqual([
      'all',
      'submitted',
    ])
    expect(ROT_RUT_LIST_FILTERS.filter((f) => matchesRotRutListFilter(claimable, f))).toEqual([
      'all',
      'claimable',
    ])
    expect(ROT_RUT_LIST_FILTERS.filter((f) => matchesRotRutListFilter(plain, f))).toEqual(['all'])
  })

  it('does not offer cancelled as a filter but still matches nothing but all for it', () => {
    const cancelled = invoice({ requests: [request({ status: 'cancelled' })] })
    expect(ROT_RUT_LIST_FILTERS).not.toContain('cancelled')
    expect(ROT_RUT_LIST_FILTERS.filter((f) => matchesRotRutListFilter(cancelled, f))).toEqual([
      'all',
    ])
  })
})

describe('parseRotRutListFilter', () => {
  it('accepts filter ids and rejects everything else', () => {
    expect(parseRotRutListFilter('submitted')).toBe('submitted')
    expect(parseRotRutListFilter('claimable')).toBe('claimable')
    expect(parseRotRutListFilter('all')).toBe('all')
    expect(parseRotRutListFilter('cancelled')).toBeNull()
    expect(parseRotRutListFilter('')).toBeNull()
    expect(parseRotRutListFilter(null)).toBeNull()
  })
})
