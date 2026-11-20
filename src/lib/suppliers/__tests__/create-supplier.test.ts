/**
 * The supplier register's one rule set (CreateSupplierSchema) and its one
 * insert (createSupplier), shared by the dashboard, v1 and the approval of an
 * agent's staged gnubok_create_supplier.
 *
 * Moved here from the agent path's own CreateSupplierParamsSchema, deleted
 * with this change: its org-number key, its optional VAT number and its
 * payment-routing checks are the register's rules now, for every door.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { createLogger } from '@/lib/logger'
import { eventBus } from '@/lib/events'
import { CreateSupplierSchema } from '@/lib/api/schemas'
import { generateReverseChargePurchaseLines, reverseChargeKindForSupplierType } from '@/lib/bookkeeping/vat-entries'
import { createSupplier } from '../create-supplier'

const parse = (input: Record<string, unknown>) => CreateSupplierSchema.parse({ name: 'Testbrand AB', ...input })

describe('CreateSupplierSchema: the register rules every door applies', () => {
  // #2391: every door stores the same 10-digit key.
  it('stores the 10-digit key for every accepted spelling of a Swedish org number', () => {
    for (const typed of ['556677-8899', '5566778899', '165566778899', ' 556677-8899 ']) {
      expect(parse({ org_number: typed }).org_number, typed).toBe('5566778899')
    }
  })

  it("keeps a foreign supplier's home-registry number as sent", () => {
    expect(parse({ supplier_type: 'eu_business', org_number: 'DK12345678' }).org_number).toBe('DK12345678')
  })

  it('accepts an EU supplier with no VAT number (below its national threshold)', () => {
    const parsed = parse({ name: 'Kleinanbieter GmbH', supplier_type: 'eu_business', country: 'DE' })
    expect(parsed.vat_number).toBeUndefined()
  })

  it('refuses a bankgiro whose Luhn check digit is wrong, and accepts a valid one', () => {
    expect(() => parse({ bankgiro: '123-4568' })).toThrow(/Bankgiro/)
    expect(parse({ bankgiro: '5050-1055' }).bankgiro).toBe('5050-1055')
  })

  it.each([
    ['plusgiro', 'abc', /Plusgiro/],
    ['iban', 'SE12', /IBAN/],
    ['bic', 'NOTABIC!', /BIC/],
  ] as const)('refuses a %s that cannot route a payment', (field, value, message) => {
    expect(() => parse({ [field]: value })).toThrow(message)
  })

  it('lets an empty payment field through, as "not set" on create and "clear it" on update', () => {
    expect(parse({ bankgiro: '', iban: '  ' }).bankgiro).toBe('')
  })

  it('needs no supplier type: the service defaults it', () => {
    expect(parse({}).supplier_type).toBeUndefined()
  })
})

describe('reverse charge does not consume supplier.vat_number', () => {
  // Omvänd betalningsskyldighet on an EU purchase follows supplier_type and
  // the invoice's reverse_charge flag, never the supplier's VAT number.
  it('books EU service purchase basis lines from supplier_type alone', () => {
    const parsed = parse({ name: 'Kleinanbieter GmbH', supplier_type: 'eu_business' })
    const lines = generateReverseChargePurchaseLines({ base: 1000, kind: reverseChargeKindForSupplierType(parsed.supplier_type!) })
    expect(lines.map((l) => l.account_number)).toEqual(['2645', '2614', '4535', '4598'])
  })
})

describe('createSupplier', () => {
  const { supabase, enqueue, reset, findCall } = createQueuedMockSupabase()
  const ctx = { supabase: supabase as never, companyId: 'company-1', userId: 'user-1', log: createLogger('test') }

  beforeEach(() => {
    reset()
    eventBus.clear()
  })

  it('inserts the register defaults, the clearing and account number included', async () => {
    enqueue({ data: { id: 'sup-1', name: 'Testbrand AB' } })
    const created = vi.fn()
    eventBus.on('supplier.created', created)

    const outcome = await createSupplier(ctx, parse({ clearing_number: '8327', account_number: '9123456', bankgiro: '', email: '' }))

    expect(outcome).toMatchObject({ ok: true, created: true, data: { id: 'sup-1' } })
    expect(findCall('suppliers', 'insert')?.[0]).toMatchObject({
      user_id: 'user-1',
      company_id: 'company-1',
      supplier_type: 'swedish_business',
      country: 'SE',
      default_payment_terms: 30,
      default_currency: 'SEK',
      clearing_number: '8327',
      account_number: '9123456',
      // An empty field is "not set": null, never ''.
      bankgiro: null,
      email: null,
    })
    expect(created).toHaveBeenCalledWith(
      expect.objectContaining({ supplier: expect.objectContaining({ id: 'sup-1', company_id: 'company-1' }) }),
    )
  })

  it('answers a duplicate org number with its code and does not echo the number', async () => {
    enqueue({ data: null, error: { code: '23505', message: 'duplicate key' } })

    const outcome = await createSupplier(ctx, parse({ org_number: '556677-8899' }))

    expect(outcome).toEqual({ ok: false, code: 'SUPPLIER_DUPLICATE_ORG_NUMBER', details: { field: 'org_number' } })
  })

  it('stores a default dimension bag only when it has codes (accounted#144)', async () => {
    enqueue({ data: { dimensions_enabled: false } })
    enqueue({ data: { id: 'sup-1' } })
    await createSupplier(ctx, parse({ default_dimensions: { '1': ' FAST01 ' } }))
    expect(findCall('suppliers', 'insert')?.[0]).toMatchObject({ default_dimensions: { '1': 'FAST01' } })

    // No codes: the row names no default_dimensions, so it inserts the same
    // row before and after the migration that adds the column.
    reset()
    enqueue({ data: { id: 'sup-2' } })
    await createSupplier(ctx, parse({ default_dimensions: {} }))
    expect(findCall('suppliers', 'insert')?.[0]).not.toHaveProperty('default_dimensions')
  })

  it('refuses a default the registry does not have, on the dry run too, before anything is written', async () => {
    enqueue({ data: { dimensions_enabled: true } })
    enqueue({ data: [] })
    const outcome = await createSupplier(ctx, parse({ default_dimensions: { '9': 'X1' } }), { dryRun: true })
    expect(outcome).toMatchObject({
      ok: false,
      code: 'DIMENSION_VALIDATION_FAILED',
      details: { issues: [{ sie_dim_no: '9', reason: 'unknown_dimension' }] },
    })
    expect(findCall('suppliers', 'insert')).toBeUndefined()
  })

  it('creates a supplier without a default while the column is not there yet', async () => {
    enqueue({ data: null, error: { code: '42703', message: 'column suppliers.default_dimensions does not exist' } })
    enqueue({ data: { id: 'sup-1', name: 'Testbrand AB' } })
    const outcome = await createSupplier(ctx, parse({}))
    expect(outcome).toMatchObject({ ok: true, data: { id: 'sup-1', default_dimensions: {} } })
  })

  it('previews the row on a dry run and writes nothing', async () => {
    const outcome = await createSupplier(ctx, parse({ default_payment_terms: 0 }), { dryRun: true })

    expect(outcome).toMatchObject({ ok: true, dryRun: true, preview: { name: 'Testbrand AB', default_payment_terms: 0 } })
    expect(findCall('suppliers', 'insert')).toBeUndefined()
  })
})
