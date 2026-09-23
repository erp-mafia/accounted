/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/reports/full-archive-export', () => ({
  generateFullArchive: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
  generateBaseDataArchive: vi.fn().mockResolvedValue(new ArrayBuffer(16)),
  ARCHIVE_OVERHEAD_BYTES: 8 * 1024 * 1024,
}))

vi.mock('@/lib/reports/archive-readme', () => ({
  buildDriveFolderReadme: vi.fn().mockReturnValue('README TEXT'),
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(() => ({ storage: { from: vi.fn() } })),
}))

vi.mock('@/lib/branding/service', () => ({
  getBranding: () => ({ appName: 'Accounted', appUrl: 'https://app.test' }),
}))

vi.mock('../crypto', () => ({
  decryptToken: vi.fn().mockReturnValue('plain-refresh-token'),
}))

import { performSync } from '../sync'
import { CloudTokenRefreshError, type CloudStorageProvider } from '../cloud-provider'
import type { CloudConnection, CloudLastSync } from '../../types'

const PERIOD = { id: 'p-2024', period_start: '2024-01-01', period_end: '2024-12-31' }
const ENTRY = { id: 'e-1', fiscal_period_id: 'p-2024', updated_at: '2024-06-01T00:00:00Z' }

function makeConnection(): CloudConnection {
  return {
    refresh_token_encrypted: 'encrypted-token',
    account_email: 'user@example.com',
    connected_at: '2026-01-01T00:00:00.000Z',
    root_folder_id: null,
    company_folder_id: null,
  }
}

/**
 * Supabase stub that stores extension_data per key, so a test can assert which
 * provider's records a sync read and wrote.
 */
function makeSupabase(seed: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(seed))
  const writes: { key: string; value: unknown }[] = []

  const upsert = vi.fn().mockImplementation((payload: any) => {
    store.set(payload.key, payload.value)
    writes.push({ key: payload.key, value: payload.value })
    return Promise.resolve({ error: null })
  })

  const from = vi.fn().mockImplementation((table: string) => {
    let key: string | null = null
    const chain: any = {
      upsert,
      maybeSingle: vi.fn().mockImplementation(() => {
        if (table === 'extension_data') {
          const value = key ? store.get(key) : undefined
          return Promise.resolve({ data: value ? { value } : null })
        }
        if (table === 'company_settings') {
          return Promise.resolve({
            data: { company_name: 'Testbolag AB', org_number: '556000-0000' },
          })
        }
        return Promise.resolve({ data: null })
      }),
      then: (resolve: (v: unknown) => void) => {
        if (table === 'fiscal_periods') return resolve({ data: [PERIOD], error: null })
        if (table === 'journal_entries') return resolve({ data: [ENTRY], error: null })
        if (table === 'document_attachments') return resolve({ data: [], error: null })
        if (table === 'audit_log') {
          return resolve({ data: [{ created_at: '2026-07-01T00:00:00Z' }], error: null })
        }
        return resolve({ data: [], error: null })
      },
    }
    for (const method of ['select', 'eq', 'neq', 'in', 'order', 'range', 'limit']) {
      chain[method] = vi.fn().mockImplementation((col?: string, val?: string) => {
        if (method === 'eq' && col === 'key') key = val ?? null
        return chain
      })
    }
    return chain
  })

  return { supabase: { from } as any, store, writes, upsert }
}

/** A provider that records what the sync engine asked it to do. */
function makeFakeProvider(
  id: string,
  overrides: Partial<CloudStorageProvider> = {}
): CloudStorageProvider {
  return {
    id: id as CloudStorageProvider['id'],
    label: id,
    keys: {
      connection: `${id}_connection`,
      lastSync: `${id}_last_sync`,
      schedule: `${id}_schedule`,
    },
    callbackPath: `/oauth/${id}/callback`,
    isConfigured: () => true,
    buildAuthorizationUrl: () => 'https://auth.test',
    exchangeCode: vi.fn(),
    revoke: vi.fn(),
    refreshAccessToken: vi.fn().mockResolvedValue('fresh-token'),
    prepareTarget: vi.fn().mockResolvedValue({
      target: { folderId: `folder-${id}`, webViewLink: `https://${id}.test/folder` },
      connectionPatch: null,
    }),
    putFile: vi.fn().mockImplementation(async ({ name, data }: any) => ({
      id: `${id}:${name}`,
      name,
      size_bytes: (data as ArrayBuffer).byteLength,
    })),
    ...overrides,
  } as CloudStorageProvider
}

function syncParams(supabase: any, provider: CloudStorageProvider) {
  return {
    supabase,
    companyId: 'company-1',
    userId: 'user-1',
    origin: 'https://app.test',
    includeDocuments: true,
    provider,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('performSync provider routing', () => {
  it('reads and writes only the requested provider records', async () => {
    const provider = makeFakeProvider('dropbox')
    const { supabase, writes } = makeSupabase({
      dropbox_connection: makeConnection(),
    })

    const result = await performSync(syncParams(supabase, provider))

    expect(result.ok).toBe(true)
    const touchedKeys = new Set(writes.map((w) => w.key))
    expect([...touchedKeys]).toEqual(['dropbox_last_sync'])
    // Nothing under the Google keys was written.
    expect([...touchedKeys].some((k) => k.startsWith('google_drive'))).toBe(false)
  })

  it('returns not_connected when only the OTHER provider is connected', async () => {
    const provider = makeFakeProvider('dropbox')
    const { supabase } = makeSupabase({
      google_drive_connection: makeConnection(),
    })

    const result = await performSync(syncParams(supabase, provider))

    expect(result).toMatchObject({ ok: false, reason: 'not_connected' })
    expect(provider.refreshAccessToken).not.toHaveBeenCalled()
  })

  it('uploads the full file set through the provider and reports its folder link', async () => {
    const provider = makeFakeProvider('dropbox')
    const { supabase } = makeSupabase({ dropbox_connection: makeConnection() })

    const result = await performSync(syncParams(supabase, provider))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.uploadedCount).toBe(3)
    expect(result.webViewLink).toBe('https://dropbox.test/folder')
    const names = vi.mocked(provider.putFile).mock.calls.map((c) => c[0].name)
    expect(names).toEqual(['Arkiv 2024.zip', 'Grunddata.zip', 'LÄSMIG.txt'])
    // Every upload targets the folder prepareTarget resolved.
    for (const call of vi.mocked(provider.putFile).mock.calls) {
      expect(call[0].target.folderId).toBe('folder-dropbox')
    }
  })

  it('records the folder link on the snapshot so the UI can link without guessing', async () => {
    const provider = makeFakeProvider('dropbox')
    const { supabase, store } = makeSupabase({ dropbox_connection: makeConnection() })

    await performSync(syncParams(supabase, provider))

    const snapshot = store.get('dropbox_last_sync') as CloudLastSync
    expect(snapshot.web_view_link).toBe('https://dropbox.test/folder')
    expect(snapshot.folder_id).toBe('folder-dropbox')
  })

  it('flags only the failing provider needs_reauth on a dead refresh token', async () => {
    const provider = makeFakeProvider('dropbox', {
      refreshAccessToken: vi
        .fn()
        .mockRejectedValue(
          new CloudTokenRefreshError('Dropbox', 400, '{"error":"invalid_grant"}')
        ),
    })
    const { supabase, store, writes } = makeSupabase({
      dropbox_connection: makeConnection(),
      google_drive_connection: makeConnection(),
    })

    const result = await performSync(syncParams(supabase, provider))

    expect(result).toMatchObject({ ok: false, reason: 'needs_reauth' })
    expect((store.get('dropbox_connection') as CloudConnection).status).toBe('needs_reauth')
    // The healthy Google connection is left exactly as it was.
    expect((store.get('google_drive_connection') as CloudConnection).status).toBeUndefined()
    expect(writes.every((w) => w.key === 'dropbox_connection')).toBe(true)
  })

  it('rethrows a transient refresh failure without flagging the connection', async () => {
    const provider = makeFakeProvider('dropbox', {
      refreshAccessToken: vi
        .fn()
        .mockRejectedValue(new CloudTokenRefreshError('Dropbox', 500, 'Server Error')),
    })
    const { supabase, writes } = makeSupabase({ dropbox_connection: makeConnection() })

    await expect(performSync(syncParams(supabase, provider))).rejects.toThrow(/500/)
    expect(writes).toHaveLength(0)
  })

  it('persists a connection patch the provider asked for', async () => {
    const provider = makeFakeProvider('dropbox', {
      prepareTarget: vi.fn().mockResolvedValue({
        target: { folderId: '/Bolag', webViewLink: 'https://dropbox.test/folder' },
        connectionPatch: { company_folder_path: '/Bolag' },
      }),
    })
    const { supabase, store } = makeSupabase({ dropbox_connection: makeConnection() })

    await performSync(syncParams(supabase, provider))

    expect((store.get('dropbox_connection') as CloudConnection).company_folder_path).toBe(
      '/Bolag'
    )
  })

  it('skips unchanged files using that provider own last-sync record', async () => {
    const provider = makeFakeProvider('dropbox')
    const { supabase } = makeSupabase({ dropbox_connection: makeConnection() })

    await performSync(syncParams(supabase, provider))
    vi.mocked(provider.putFile).mockClear()

    // Second run against the snapshot the first run persisted.
    const second = await performSync(syncParams(supabase, provider))

    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.uploadedCount).toBe(0)
    expect(second.skippedCount).toBe(3)
    expect(provider.putFile).not.toHaveBeenCalled()
  })

  it('passes the previous handle only while the file name is unchanged', async () => {
    const provider = makeFakeProvider('dropbox')
    const { supabase, store } = makeSupabase({ dropbox_connection: makeConnection() })

    await performSync(syncParams(supabase, provider))

    // Invalidate the period fingerprint so the next run re-uploads that file.
    const snapshot = store.get('dropbox_last_sync') as CloudLastSync
    snapshot.files![0].fingerprint = 'stale'
    store.set('dropbox_last_sync', snapshot)
    vi.mocked(provider.putFile).mockClear()

    await performSync(syncParams(supabase, provider))

    const call = vi.mocked(provider.putFile).mock.calls[0][0]
    expect(call.name).toBe('Arkiv 2024.zip')
    expect(call.previousId).toBe('dropbox:Arkiv 2024.zip')
  })
})
