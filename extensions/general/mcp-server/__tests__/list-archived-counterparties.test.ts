/**
 * gnubok_list_customers / gnubok_list_suppliers: rows archived through the v1
 * API (archived_at set) are hidden by default and only returned when the
 * caller passes include_archived=true, mirroring the v1 list routes.
 */
import { describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

const listCustomers = () => tools.find((t) => t.name === 'gnubok_list_customers')!
const listSuppliers = () => tools.find((t) => t.name === 'gnubok_list_suppliers')!

describe('archived counterparties are hidden from the MCP list tools by default', () => {
  it('gnubok_list_customers filters on archived_at IS NULL unless include_archived=true', async () => {
    const { supabase, enqueue, findCalls, reset } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'c-1', name: 'Acme AB', customer_type: 'swedish_business', org_number: null, personal_number: null }] })

    const result = (await listCustomers().execute({}, 'company-1', 'user-1', supabase as never)) as { count: number }
    expect(result.count).toBe(1)
    expect(findCalls('customers', 'is')).toEqual([['archived_at', null]])

    reset()
    enqueue({ data: [] })
    await listCustomers().execute({ include_archived: true }, 'company-1', 'user-1', supabase as never)
    expect(findCalls('customers', 'is')).toEqual([])
  })

  it('gnubok_list_suppliers filters on archived_at IS NULL unless include_archived=true', async () => {
    const { supabase, enqueue, findCalls, reset } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 's-1', name: 'Leverantör AB' }] })

    const result = (await listSuppliers().execute({}, 'company-1', 'user-1', supabase as never)) as { count: number }
    expect(result.count).toBe(1)
    expect(findCalls('suppliers', 'is')).toEqual([['archived_at', null]])

    reset()
    enqueue({ data: [] })
    await listSuppliers().execute({ include_archived: true }, 'company-1', 'user-1', supabase as never)
    expect(findCalls('suppliers', 'is')).toEqual([])
  })

  it('declares include_archived as an optional boolean on both tools', () => {
    for (const tool of [listCustomers(), listSuppliers()]) {
      const schema = tool.inputSchema as { additionalProperties: boolean; properties: Record<string, { type: string }>; required?: string[] }
      expect(schema.additionalProperties).toBe(false)
      expect(schema.properties.include_archived).toEqual(expect.objectContaining({ type: 'boolean' }))
      expect(schema.required ?? []).not.toContain('include_archived')
      expect(tool.description.length).toBeLessThanOrEqual(280)
    }
  })
})
