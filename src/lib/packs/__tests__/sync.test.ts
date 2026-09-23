import { describe, it, expect, vi, beforeEach } from 'vitest'
import { syncSystemPacks } from '@/lib/packs/sync'

/**
 * The sync's dangerous paths are the ones that WRITE. Each test below pins a
 * case where a naive implementation would quietly damage the catalogue:
 * retiring everything on a bad deploy, wiping usage history by deleting, or
 * writing a half-read catalogue into the database.
 */

interface Row {
  id: string
  pack_slug: string | null
  name: string
  description: string
  category: string
  entity_type: string
  lines: unknown
  is_active: boolean
}

function mockSupabase(rows: Row[]) {
  const inserts: unknown[] = []
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = []
  const deletes: string[] = []

  const client = {
    from: () => ({
      select: () => ({
        eq: () => Promise.resolve({ data: rows, error: null }),
      }),
      insert: (payload: unknown) => {
        inserts.push(payload)
        return Promise.resolve({ error: null })
      },
      update: (patch: Record<string, unknown>) => ({
        eq: (_col: string, id: string) => {
          updates.push({ id, patch })
          return Promise.resolve({ error: null })
        },
      }),
      delete: () => ({
        eq: (_col: string, id: string) => {
          deletes.push(id)
          return Promise.resolve({ error: null })
        },
      }),
    }),
  }
  return { client, inserts, updates, deletes }
}

beforeEach(() => vi.clearAllMocks())

describe('syncSystemPacks', () => {
  it('inserts packs that have no row yet', async () => {
    const { client, inserts } = mockSupabase([])
    const r = await syncSystemPacks(client as never, { dryRun: true })

    expect(r.errors).toEqual([])
    expect(r.inserted.length).toBeGreaterThan(0)
    expect(r.updated).toEqual([])
    // dryRun: nothing written.
    expect(inserts).toEqual([])
  })

  it('is idempotent: a database already matching the packs produces no writes', async () => {
    const { client: probe } = mockSupabase([])
    const planned = await syncSystemPacks(probe as never, { dryRun: true })

    // Build rows that exactly match what the packs want.
    const { loadPacks, packToLibraryRow } = await import('@/lib/packs/load')
    const { packs } = loadPacks()
    const rows: Row[] = packs.map((p, i) => ({
      id: `id-${i}`,
      pack_slug: p.pack.meta.slug,
      ...packToLibraryRow(p.pack),
      is_active: true,
    })) as unknown as Row[]

    const { client, inserts, updates } = mockSupabase(rows)
    const r = await syncSystemPacks(client as never)

    expect(r.unchanged).toHaveLength(planned.inserted.length)
    expect(r.inserted).toEqual([])
    expect(r.updated).toEqual([])
    expect(r.retired).toEqual([])
    expect(inserts).toEqual([])
    expect(updates).toEqual([])
  })

  it('updates a row whose content drifted from its pack', async () => {
    const { loadPacks, packToLibraryRow } = await import('@/lib/packs/load')
    const { packs } = loadPacks()
    const rows: Row[] = packs.map((p, i) => ({
      id: `id-${i}`,
      pack_slug: p.pack.meta.slug,
      ...packToLibraryRow(p.pack),
      is_active: true,
    })) as unknown as Row[]
    rows[0].description = 'stale text that no pack says'

    const { client, updates } = mockSupabase(rows)
    const r = await syncSystemPacks(client as never)

    expect(r.updated).toEqual([rows[0].pack_slug])
    expect(updates).toHaveLength(1)
    expect(updates[0].id).toBe('id-0')
  })

  it('RETIRES an orphan rather than deleting it, to protect usage history', async () => {
    const { loadPacks, packToLibraryRow } = await import('@/lib/packs/load')
    const { packs } = loadPacks()
    const rows: Row[] = packs.map((p, i) => ({
      id: `id-${i}`,
      pack_slug: p.pack.meta.slug,
      ...packToLibraryRow(p.pack),
      is_active: true,
    })) as unknown as Row[]
    rows.push({
      id: 'orphan-1',
      pack_slug: 'a-pack-that-no-longer-exists',
      name: 'Gammal mall', description: '', category: 'other', entity_type: 'all',
      lines: [], is_active: true,
    })

    const { client, updates, deletes } = mockSupabase(rows)
    const r = await syncSystemPacks(client as never)

    expect(r.retired).toEqual(['a-pack-that-no-longer-exists'])
    // booking_template_usage.template_id is ON DELETE CASCADE: deleting would
    // wipe every company's usage record for the template.
    expect(deletes).toEqual([])
    expect(updates).toEqual([{ id: 'orphan-1', patch: { is_active: false } }])
  })

  it('does not re-retire an already inactive orphan', async () => {
    const { client, updates } = mockSupabase([
      {
        id: 'orphan-1', pack_slug: 'gone', name: 'x', description: '', category: 'other',
        entity_type: 'all', lines: [], is_active: false,
      },
    ])
    const r = await syncSystemPacks(client as never, { dryRun: true })
    expect(r.retired).toEqual([])
    expect(updates).toEqual([])
  })

  it('refuses to write anything when the catalogue is empty', async () => {
    // A packs/ directory that did not make it into the deploy must never be
    // read as "retire every system template".
    const { client, updates, inserts } = mockSupabase([])
    const r = await syncSystemPacks(client as never, { root: '/nonexistent-root' })

    expect(r.errors[0]).toMatch(/refusing to retire/)
    expect(r.inserted).toEqual([])
    expect(updates).toEqual([])
    expect(inserts).toEqual([])
  })

  it('ignores system rows that carry no slug', async () => {
    const { client } = mockSupabase([
      {
        id: 'legacy', pack_slug: null, name: 'Oadopterad', description: '', category: 'other',
        entity_type: 'all', lines: [], is_active: true,
      },
    ])
    const r = await syncSystemPacks(client as never, { dryRun: true })
    expect(r.retired).toEqual([])
  })
})
