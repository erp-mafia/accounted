/**
 * The supplier's default dimension bag (accounted#144): which bag a new
 * supplier invoice gets, the registry check when a default is set, and the
 * reads that must keep working in the hour Vercel serves this code before CI
 * has added the column.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  invoiceDefaultDimensions,
  refuseUnknownSupplierDimensions,
  supplierDefaultDimensions,
  tolerateMissingDefaultDimensions,
} from '../default-dimensions'

const MISSING_COLUMN = { code: '42703', message: 'column suppliers.default_dimensions does not exist' }

describe('invoiceDefaultDimensions', () => {
  const supplier = { default_dimensions: { '1': 'FAST01' } }

  it("takes the supplier's default when the request sends none", () => {
    expect(invoiceDefaultDimensions(undefined, supplier)).toEqual({ '1': 'FAST01' })
    expect(invoiceDefaultDimensions(null, supplier)).toEqual({ '1': 'FAST01' })
  })

  it('keeps a bag the request sends, without merging the default into it', () => {
    expect(invoiceDefaultDimensions({ '6': 'P001' }, supplier)).toEqual({ '6': 'P001' })
  })

  it('reads {} sent with the invoice as "untagged", not as "use the default"', () => {
    expect(invoiceDefaultDimensions({}, supplier)).toEqual({})
  })

  it('is {} for a supplier without a default and for a row read before the column existed', () => {
    expect(invoiceDefaultDimensions(undefined, { default_dimensions: {} })).toEqual({})
    expect(invoiceDefaultDimensions(undefined, {})).toEqual({})
    expect(supplierDefaultDimensions(null)).toEqual({})
  })

  it('trims a code the way every line bag is normalized, and reads a malformed bag as none', () => {
    expect(supplierDefaultDimensions({ default_dimensions: { '1': ' FAST01 ' } })).toEqual({ '1': 'FAST01' })
    expect(supplierDefaultDimensions({ default_dimensions: { x: 'FAST01' } })).toEqual({})
  })
})

describe('refuseUnknownSupplierDimensions', () => {
  const { supabase, enqueue, reset } = createQueuedMockSupabase()
  beforeEach(() => reset())

  it('passes an empty bag without a query', async () => {
    expect(await refuseUnknownSupplierDimensions(supabase as never, 'company-1', {})).toBeNull()
  })

  it('passes any bag while the company has dimensions off', async () => {
    enqueue({ data: { dimensions_enabled: false } })
    expect(await refuseUnknownSupplierDimensions(supabase as never, 'company-1', { '1': 'FAST01' })).toBeNull()
  })

  it('refuses an archived value with DIMENSION_VALIDATION_FAILED naming it', async () => {
    enqueue({ data: { dimensions_enabled: true } })
    enqueue({ data: [{ id: 'dim-1', sie_dim_no: 1, name: 'Fastighet', is_active: true }] })
    enqueue({ data: [{ dimension_id: 'dim-1', code: 'FAST01', is_active: false }] })
    const refused = await refuseUnknownSupplierDimensions(supabase as never, 'company-1', { '1': 'FAST01' })
    expect(refused).toMatchObject({
      ok: false,
      code: 'DIMENSION_VALIDATION_FAILED',
      details: { field: 'default_dimensions', issues: [{ sie_dim_no: '1', code: 'FAST01', reason: 'archived_value' }] },
    })
  })
})

describe('reads before the migration has run', () => {
  const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
  beforeEach(() => reset())

  it('runs the query again without the column and reads the row as having no default', async () => {
    enqueue({ data: null, error: MISSING_COLUMN })
    enqueue({ data: { id: 's1', name: 'Elnät AB' } })
    const result = await tolerateMissingDefaultDimensions('id, name, default_dimensions, notes', (columns) =>
      supabase.from('suppliers').select(columns).maybeSingle(),
    )
    expect(result).toMatchObject({ data: { id: 's1', name: 'Elnät AB', default_dimensions: {} }, error: null })
    expect(findCalls('suppliers', 'select')).toEqual([['id, name, default_dimensions, notes'], ['id, name, notes']])
  })

  it('runs once when the column is there, and passes any other error through', async () => {
    enqueue({ data: null, error: { code: '42501', message: 'permission denied' } })
    const result = await tolerateMissingDefaultDimensions('id, default_dimensions', (columns) =>
      supabase.from('suppliers').select(columns).maybeSingle(),
    )
    expect(result.error).toMatchObject({ code: '42501' })
    expect(findCalls('suppliers', 'select')).toHaveLength(1)
  })
})
