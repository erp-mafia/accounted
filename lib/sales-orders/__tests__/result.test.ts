/**
 * codeFromPgError: the DB-side guards (triggers, CHECK, RESTRICT FKs) raise
 * with stable identifiers in the message; the service layer maps them onto
 * the same structured codes the pre-checks use.
 */
import { describe, it, expect } from 'vitest'
import { codeFromPgError, fail, failDb } from '../result'

describe('codeFromPgError', () => {
  it('maps the trigger-raised SALES_ORDER_* prefixes', () => {
    expect(codeFromPgError({ message: 'SALES_ORDER_OVER_INVOICED: line d1 would exceed ordered quantity' })).toBe(
      'SALES_ORDER_OVER_INVOICED',
    )
    expect(codeFromPgError({ message: 'SALES_ORDER_QUANTITY_BELOW_INVOICED: line d1 has 4 invoiced' })).toBe(
      'SALES_ORDER_QUANTITY_BELOW_INVOICED',
    )
    expect(codeFromPgError({ message: 'SALES_ORDER_ITEM_NOT_FOUND: d1' })).toBe('SALES_ORDER_LINE_NOT_FOUND')
  })

  it('maps the delivered-within-ordered CHECK constraint', () => {
    expect(
      codeFromPgError({
        message: 'new row for relation "sales_order_items" violates check constraint "sales_order_items_delivered_within_ordered"',
      }),
    ).toBe('SALES_ORDER_OVER_DELIVERED')
  })

  it('maps the RESTRICT FK from invoice_items onto SALES_ORDER_LINE_LOCKED', () => {
    expect(
      codeFromPgError({
        code: '23503',
        message:
          'update or delete on table "sales_order_items" violates foreign key constraint "invoice_items_sales_order_item_id_fkey" on table "invoice_items"',
      }),
    ).toBe('SALES_ORDER_LINE_LOCKED')
  })

  it('maps the RESTRICT FK from invoices onto SALES_ORDER_HAS_INVOICES', () => {
    expect(
      codeFromPgError({
        code: '23503',
        message:
          'update or delete on table "sales_orders" violates foreign key constraint "invoices_sales_order_id_fkey" on table "invoices"',
      }),
    ).toBe('SALES_ORDER_HAS_INVOICES')
  })

  it('returns null for anything else (the raw error is surfaced instead)', () => {
    expect(codeFromPgError({ message: 'null value in column "description"', code: '23502' })).toBeNull()
    expect(codeFromPgError(new Error('connection reset'))).toBeNull()
    expect(codeFromPgError(null)).toBeNull()
    expect(codeFromPgError(undefined)).toBeNull()
    expect(codeFromPgError('SALES_ORDER_OVER_INVOICED')).toBeNull()
  })
})

describe('fail / failDb', () => {
  it('omits details when none are given', () => {
    expect(fail('SALES_ORDER_NOT_FOUND')).toEqual({ ok: false, code: 'SALES_ORDER_NOT_FOUND' })
    expect(fail('SALES_ORDER_LINE_NOT_FOUND', { sales_order_item_id: 'x' })).toEqual({
      ok: false,
      code: 'SALES_ORDER_LINE_NOT_FOUND',
      details: { sales_order_item_id: 'x' },
    })
  })

  it('carries the raw DB error', () => {
    const error = { message: 'boom', code: '42P01' }
    expect(failDb(error)).toEqual({ ok: false, dbError: error })
  })
})
