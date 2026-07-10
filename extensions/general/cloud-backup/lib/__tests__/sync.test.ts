/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/reports/full-archive-export', () => ({
  estimateArchiveSize: vi.fn(),
  generateFullArchive: vi.fn(),
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

vi.mock('../google-drive', () => ({
  ensureFolder: vi.fn(),
  uploadFile: vi.fn(),
}))

vi.mock('../crypto', () => ({
  decryptToken: vi.fn().mockReturnValue('plain-refresh-token'),
}))

import { performSync, CONNECTION_KEY, LAST_SYNC_KEY } from '../sync'
import { GoogleTokenRefreshError, refreshAccessToken } from '../google-oauth'
import { ensureFolder, uploadFile } from '../google-drive'
import {
  estimateArchiveSize,
  generateFullArchive,
} from '@/lib/reports/full-archive-export'
import type { GoogleDriveConnection } from '../../types'

const mockRefreshAccessToken = vi.mocked(refreshAccessToken)
const mockEnsureFolder = vi.mocked(ensureFolder)
const mockUploadFile = vi.mocked(uploadFile)
const mockEstimateArchiveSize = vi.mocked(estimateArchiveSize)
const mockGenerateFullArchive = vi.mocked(generateFullArchive)

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

/**
 * Minimal supabase stub covering what performSync touches:
 * - extension_data select ... maybeSingle() (connection load)
 * - extension_data upsert (connection/last-sync save)
 * - company_settings select ... maybeSingle() (folder label)
 */
function makeSupabase(connection: GoogleDriveConnection | null) {
  const upsert = vi.fn().mockResolvedValue({ error: null })
  const from = vi.fn().mockImplementation((table: string) => {
    const chain: any = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data:
          table === 'extension_data'
            ? connection
              ? { value: connection }
              : null
            : { company_name: 'Testbolag AB', org_number: '556000-0000' },
      }),
      upsert,
    }
    return chain
  })
  return { supabase: { from } as any, upsert }
}

function syncParams(supabase: any) {
  return {
    supabase,
    companyId: 'company-1',
    userId: 'user-1',
    origin: 'https://app.test',
    includeDocuments: true,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockEstimateArchiveSize.mockResolvedValue({
    total_bytes: 1_000,
    document_bytes: 100,
  } as any)
})

describe('performSync needs_reauth handling', () => {
  it('flags the connection needs_reauth when Google returns 400 invalid_grant', async () => {
    const { supabase, upsert } = makeSupabase(makeConnection())
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
    // Token, email etc. stay intact so the UI can still show the account.
    expect(payload.value.account_email).toBe('user@example.com')
    expect(mockGenerateFullArchive).not.toHaveBeenCalled()
    expect(mockUploadFile).not.toHaveBeenCalled()
  })

  it('rethrows transient refresh failures (5xx) without flagging', async () => {
    const { supabase, upsert } = makeSupabase(makeConnection())
    mockRefreshAccessToken.mockRejectedValueOnce(
      new GoogleTokenRefreshError(500, 'Internal Server Error')
    )

    await expect(performSync(syncParams(supabase))).rejects.toThrow(/500/)
    expect(upsert).not.toHaveBeenCalled()
  })

  it('rethrows a 400 that is not invalid_grant without flagging', async () => {
    const { supabase, upsert } = makeSupabase(makeConnection())
    mockRefreshAccessToken.mockRejectedValueOnce(
      new GoogleTokenRefreshError(400, '{"error":"invalid_request"}')
    )

    await expect(performSync(syncParams(supabase))).rejects.toThrow(/400/)
    expect(upsert).not.toHaveBeenCalled()
  })

  it('rethrows non-refresh errors untouched', async () => {
    const { supabase, upsert } = makeSupabase(makeConnection())
    mockRefreshAccessToken.mockRejectedValueOnce(new Error('network down'))

    await expect(performSync(syncParams(supabase))).rejects.toThrow('network down')
    expect(upsert).not.toHaveBeenCalled()
  })

  it('clears a stale needs_reauth flag after a successful refresh', async () => {
    const { supabase, upsert } = makeSupabase(
      makeConnection({
        status: 'needs_reauth',
        needs_reauth_at: '2026-07-01T03:00:00.000Z',
      })
    )
    mockRefreshAccessToken.mockResolvedValueOnce({
      access_token: 'fresh-token',
      expires_in: 3600,
    })
    mockGenerateFullArchive.mockResolvedValueOnce(new ArrayBuffer(8))
    mockUploadFile.mockResolvedValueOnce({
      id: 'file-1',
      name: 'arkiv.zip',
      size_bytes: 8,
      web_view_link: 'https://drive.google.com/file/d/file-1/view',
    } as any)

    const result = await performSync(syncParams(supabase))

    expect(result.ok).toBe(true)
    // First upsert rewrites the connection with the flag cleared.
    const connectionSave = upsert.mock.calls.find(
      ([payload]) => payload.key === CONNECTION_KEY
    )
    expect(connectionSave).toBeDefined()
    expect(connectionSave![0].value.status).toBe('active')
    // Last-sync state is still persisted as usual.
    const lastSyncSave = upsert.mock.calls.find(
      ([payload]) => payload.key === LAST_SYNC_KEY
    )
    expect(lastSyncSave).toBeDefined()
  })

  it('still returns not_connected when no connection exists', async () => {
    const { supabase } = makeSupabase(null)

    const result = await performSync(syncParams(supabase))

    expect(result).toMatchObject({ ok: false, reason: 'not_connected' })
    expect(mockRefreshAccessToken).not.toHaveBeenCalled()
    expect(mockEnsureFolder).not.toHaveBeenCalled()
  })
})
