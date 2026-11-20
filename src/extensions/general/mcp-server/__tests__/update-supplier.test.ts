/**
 * gnubok_update_supplier (operation suppliers.update), crm#1060: an agent
 * migrating a supplier register could create suppliers over MCP but never
 * change one, so an imported supplier with only a name and a bankgiro could
 * not get its address or bank details without a duplicate. The tool is
 * generated from the same operation as the v1 PATCH and approval runs it
 * through commitRegisteredOperation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { operationForPendingType } from '@/lib/operations/registry'
import { suppliersUpdate } from '@/lib/operations/suppliers'
import { TOOL_SCOPE_MAP } from '@/lib/auth/scope-catalog'
import { tools } from '../server'

const SUPPLIER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const STORED = {
  id: SUPPLIER_ID,
  name: 'Elnät AB',
  supplier_type: 'swedish_business',
  city: null,
  postal_code: null,
  address_line1: null,
  vat_number: null,
  iban: null,
  bic: null,
  archived_at: null,
}

const updateSupplier = tools.find((t) => t.name === 'gnubok_update_supplier')!

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_update_supplier', () => {
  it('is a search-only staging tool gated by suppliers:write', () => {
    expect(updateSupplier).toBeDefined()
    expect(updateSupplier.catalogVisibility).toBe('search')
    expect(TOOL_SCOPE_MAP.gnubok_update_supplier).toBe('suppliers:write')
    expect(updateSupplier.description).toMatch(/^Stage /)
  })

  it('takes every field the supplier form edits, and nothing it does not know', () => {
    const schema = updateSupplier.inputSchema as { properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean }
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required).toEqual(['supplier_id'])
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining([
        'supplier_id', 'name', 'address_line1', 'postal_code', 'city', 'country', 'org_number', 'vat_number',
        'bankgiro', 'plusgiro', 'clearing_number', 'account_number', 'iban', 'bic', 'phone', 'email',
        'default_expense_account', 'default_payment_terms', 'notes', 'archived_at', 'dry_run', 'idempotency_key',
      ]),
    )
  })

  it('dry run previews the change and flags new payment details for the approver', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: STORED })

    const result = (await updateSupplier.execute(
      { supplier_id: SUPPLIER_ID, city: 'Solna', iban: 'SE4550000000058398257466', bic: 'ESSESESS', dry_run: true },
      'company-1', 'user-1', supabase as never, { type: 'api_key', id: 'key-1' },
    )) as { staged: boolean; dry_run: boolean; risk_level: string; preview: Record<string, unknown> }

    expect(result.staged).toBe(false)
    expect(result.dry_run).toBe(true)
    expect(result.risk_level).toBe('medium')
    expect(result.preview.changes).toEqual({
      city: { from: null, to: 'Solna' },
      iban: { from: null, to: 'SE4550000000058398257466' },
      bic: { from: null, to: 'ESSESESS' },
    })
    expect(result.preview.payment_details_changed).toBe(true)
  })

  it('refuses an unknown supplier at staging, not at approval', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })

    await expect(
      updateSupplier.execute(
        { supplier_id: SUPPLIER_ID, city: 'Solna' },
        'company-1', 'user-1', supabase as never, { type: 'api_key', id: 'key-1' },
      ),
    ).rejects.toMatchObject({ code: 'SUPPLIER_NOT_FOUND' })
  })

  it('stages update_supplier with params that commit validates back to the same input', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: STORED }) // dry-run read
    enqueue({ data: { id: 'op-1' } }) // pending_operations insert

    await updateSupplier.execute(
      { supplier_id: SUPPLIER_ID, org_number: '556677-8899', email: '', postal_code: '171 48' },
      'company-1', 'user-1', supabase as never, { type: 'api_key', id: 'key-1' },
    )

    const insert = findCall('pending_operations', 'insert')?.[0] as {
      operation_type: string
      title: string
      params: Record<string, unknown>
    }
    expect(insert.operation_type).toBe('update_supplier')
    expect(insert.title).toBe('Uppdatera leverantör: Elnät AB')
    expect(insert.params).toEqual({
      supplier_id: SUPPLIER_ID,
      org_number: '5566778899',
      email: null,
      postal_code: '171 48',
    })
    // commitRegisteredOperation re-parses the staged params with the input.
    expect(operationForPendingType('update_supplier')).toBe(suppliersUpdate)
    expect(suppliersUpdate.input.parse(insert.params)).toEqual(insert.params)
  })
})
