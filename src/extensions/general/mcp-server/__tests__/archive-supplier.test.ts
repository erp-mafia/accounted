/**
 * gnubok_archive_supplier (operation suppliers.archive), crm#1796: an agent
 * that found a duplicate supplier after an import had no door to set it
 * aside; archive existed on v1 only. The tool is generated from the
 * operation, stages archive_supplier, and approval runs the same service as
 * the v1 DELETE through commitRegisteredOperation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { operationForPendingType } from '@/lib/operations/registry'
import { suppliersArchive } from '@/lib/operations/suppliers'
import { OPERATION_RISK_TIERS } from '@/lib/pending-operations/risk-tiers'
import { TOOL_SCOPE_MAP } from '@/lib/auth/scope-catalog'
import { tools } from '../server'

const SUPPLIER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const STORED = { id: SUPPLIER_ID, name: 'Elnät AB', supplier_type: 'swedish_business', archived_at: null }
const ACTOR = { type: 'api_key', id: 'key-1' } as const

const archiveSupplier = tools.find((t) => t.name === 'gnubok_archive_supplier')!

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_archive_supplier', () => {
  it('is a search-only staging tool gated by suppliers:write, outside tools/list', () => {
    expect(archiveSupplier).toBeDefined()
    expect(archiveSupplier.catalogVisibility).toBe('search')
    expect(TOOL_SCOPE_MAP.gnubok_archive_supplier).toBe('suppliers:write')
    expect(archiveSupplier.description).toMatch(/^Stage /)
    expect(OPERATION_RISK_TIERS.archive_supplier).toBe('medium')
  })

  it('takes the supplier id and the staging arguments, nothing else', () => {
    const schema = archiveSupplier.inputSchema as { properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean }
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required).toEqual(['supplier_id'])
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(['supplier_id', 'dry_run', 'idempotency_key']))
    expect(Object.keys(schema.properties)).not.toContain('archived_at')
  })

  it('dry run previews the supplier as archived and stages nothing', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: null, count: 0 }) // open supplier invoices
    enqueue({ data: STORED }) // supplier read

    const result = (await archiveSupplier.execute(
      { supplier_id: SUPPLIER_ID, dry_run: true },
      'company-1', 'user-1', supabase as never, ACTOR,
    )) as { staged: boolean; dry_run: boolean; risk_level: string; preview: Record<string, unknown> }

    expect(result.staged).toBe(false)
    expect(result.dry_run).toBe(true)
    expect(result.risk_level).toBe('medium')
    expect(result.preview.name).toBe('Elnät AB')
    expect(typeof result.preview.archived_at).toBe('string')
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
    expect(findCall('suppliers', 'update')).toBeUndefined()
  })

  it('refuses a supplier with open invoices at staging, not at approval', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: null, count: 1 })

    await expect(
      archiveSupplier.execute({ supplier_id: SUPPLIER_ID }, 'company-1', 'user-1', supabase as never, ACTOR),
    ).rejects.toMatchObject({ code: 'SUPPLIER_HAS_INVOICES' })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('refuses an unknown supplier at staging', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, count: 0 })
    enqueue({ data: null })

    await expect(
      archiveSupplier.execute({ supplier_id: SUPPLIER_ID }, 'company-1', 'user-1', supabase as never, ACTOR),
    ).rejects.toMatchObject({ code: 'SUPPLIER_NOT_FOUND' })
  })

  it('stages archive_supplier, archives nothing itself, with params the commit validates back', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: null, count: 0 }) // open supplier invoices
    enqueue({ data: STORED }) // supplier read
    enqueue({ data: { id: 'op-1' } }) // pending_operations insert

    const result = (await archiveSupplier.execute(
      { supplier_id: SUPPLIER_ID },
      'company-1', 'user-1', supabase as never, ACTOR,
    )) as { staged: boolean }

    expect(result.staged).toBe(true)
    expect(findCall('suppliers', 'update')).toBeUndefined()
    const insert = findCall('pending_operations', 'insert')?.[0] as {
      operation_type: string
      title: string
      params: Record<string, unknown>
    }
    expect(insert.operation_type).toBe('archive_supplier')
    expect(insert.title).toBe('Arkivera leverantör: Elnät AB')
    expect(insert.params).toEqual({ supplier_id: SUPPLIER_ID })
    // commitRegisteredOperation re-parses the staged params with the input.
    expect(operationForPendingType('archive_supplier')).toBe(suppliersArchive)
    expect(suppliersArchive.input.parse(insert.params)).toEqual(insert.params)
  })
})
