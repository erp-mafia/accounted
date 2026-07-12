/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from 'node:crypto'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/reports/full-archive-export', () => ({
  generateFullArchive: vi.fn(),
  generateBaseDataArchive: vi.fn(),
  ARCHIVE_OVERHEAD_BYTES: 8 * 1024 * 1024,
}))

vi.mock('@/lib/reports/archive-readme', () => ({
  buildDriveFolderReadme: vi.fn().mockReturnValue('README TEXT'),
}))

vi.mock('@/lib/branding/service', () => ({
  getBranding: () => ({ appName: 'Accounted', appUrl: 'https://app.test' }),
}))

vi.mock('../google-oauth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../google-oauth')>()
  return {
    ...actual,
    getOAuthEnv: vi.fn().mockReturnValue({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://app.test/callback',
    }),
    refreshAccessToken: vi.fn(),
  }
})

vi.mock('../google-drive', () => {
  class DriveFileGoneError extends Error {}
  return {
    ensureFolder: vi.fn(),
    uploadFile: vi.fn(),
    updateFile: vi.fn(),
    getFileMeta: vi.fn(),
    DriveFileGoneError,
  }
})

vi.mock('../crypto', () => ({
  decryptToken: vi.fn().mockReturnValue('plain-refresh-token'),
}))

import {
  performSync,
  CONNECTION_KEY,
  LAST_SYNC_KEY,
  ARCHIVE_FORMAT_VERSION,
  SIZE_LIMIT_BYTES,
  arkivFileName,
} from '../sync'
import { GoogleTokenRefreshError, refreshAccessToken } from '../google-oauth'
import {
  DriveFileGoneError,
  ensureFolder,
  getFileMeta,
  updateFile,
  uploadFile,
} from '../google-drive'
import {
  generateFullArchive,
  generateBaseDataArchive,
} from '@/lib/reports/full-archive-export'
import type { GoogleDriveConnection, GoogleDriveLastSync } from '../../types'

const mockRefreshAccessToken = vi.mocked(refreshAccessToken)
const mockEnsureFolder = vi.mocked(ensureFolder)
const mockGetFileMeta = vi.mocked(getFileMeta)
const mockUploadFile = vi.mocked(uploadFile)
const mockUpdateFile = vi.mocked(updateFile)
const mockGenerateFullArchive = vi.mocked(generateFullArchive)
const mockGenerateBaseDataArchive = vi.mocked(generateBaseDataArchive)

function makeConnection(
  overrides: Partial<GoogleDriveConnection> = {}
): GoogleDriveConnection {
  return {
    refresh_token_encrypted: 'encrypted-token',
    account_email: 'user@example.com',
    connected_at: '2026-01-01T00:00:00.000Z',
    root_folder_id: 'root-1',
    company_folder_id: 'company-1',
    ...overrides,
  }
}

const PERIOD = { id: 'p-2024', period_start: '2024-01-01', period_end: '2024-12-31' }
const ENTRY = { id: 'e-1', fiscal_period_id: 'p-2024', updated_at: '2024-06-01T00:00:00Z' }
const AUDIT_AT = '2026-07-01T00:00:00Z'

interface MockData {
  connection?: GoogleDriveConnection | null
  lastSync?: GoogleDriveLastSync | null
  periods?: (typeof PERIOD)[]
  entries?: (typeof ENTRY)[]
  docs?: {
    id: string
    journal_entry_id: string | null
    file_size_bytes: number | null
    created_at: string | null
  }[]
  auditAt?: string
}

/**
 * Table-routed supabase stub: performSync touches extension_data (connection,
 * last-sync), company_settings, fiscal_periods, journal_entries,
 * document_attachments and audit_log. Thenable chains resolve per table.
 */
function makeSupabase(data: MockData) {
  const upsert = vi.fn().mockResolvedValue({ error: null })
  const from = vi.fn().mockImplementation((table: string) => {
    let key: string | null = null
    const chain: any = {
      upsert,
      maybeSingle: vi.fn().mockImplementation(() => {
        if (table === 'extension_data') {
          if (key === 'google_drive_last_sync') {
            return Promise.resolve({
              data: data.lastSync ? { value: data.lastSync } : null,
            })
          }
          return Promise.resolve({
            data: data.connection ? { value: data.connection } : null,
          })
        }
        if (table === 'company_settings') {
          return Promise.resolve({
            data: { company_name: 'Testbolag AB', org_number: '556000-0000' },
          })
        }
        return Promise.resolve({ data: null })
      }),
      then: (resolve: (v: unknown) => void) => {
        if (table === 'fiscal_periods') {
          return resolve({ data: data.periods ?? [PERIOD], error: null })
        }
        if (table === 'journal_entries') {
          return resolve({ data: data.entries ?? [ENTRY], error: null })
        }
        if (table === 'document_attachments') {
          return resolve({ data: data.docs ?? [], error: null })
        }
        if (table === 'audit_log') {
          return resolve({
            data: [{ created_at: data.auditAt ?? AUDIT_AT }],
            error: null,
          })
        }
        return resolve({ data: [], error: null })
      },
    }
    const passthrough = ['select', 'eq', 'in', 'order', 'range', 'limit']
    for (const method of passthrough) {
      chain[method] = vi.fn().mockImplementation((col?: string, val?: string) => {
        if (method === 'eq' && col === 'key') key = val ?? null
        return chain
      })
    }
    return chain
  })
  return { supabase: { from } as any, upsert }
}

function syncParams(supabase: any, overrides: Record<string, unknown> = {}) {
  return {
    supabase,
    companyId: 'company-1',
    userId: 'user-1',
    origin: 'https://app.test',
    includeDocuments: true,
    ...overrides,
  }
}

function sha256(data: ArrayBuffer | string): string {
  return createHash('sha256')
    .update(typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data))
    .digest('hex')
}

// Fingerprints performSync derives from the fixture above.
const PERIOD_FP = `v${ARCHIVE_FORMAT_VERSION}|1|${ENTRY.updated_at}|0||docs:1`
const BASE_FP = `v${ARCHIVE_FORMAT_VERSION}|${AUDIT_AT}|0||docs:1`
const README_FP = `v${ARCHIVE_FORMAT_VERSION}|${sha256('README TEXT').slice(0, 16)}`

function upToDateLastSync(): GoogleDriveLastSync {
  return {
    at: '2026-07-11T03:00:00.000Z',
    folder_id: 'company-1',
    files: [
      {
        kind: 'period',
        period_id: PERIOD.id,
        file_id: 'drive-period',
        file_name: 'Arkiv 2024.zip',
        size_bytes: 100,
        fingerprint: PERIOD_FP,
        sha256: 'x',
        included_documents: true,
        uploaded_at: '2026-07-11T03:00:00.000Z',
      },
      {
        kind: 'base',
        file_id: 'drive-base',
        file_name: 'Grunddata.zip',
        size_bytes: 50,
        fingerprint: BASE_FP,
        sha256: 'y',
        included_documents: true,
        uploaded_at: '2026-07-11T03:00:00.000Z',
      },
      {
        kind: 'readme',
        file_id: 'drive-readme',
        file_name: 'LÄSMIG.txt',
        size_bytes: 11,
        fingerprint: README_FP,
        sha256: 'z',
        included_documents: true,
        uploaded_at: '2026-07-11T03:00:00.000Z',
      },
    ],
    total_size_bytes: 161,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetFileMeta.mockResolvedValue({ id: 'company-1', name: 'Testbolag', trashed: false })
  mockRefreshAccessToken.mockResolvedValue({ access_token: 'fresh-token', expires_in: 3600 })
  mockGenerateFullArchive.mockResolvedValue(new ArrayBuffer(8))
  mockGenerateBaseDataArchive.mockResolvedValue(new ArrayBuffer(16))
  mockUploadFile.mockImplementation(async (_t, _folder, name, data) => ({
    id: `created-${name}`,
    name,
    size_bytes: (data as ArrayBuffer).byteLength,
    web_view_link: `https://drive.google.com/file/d/created-${name}/view`,
  }))
  mockUpdateFile.mockImplementation(async (_t, fileId, data) => ({
    id: fileId,
    name: 'updated',
    size_bytes: (data as ArrayBuffer).byteLength,
    web_view_link: `https://drive.google.com/file/d/${fileId}/view`,
  }))
})

describe('performSync needs_reauth handling', () => {
  it('flags the connection needs_reauth when Google returns 400 invalid_grant', async () => {
    const { supabase, upsert } = makeSupabase({ connection: makeConnection() })
    mockRefreshAccessToken.mockRejectedValueOnce(
      new GoogleTokenRefreshError(
        400,
        '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}'
      )
    )

    const result = await performSync(syncParams(supabase))

    expect(result).toMatchObject({ ok: false, reason: 'needs_reauth' })
    expect(upsert).toHaveBeenCalledTimes(1)
    const [payload] = upsert.mock.calls[0]
    expect(payload.key).toBe(CONNECTION_KEY)
    expect(payload.value.status).toBe('needs_reauth')
    expect(payload.value.needs_reauth_at).toEqual(expect.any(String))
    expect(payload.value.account_email).toBe('user@example.com')
    expect(mockGenerateFullArchive).not.toHaveBeenCalled()
    expect(mockUploadFile).not.toHaveBeenCalled()
  })

  it('rethrows transient refresh failures (5xx) without flagging', async () => {
    const { supabase, upsert } = makeSupabase({ connection: makeConnection() })
    mockRefreshAccessToken.mockRejectedValueOnce(
      new GoogleTokenRefreshError(500, 'Internal Server Error')
    )

    await expect(performSync(syncParams(supabase))).rejects.toThrow(/500/)
    expect(upsert).not.toHaveBeenCalled()
  })

  it('clears a stale needs_reauth flag after a successful refresh', async () => {
    const { supabase, upsert } = makeSupabase({
      connection: makeConnection({
        status: 'needs_reauth',
        needs_reauth_at: '2026-07-01T03:00:00.000Z',
      }),
    })

    const result = await performSync(syncParams(supabase))

    expect(result.ok).toBe(true)
    const connectionSave = upsert.mock.calls.find(
      ([payload]) => payload.key === CONNECTION_KEY
    )
    expect(connectionSave).toBeDefined()
    expect(connectionSave![0].value.status).toBe('active')
  })

  it('returns not_connected when no connection exists', async () => {
    const { supabase } = makeSupabase({ connection: null })

    const result = await performSync(syncParams(supabase))

    expect(result).toMatchObject({ ok: false, reason: 'not_connected' })
    expect(mockRefreshAccessToken).not.toHaveBeenCalled()
  })
})

describe('performSync per-fiscal-year layout', () => {
  it('uploads one archive per period plus Grunddata and the folder README on first sync', async () => {
    const { supabase, upsert } = makeSupabase({ connection: makeConnection() })

    const result = await performSync(syncParams(supabase))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.uploadedCount).toBe(3)
    expect(result.skippedCount).toBe(0)
    expect(result.webViewLink).toBe('https://drive.google.com/drive/folders/company-1')
    expect(mockUploadFile).toHaveBeenCalledTimes(3)
    const names = mockUploadFile.mock.calls.map((c) => c[2])
    expect(names).toEqual(['Arkiv 2024.zip', 'Grunddata.zip', 'LÄSMIG.txt'])

    const lastSyncSaves = upsert.mock.calls.filter(([p]) => p.key === LAST_SYNC_KEY)
    // Progressive persistence: one snapshot per upload + the final one.
    expect(lastSyncSaves.length).toBe(4)
    const final = lastSyncSaves[lastSyncSaves.length - 1][0].value as GoogleDriveLastSync
    expect(final.files).toHaveLength(3)
    expect(final.total_size_bytes).toBe(8 + 16 + Buffer.from('README TEXT').length)
    const periodFile = final.files!.find((f) => f.kind === 'period')!
    expect(periodFile.fingerprint).toBe(PERIOD_FP)
    expect(periodFile.sha256).toBe(sha256(new ArrayBuffer(8)))
    expect(periodFile.included_documents).toBe(true)
  })

  it('skips everything when fingerprints are unchanged', async () => {
    const { supabase, upsert } = makeSupabase({
      connection: makeConnection(),
      lastSync: upToDateLastSync(),
    })

    const result = await performSync(syncParams(supabase))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.uploadedCount).toBe(0)
    expect(result.skippedCount).toBe(3)
    expect(mockGenerateFullArchive).not.toHaveBeenCalled()
    expect(mockGenerateBaseDataArchive).not.toHaveBeenCalled()
    expect(mockUploadFile).not.toHaveBeenCalled()
    expect(mockUpdateFile).not.toHaveBeenCalled()
    // The final snapshot still refreshes `at` so the card shows recency.
    const lastSyncSaves = upsert.mock.calls.filter(([p]) => p.key === LAST_SYNC_KEY)
    expect(lastSyncSaves.length).toBe(1)
  })

  it('updates only the changed period file, in place', async () => {
    const stale = upToDateLastSync()
    stale.files![0].fingerprint = 'v2|0||0||docs:1' // period data changed since
    const { supabase } = makeSupabase({
      connection: makeConnection(),
      lastSync: stale,
    })

    const result = await performSync(syncParams(supabase))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.uploadedCount).toBe(1)
    expect(result.skippedCount).toBe(2)
    expect(mockUpdateFile).toHaveBeenCalledTimes(1)
    expect(mockUpdateFile.mock.calls[0][1]).toBe('drive-period')
    expect(mockUploadFile).not.toHaveBeenCalled()
  })

  it('recreates a file the user deleted in Drive', async () => {
    const stale = upToDateLastSync()
    stale.files![0].fingerprint = 'changed'
    const { supabase } = makeSupabase({
      connection: makeConnection(),
      lastSync: stale,
    })
    mockUpdateFile.mockRejectedValueOnce(new DriveFileGoneError('gone'))

    const result = await performSync(syncParams(supabase))

    expect(result.ok).toBe(true)
    expect(mockUploadFile).toHaveBeenCalledTimes(1)
    expect(mockUploadFile.mock.calls[0][2]).toBe('Arkiv 2024.zip')
  })

  it('re-uploads everything for legacy single-file last_sync records', async () => {
    const { supabase } = makeSupabase({
      connection: makeConnection(),
      lastSync: {
        at: '2026-07-01T00:00:00Z',
        folder_id: 'company-1',
        file_id: 'legacy',
        file_name: 'arkiv_full_x.zip',
        file_size_bytes: 123,
      },
    })

    const result = await performSync(syncParams(supabase))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.uploadedCount).toBe(3)
    expect(mockUpdateFile).not.toHaveBeenCalled()
  })
})

describe('performSync size limits and document fallback', () => {
  const hugeDoc = {
    id: 'doc-huge',
    journal_entry_id: 'e-1',
    file_size_bytes: SIZE_LIMIT_BYTES,
    created_at: '2024-07-01T00:00:00Z',
  }

  it('fails with archive_too_large when a period cannot fit and fallback is off', async () => {
    const { supabase } = makeSupabase({
      connection: makeConnection(),
      docs: [hugeDoc],
    })

    const result = await performSync(syncParams(supabase))

    expect(result).toMatchObject({
      ok: false,
      reason: 'archive_too_large',
      size_limit_bytes: SIZE_LIMIT_BYTES,
    })
    expect(mockUploadFile).not.toHaveBeenCalled()
  })

  it('builds the oversized period without documents when fallback is allowed', async () => {
    const { supabase, upsert } = makeSupabase({
      connection: makeConnection(),
      docs: [hugeDoc],
    })

    const result = await performSync(
      syncParams(supabase, { allowDocumentFallback: true })
    )

    expect(result.ok).toBe(true)
    expect(mockGenerateFullArchive).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      expect.objectContaining({ scope: 'period', include_documents: false })
    )
    // Grunddata is unaffected: it still carries its (small) documents.
    expect(mockGenerateBaseDataArchive).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      expect.objectContaining({ include_documents: true })
    )
    const lastSyncSaves = upsert.mock.calls.filter(([p]) => p.key === LAST_SYNC_KEY)
    const final = lastSyncSaves[lastSyncSaves.length - 1][0].value as GoogleDriveLastSync
    const periodFile = final.files!.find((f) => f.kind === 'period')!
    expect(periodFile.included_documents).toBe(false)
    expect(periodFile.fingerprint).toContain('docs:0')
  })
})

describe('performSync folder revalidation', () => {
  it('recreates the folder hierarchy when cached folders are trashed', async () => {
    const { supabase, upsert } = makeSupabase({ connection: makeConnection() })
    mockGetFileMeta
      .mockResolvedValueOnce({ id: 'company-1', name: 'x', trashed: true })
      .mockResolvedValueOnce({ id: 'root-1', name: 'gnubok', trashed: true })
    mockEnsureFolder
      .mockResolvedValueOnce({ id: 'root-2', name: 'gnubok' })
      .mockResolvedValueOnce({ id: 'company-2', name: 'Testbolag AB (556000-0000)' })

    const result = await performSync(syncParams(supabase))

    expect(result.ok).toBe(true)
    expect(mockEnsureFolder).toHaveBeenCalledTimes(2)
    const connectionSave = upsert.mock.calls.find(([p]) => p.key === CONNECTION_KEY)
    expect(connectionSave![0].value.root_folder_id).toBe('root-2')
    expect(connectionSave![0].value.company_folder_id).toBe('company-2')
    // Uploads target the recreated company folder.
    expect(mockUploadFile.mock.calls[0][1]).toBe('company-2')
  })

  it('does not touch folders when the cached company folder is alive', async () => {
    const { supabase } = makeSupabase({ connection: makeConnection() })

    const result = await performSync(syncParams(supabase))

    expect(result.ok).toBe(true)
    expect(mockGetFileMeta).toHaveBeenCalledTimes(1)
    expect(mockEnsureFolder).not.toHaveBeenCalled()
  })
})

describe('arkivFileName', () => {
  it('uses the year alone for calendar years', () => {
    expect(arkivFileName(PERIOD)).toBe('Arkiv 2024.zip')
  })

  it('uses full dates for broken fiscal years', () => {
    expect(
      arkivFileName({ id: 'p', period_start: '2024-07-01', period_end: '2025-06-30' })
    ).toBe('Arkiv 2024-07-01_2025-06-30.zip')
  })
})
