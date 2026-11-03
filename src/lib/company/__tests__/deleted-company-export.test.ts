import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  DELETED_COMPANY_EXPORT_MONTHS,
  authorizeDeletedCompanyExport,
  exportWindowEndsOn,
  isExportWindowOpen,
  listDeletedCompanyExports,
} from '../deleted-company-export'

const { supabase, enqueue, reset, findCall } = createQueuedMockSupabase()
const service = supabase as unknown as SupabaseClient

const USER = 'user-1'
// Deleted 2026-11-02 at 11:00 Stockholm time: the window ends 2028-05-02.
const ARCHIVED = '2026-11-02T10:00:00Z'

beforeEach(() => {
  reset()
})

describe('exportWindowEndsOn', () => {
  it('is 18 calendar months after the Swedish day of the deletion', () => {
    expect(DELETED_COMPANY_EXPORT_MONTHS).toBe(18)
    expect(exportWindowEndsOn(ARCHIVED)).toBe('2028-05-02')
  })

  it('counts from the Swedish calendar day, not the UTC one', () => {
    // 23:30 UTC on Nov 1 is 00:30 on Nov 2 in Stockholm.
    expect(exportWindowEndsOn('2026-11-01T23:30:00Z')).toBe('2028-05-02')
  })

  it('clamps to the last day of the target month', () => {
    expect(exportWindowEndsOn('2026-08-31T10:00:00Z')).toBe('2028-02-29')
  })
})

describe('isExportWindowOpen', () => {
  it('is open up to and including the last day, closed the day after', () => {
    expect(isExportWindowOpen(ARCHIVED, new Date('2028-05-02T20:00:00Z'))).toBe(true)
    expect(isExportWindowOpen(ARCHIVED, new Date('2028-05-03T08:00:00Z'))).toBe(false)
  })
})

describe('listDeletedCompanyExports', () => {
  const NOW = new Date('2027-01-15T12:00:00Z')

  it('lists open windows only, newest deletion first, with the name the UI showed', async () => {
    enqueue({
      data: [
        { role: 'owner', companies: { id: 'c-old', name: 'Old AB', archived_at: '2026-03-01T10:00:00Z' } },
        { role: 'admin', companies: { id: 'c-new', name: 'New AB', archived_at: '2026-12-01T10:00:00Z' } },
        // Deleted more than 18 months before NOW: left out.
        { role: 'owner', companies: { id: 'c-closed', name: 'Closed AB', archived_at: '2025-06-01T10:00:00Z' } },
      ],
    })
    enqueue({ data: [] }) // no migration reset sources
    enqueue({ data: [{ company_id: 'c-new', company_name: 'New Display AB' }] })

    const result = await listDeletedCompanyExports(service, USER, NOW)

    expect(result).toEqual([
      { id: 'c-new', name: 'New Display AB', archivedAt: '2026-12-01T10:00:00Z', exportUntil: '2028-06-01' },
      { id: 'c-old', name: 'Old AB', archivedAt: '2026-03-01T10:00:00Z', exportUntil: '2027-09-01' },
    ])
    expect(findCall('company_members', 'eq')).toEqual(['user_id', USER])
    expect(findCall('company_members', 'in')).toEqual(['role', ['owner', 'admin']])
    expect(findCall('company_members', 'not')).toEqual(['companies.archived_at', 'is', null])
    expect(findCall('company_migration_resets', 'in')).toEqual(['source_company_id', ['c-old', 'c-new']])
    expect(findCall('company_settings', 'in')).toEqual(['company_id', ['c-old', 'c-new']])
  })

  it('leaves out the retained source of a migration reset', async () => {
    enqueue({
      data: [
        { role: 'owner', companies: { id: 'c-deleted', name: 'Deleted AB', archived_at: '2026-12-01T10:00:00Z' } },
        { role: 'owner', companies: { id: 'c-reset', name: 'Reset AB', archived_at: '2026-12-02T10:00:00Z' } },
      ],
    })
    enqueue({ data: [{ source_company_id: 'c-reset' }] })
    enqueue({ data: [] })

    const result = await listDeletedCompanyExports(service, USER, NOW)

    expect(result.map((c) => c.id)).toEqual(['c-deleted'])
  })

  it('answers an empty list without reading names when nothing is deleted', async () => {
    enqueue({ data: [] })
    expect(await listDeletedCompanyExports(service, USER, NOW)).toEqual([])
    expect(findCall('company_settings', 'select')).toBeUndefined()
  })

  it('throws on a failed read', async () => {
    enqueue({ error: { message: 'boom' } })
    await expect(listDeletedCompanyExports(service, USER, NOW)).rejects.toThrow('boom')
  })
})

describe('authorizeDeletedCompanyExport', () => {
  const NOW = new Date('2027-01-15T12:00:00Z')

  it('allows an owner of a deleted company inside the window', async () => {
    enqueue({ data: { role: 'owner', companies: { id: 'c-1', name: 'Acme AB', archived_at: ARCHIVED } } })
    enqueue({ data: [] }) // not a migration reset source
    enqueue({ data: [] })

    const result = await authorizeDeletedCompanyExport(service, USER, 'c-1', NOW)

    expect(result).toEqual({
      ok: true,
      company: { id: 'c-1', name: 'Acme AB', archivedAt: ARCHIVED, exportUntil: '2028-05-02' },
    })
    expect(findCall('company_members', 'eq')).toEqual(['user_id', USER])
  })

  it('answers not_found for a person with no membership', async () => {
    enqueue({ data: null })
    expect(await authorizeDeletedCompanyExport(service, USER, 'c-1', NOW)).toEqual({ ok: false, reason: 'not_found' })
  })

  it('answers not_found for a plain member (only owners and admins export)', async () => {
    enqueue({ data: { role: 'member', companies: { id: 'c-1', name: 'Acme AB', archived_at: ARCHIVED } } })
    expect(await authorizeDeletedCompanyExport(service, USER, 'c-1', NOW)).toEqual({ ok: false, reason: 'not_found' })
  })

  it('answers not_found for a company that is not deleted', async () => {
    enqueue({ data: { role: 'owner', companies: { id: 'c-1', name: 'Acme AB', archived_at: null } } })
    expect(await authorizeDeletedCompanyExport(service, USER, 'c-1', NOW)).toEqual({ ok: false, reason: 'not_found' })
  })

  it('answers not_found for the retained source of a migration reset', async () => {
    enqueue({ data: { role: 'owner', companies: { id: 'c-1', name: 'Acme AB', archived_at: ARCHIVED } } })
    enqueue({ data: [{ source_company_id: 'c-1' }] })
    expect(await authorizeDeletedCompanyExport(service, USER, 'c-1', NOW)).toEqual({ ok: false, reason: 'not_found' })
  })

  it('answers window_closed after the 18 months', async () => {
    enqueue({ data: { role: 'owner', companies: { id: 'c-1', name: 'Acme AB', archived_at: ARCHIVED } } })
    enqueue({ data: [] })
    const later = new Date('2028-05-03T08:00:00Z')
    expect(await authorizeDeletedCompanyExport(service, USER, 'c-1', later)).toEqual({
      ok: false,
      reason: 'window_closed',
      exportUntil: '2028-05-02',
    })
  })

  it('throws on a failed read', async () => {
    enqueue({ error: { message: 'boom' } })
    await expect(authorizeDeletedCompanyExport(service, USER, 'c-1', NOW)).rejects.toThrow('boom')
  })
})
