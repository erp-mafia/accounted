import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import type { FetchOutcome } from '../fetch'
import { runVendorLogos } from '../run'
import { nextState, storagePathFor } from '../schedule'
import { vendorLogosFetchEnabled } from '../flag'
import { vendorLogoUrls } from '../read'

const SHA = 'b'.repeat(64)
const NOW = new Date('2026-10-17T12:00:00Z')
const found: FetchOutcome = {
  status: 'found',
  source: 'apple-touch-icon',
  icon: { png: Buffer.from('png'), sha256: SHA, width: 180 },
}

function client(vendorLogos: (calls: { method: string; args: unknown[] }[]) => { data?: unknown; error?: unknown }, tables: Record<string, unknown[]> = {}) {
  const mock = createTableMockSupabase({
    vendor_logos: vendorLogos,
    ...Object.fromEntries(Object.entries(tables).map(([t, rows]) => [t, { data: rows }])),
  })
  const upload = vi.fn().mockResolvedValue({ data: {}, error: null })
  const getPublicUrl = vi.fn((path: string) => ({ data: { publicUrl: `https://db.example/storage/v1/object/public/logos/${path}` } }))
  const storage = { from: vi.fn(() => ({ upload, getPublicUrl })) }
  return { ...mock, upload, getPublicUrl, service: { ...mock.supabase, storage } as unknown as SupabaseClient }
}

const has = (calls: { method: string }[], method: string) => calls.some((c) => c.method === method)

beforeEach(() => vi.clearAllMocks())

describe('nextState', () => {
  const row = { domain: 'loopia.se', status: 'pending' as const, attempts: 0 }
  const days = (iso: string | null) => (iso ? Math.round((Date.parse(iso) - NOW.getTime()) / 86_400_000) : null)

  it('stores a found icon by its hash and refreshes it after a year', () => {
    const u = nextState(row, found, NOW)
    expect(u).toMatchObject({ status: 'found', storage_path: storagePathFor(SHA), sha256: SHA, source: 'apple-touch-icon', width: 180, attempts: 0 })
    expect(days(u.next_attempt_at)).toBe(365)
  })

  it('waits 30 days on missing, 90 on blocked, forever on excluded', () => {
    expect(days(nextState(row, { status: 'missing', reason: 'x' }, NOW).next_attempt_at)).toBe(30)
    expect(days(nextState(row, { status: 'blocked', reason: 'x' }, NOW).next_attempt_at)).toBe(90)
    expect(nextState(row, { status: 'excluded' }, NOW)).toMatchObject({ status: 'excluded', next_attempt_at: null })
  })

  it('retries next day, and the third failure moves the row to its 30-day window', () => {
    const first = nextState(row, { status: 'retry', reason: 'timeout' }, NOW)
    expect(first).toMatchObject({ attempts: 1 })
    expect(first.status).toBeUndefined()
    expect(days(first.next_attempt_at)).toBe(1)
    const third = nextState({ ...row, attempts: 2 }, { status: 'retry', reason: 'timeout' }, NOW)
    expect(third).toMatchObject({ status: 'missing', attempts: 0 })
    expect(days(third.next_attempt_at)).toBe(30)
  })

  it('never throws a found icon away when a refresh fails', () => {
    const kept = { ...row, status: 'found' as const }
    expect(nextState(kept, { status: 'blocked', reason: 'http_403' }, NOW).status).toBeUndefined()
    expect(nextState(kept, { status: 'missing', reason: 'x' }, NOW).status).toBeUndefined()
    expect(nextState({ ...kept, attempts: 2 }, { status: 'retry', reason: 'x' }, NOW).status).toBeUndefined()
  })
})

describe('runVendorLogos', () => {
  it('fetches the due domains, uploads found icons by hash and records every outcome', async () => {
    const due = [
      { domain: 'loopia.se', status: 'pending', attempts: 0 },
      { domain: 'dustin.se', status: 'pending', attempts: 0 },
      { domain: 'fortnox.se', status: 'pending', attempts: 0 },
    ]
    const c = client((calls) => (has(calls, 'update') ? { data: null } : { data: due }))
    const fetchIcon = vi.fn(async (domain: string): Promise<FetchOutcome> =>
      domain === 'loopia.se' ? found : { status: 'blocked', reason: 'http_403' },
    )
    const summary = await runVendorLogos(c.service, { collect: false, fetchIcon, now: () => NOW })

    expect(summary).toMatchObject({ due: 3, found: 1, blocked: 1, excluded: 1, failed: 0, deferred: 0 })
    // An excluded domain is never handed to the fetcher.
    expect(fetchIcon.mock.calls.map((a) => a[0]).sort()).toEqual(['dustin.se', 'loopia.se'])
    expect(c.upload).toHaveBeenCalledWith(`vendor-icons/${SHA}.png`, found.status === 'found' ? found.icon.png : null, expect.objectContaining({ contentType: 'image/png', upsert: true }))
    const updates = c.payloads('vendor_logos', 'update') as Array<{ status?: string; storage_path?: string }>
    expect(updates).toHaveLength(3)
    expect(updates.find((u) => u.status === 'found')?.storage_path).toBe(`vendor-icons/${SHA}.png`)
    // At most 50 due rows, oldest first.
    expect(c.findCall('vendor_logos', 'limit')).toEqual([50])
    expect(c.findCall('vendor_logos', 'lte')).toEqual(['next_attempt_at', NOW.toISOString()])
  })

  it('counts a failed upload as an attempt, not a found icon', async () => {
    const c = client((calls) => (has(calls, 'update') ? { data: null } : { data: [{ domain: 'loopia.se', status: 'pending', attempts: 0 }] }))
    c.upload.mockResolvedValueOnce({ data: null, error: { message: 'storage down' } })
    const summary = await runVendorLogos(c.service, { collect: false, fetchIcon: async () => found, now: () => NOW })
    expect(summary).toMatchObject({ found: 0, failed: 1 })
    expect(c.payloads('vendor_logos', 'update')).toEqual([expect.objectContaining({ attempts: 1 })])
  })

  it('stops starting new domains when the run budget is spent', async () => {
    const due = Array.from({ length: 6 }, (_, i) => ({ domain: `v${i}.se`, status: 'pending', attempts: 0 }))
    const c = client((calls) => (has(calls, 'update') ? { data: null } : { data: due }))
    let t = NOW.getTime()
    const now = () => new Date(t)
    const fetchIcon = vi.fn(async (): Promise<FetchOutcome> => {
      t += 100_000
      return { status: 'missing', reason: 'x' }
    })
    const summary = await runVendorLogos(c.service, { collect: false, fetchIcon, now, concurrency: 1, budgetMs: 250_000 })
    expect(summary.missing + summary.deferred).toBe(6)
    expect(summary.deferred).toBeGreaterThan(0)
  })

  it('collects domains from suppliers, documents and bank texts, and queues the new ones', async () => {
    const c = client(
      (calls) => (has(calls, 'upsert') || has(calls, 'update') ? { data: null } : { data: [] }),
      {
        suppliers: [{ id: 's1', name: 'Acme Konsult AB', email: 'faktura@acme.se' }],
        invoice_inbox_items: [{ id: 'i1', email_from: 'Hallon <noreply@billogram.com>', supplier_name: 'Hallon' }],
        transactions: [{ id: 't1', merchant_name: null, description: 'KORTKÖP ELEVENLABS.IO' }],
      },
    )
    const summary = await runVendorLogos(c.service, { collect: true, fetchIcon: async () => found, now: () => NOW })
    const queued = (c.payloads('vendor_logos', 'upsert') as Array<Array<{ domain: string }>>).flat().map((r) => r.domain)
    expect(queued).toEqual(expect.arrayContaining(['acme.se', 'hallon.se', 'elevenlabs.io', 'loopia.se']))
    expect(queued).not.toContain('billogram.com')
    expect(queued).not.toContain('skatteverket.se')
    expect(summary.read).toEqual({ suppliers: 1, documents: 1, transactions: 1 })
    // Bank texts are read only where a website could be written in them.
    // Two weeks at a time (collect.test.ts), each window for both columns.
    expect(new Set(c.findCalls('transactions', 'ilikeAnyOf').map((a) => a[0]))).toEqual(new Set(['description', 'merchant_name']))
    expect(c.findCall('transactions', 'ilikeAnyOf')?.[1]).toContain('%.se%')
    expect(c.findCall('vendor_logos', 'upsert')?.[1]).toEqual({ onConflict: 'domain', ignoreDuplicates: true })
  })
})

describe('vendorLogoUrls', () => {
  it('answers a public URL per counterpart with a found icon, in one query', async () => {
    const c = client(() => ({ data: [{ domain: 'loopia.se', storage_path: `vendor-icons/${SHA}.png` }] }))
    const urls = await vendorLogoUrls(
      [
        { key: 'a', name: 'LOOPIA AB' },
        { key: 'b', name: 'Loopia', emails: ['faktura@loopia.se'] },
        { key: 'c', name: 'Kalle Andersson' },
        { key: 'd', name: 'Hallon' },
      ],
      c.service,
    )
    expect(urls.get('a')).toBe(`https://db.example/storage/v1/object/public/logos/vendor-icons/${SHA}.png`)
    expect(urls.get('b')).toBe(urls.get('a'))
    expect(urls.has('c')).toBe(false)
    expect(urls.has('d')).toBe(false)
    expect(c.tables()).toEqual(['vendor_logos'])
    expect(c.findCall('vendor_logos', 'eq')).toEqual(['status', 'found'])
    expect((c.findCall('vendor_logos', 'in')?.[1] as string[]).sort()).toEqual(['hallon.se', 'loopia.se'])
  })

  it('reads nothing when no counterpart resolves, and no logo on a failed read', async () => {
    const quiet = client(() => ({ data: [] }))
    expect((await vendorLogoUrls([{ key: 'a', name: 'Kalle Andersson' }], quiet.service)).size).toBe(0)
    expect(quiet.tables()).toEqual([])

    const broken = client(() => ({ error: { message: 'boom' } }))
    expect((await vendorLogoUrls([{ key: 'a', name: 'Hallon' }], broken.service)).size).toBe(0)
  })
})

describe('vendorLogosFetchEnabled', () => {
  it('is off unless set to true or 1', () => {
    expect(vendorLogosFetchEnabled({})).toBe(false)
    expect(vendorLogosFetchEnabled({ VENDOR_LOGOS_FETCH: 'false' })).toBe(false)
    expect(vendorLogosFetchEnabled({ VENDOR_LOGOS_FETCH: 'true' })).toBe(true)
    expect(vendorLogosFetchEnabled({ VENDOR_LOGOS_FETCH: '1' })).toBe(true)
  })
})
