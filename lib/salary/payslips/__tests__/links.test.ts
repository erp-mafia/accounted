import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  generatePayslipToken,
  hashPayslipToken,
  isValidPayslipTokenFormat,
  resolvePayslipToken,
  rotateLinkForEmployee,
  revokeLinksForRun,
} from '../links'

describe('payslip token primitives', () => {
  it('generates a 43-char base64url token whose hash matches hashPayslipToken', () => {
    const { token, hash } = generatePayslipToken()
    expect(isValidPayslipTokenFormat(token)).toBe(true)
    expect(token).toHaveLength(43)
    expect(hash).toBe(hashPayslipToken(token))
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('generates unique tokens', () => {
    const a = generatePayslipToken()
    const b = generatePayslipToken()
    expect(a.token).not.toBe(b.token)
    expect(a.hash).not.toBe(b.hash)
  })

  it('rejects malformed token formats', () => {
    expect(isValidPayslipTokenFormat('')).toBe(false)
    expect(isValidPayslipTokenFormat('short')).toBe(false)
    expect(isValidPayslipTokenFormat('a'.repeat(44))).toBe(false)
    expect(isValidPayslipTokenFormat('!'.repeat(43))).toBe(false)
    // Path traversal / injection shapes never reach the DB
    expect(isValidPayslipTokenFormat('../'.repeat(14) + 'x')).toBe(false)
  })
})

// Minimal purpose-built client mocks — the chains used by links.ts are
// narrow enough that hand-rolling beats the generic queued mock here.
function resolveClient(row: unknown) {
  const updates: Array<Record<string, unknown>> = []
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: row }) }),
      }),
      update: (u: Record<string, unknown>) => {
        updates.push(u)
        return { eq: async () => ({ data: null, error: null }) }
      },
    }),
  }
  return { client: client as unknown as SupabaseClient, updates }
}

const VALID = 'A'.repeat(43)

describe('resolvePayslipToken', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects invalid format without touching the database', async () => {
    const from = vi.fn()
    const client = { from } as unknown as SupabaseClient
    const result = await resolvePayslipToken(client, 'not-a-token')
    expect(result).toEqual({ ok: false, reason: 'invalid_format' })
    expect(from).not.toHaveBeenCalled()
  })

  it('returns not_found for an unknown token', async () => {
    const { client } = resolveClient(null)
    const result = await resolvePayslipToken(client, VALID)
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })

  it('returns revoked before expired for a revoked link', async () => {
    const { client, updates } = resolveClient({
      id: 'link-1',
      revoked_at: '2026-01-01T00:00:00Z',
      expires_at: '2020-01-01T00:00:00Z',
      access_count: 0,
    })
    const result = await resolvePayslipToken(client, VALID)
    expect(result).toEqual({ ok: false, reason: 'revoked' })
    expect(updates).toHaveLength(0)
  })

  it('returns expired for a past expires_at', async () => {
    const { client } = resolveClient({
      id: 'link-1',
      revoked_at: null,
      expires_at: '2020-01-01T00:00:00Z',
      access_count: 0,
    })
    const result = await resolvePayslipToken(client, VALID)
    expect(result).toEqual({ ok: false, reason: 'expired' })
  })

  it('resolves a live link and bumps access tracking', async () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    const row = {
      id: 'link-1',
      company_id: 'company-1',
      salary_run_id: 'run-1',
      employee_id: 'emp-1',
      token_hash: hashPayslipToken(VALID),
      revoked_at: null,
      expires_at: future,
      access_count: 3,
    }
    const { client, updates } = resolveClient(row)
    const result = await resolvePayslipToken(client, VALID)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.link.id).toBe('link-1')
    expect(updates).toHaveLength(1)
    expect(updates[0].access_count).toBe(4)
    expect(updates[0].last_accessed_at).toBeTruthy()
  })
})

describe('rotateLinkForEmployee', () => {
  it('upserts a fresh hash with cleared revocation and returns the raw token', async () => {
    let upserted: Record<string, unknown> | null = null
    let conflictTarget: string | undefined
    const client = {
      from: () => ({
        upsert: async (row: Record<string, unknown>, opts: { onConflict: string }) => {
          upserted = row
          conflictTarget = opts.onConflict
          return { error: null }
        },
      }),
    } as unknown as SupabaseClient

    const { token } = await rotateLinkForEmployee(client, {
      companyId: 'company-1',
      salaryRunId: 'run-1',
      employeeId: 'emp-1',
      userId: 'user-1',
    })

    expect(isValidPayslipTokenFormat(token)).toBe(true)
    expect(conflictTarget).toBe('salary_run_id,employee_id')
    const row = upserted as unknown as Record<string, unknown>
    expect(row).not.toBeNull()
    expect(row.token_hash).toBe(hashPayslipToken(token))
    expect(row.revoked_at).toBeNull()
    expect(new Date(row.expires_at as string).getTime()).toBeGreaterThan(Date.now())
    // The raw token must never be part of the persisted row
    expect(Object.values(row)).not.toContain(token)
  })

  it('throws when the upsert fails', async () => {
    const client = {
      from: () => ({ upsert: async () => ({ error: { message: 'boom' } }) }),
    } as unknown as SupabaseClient

    await expect(
      rotateLinkForEmployee(client, {
        companyId: 'c',
        salaryRunId: 'r',
        employeeId: 'e',
        userId: 'u',
      }),
    ).rejects.toThrow('boom')
  })
})

describe('revokeLinksForRun', () => {
  it('stamps revoked_at only on live links for the run', async () => {
    const calls: Array<{ update: Record<string, unknown>; eq: unknown[]; is: unknown[] }> = []
    const client = {
      from: () => ({
        update: (u: Record<string, unknown>) => ({
          eq: (...eqArgs: unknown[]) => ({
            is: async (...isArgs: unknown[]) => {
              calls.push({ update: u, eq: eqArgs, is: isArgs })
              return { data: null, error: null }
            },
          }),
        }),
      }),
    } as unknown as SupabaseClient

    await revokeLinksForRun(client, 'run-1')
    expect(calls).toHaveLength(1)
    expect(calls[0].update.revoked_at).toBeTruthy()
    expect(calls[0].eq).toEqual(['salary_run_id', 'run-1'])
    expect(calls[0].is).toEqual(['revoked_at', null])
  })
})
