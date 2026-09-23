/**
 * Explicit opt-in smoke test against the hosted staging branch only.
 * SANDBOX_STAGING_ENV_FILE points to its credentials file. Never reads .env.local.
 */
import { readFileSync } from 'node:fs'
import { parse } from 'dotenv'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { beforeAll, describe, expect, it, vi } from 'vitest'

const context = vi.hoisted(() => ({ auth: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: context.auth }))
vi.mock('@/lib/auth/rate-limit-http', () => ({ checkRateLimit: async () => ({ ok: true }) }))

describe.skipIf(!process.env.SANDBOX_STAGING_ENV_FILE)('hosted staging sandbox', () => {
  let client: SupabaseClient
  let service: SupabaseClient
  let POST: typeof import('../route').POST
  beforeAll(async () => {
    const env = parse(readFileSync(process.env.SANDBOX_STAGING_ENV_FILE!, 'utf8'))
    if (new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname !== 'metjnjrhvujscngnpzdv.supabase.co') {
      throw new Error('Sandbox smoke test only permits the staging branch')
    }
    if (process.env.SANDBOX_STAGING_SERVICE_ROLE_KEY) {
      env.SUPABASE_SERVICE_ROLE_KEY = process.env.SANDBOX_STAGING_SERVICE_ROLE_KEY
    }
    // Load only after checking the target. Includes the real event handlers.
    Object.assign(process.env, env)
    POST = (await import('../route')).POST
    client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { error: credentialError } = await service.from('companies').select('id').limit(0)
    if (credentialError) throw new Error('A working staging service key is required for event handlers and retention verification')
    const { data, error } = await client.auth.signInAnonymously()
    if (error || !data.user) throw error ?? new Error('No anonymous staging user')
    context.auth.mockResolvedValue({ user: data.user, supabase: client, error: null })
  }, 90_000)

  it('seeds through real posting guards, links vouchers and repeats without duplicates', async () => {
    const start = Date.now()
    // These are separate concurrent PostgREST transactions, not an in-memory lock.
    const claims = await Promise.all([client.rpc('claim_sandbox_seed'), client.rpc('claim_sandbox_seed')])
    expect(claims.every(claim => !claim.error)).toBe(true)
    expect(claims.map(claim => claim.data.status).sort()).toEqual(['busy', 'running'])
    const owner = claims.find(claim => claim.data.status === 'running')!.data
    await client.rpc('finish_sandbox_seed', { p_attempt_id: owner.attempt_id, p_success: false })

    // Simulate an interruption AFTER real vouchers committed, before payroll.
    const { data: { user: signedIn } } = await client.auth.getUser()
    const failingClient = new Proxy(client, {
      get(target, property) {
        if (property === 'from') return (table: string) => {
          if (table === 'salary_runs') return {
            insert: () => ({ select: async () => ({ data: null, error: { message: 'Injected payroll interruption' } }) }),
          }
          return target.from(table)
        }
        return Reflect.get(target, property)
      },
    })
    context.auth.mockResolvedValueOnce({ user: signedIn, supabase: failingClient, error: null })
    expect((await POST(new Request('http://localhost/api/sandbox/seed', { method: 'POST' }))).status).toBe(500)
    const { data: failed } = await client.from('sandbox_seed_attempts').select('*').single()
    expect(failed.status).toBe('failed')
    const { count: preservedCount } = await client.from('journal_entries').select('id', { head: true, count: 'exact' })
      .eq('company_id', failed.company_id).eq('status', 'posted')
    expect(preservedCount).toBeGreaterThan(0)

    const first = await POST(new Request('http://localhost/api/sandbox/seed', { method: 'POST' }))
    expect(await first.json()).toEqual({ seeded: true })
    expect(first.status).toBe(200)
    const { data: attempt, error } = await client.from('sandbox_seed_attempts').select('*').single()
    expect(error).toBeNull()
    expect(attempt.status).toBe('complete')
    expect(attempt.company_id).not.toBe(failed.company_id)
    const { data: archived } = await service.from('companies').select('archived_at').eq('id', failed.company_id).single()
    expect(archived!.archived_at).toBeTruthy()
    const { count: retainedCount } = await service.from('journal_entries').select('id', { head: true, count: 'exact' })
      .eq('company_id', failed.company_id).eq('status', 'posted')
    expect(retainedCount).toBe(preservedCount)
    const { data: entries, error: entriesError } = await client.from('journal_entries')
      .select('id, fiscal_period_id, status, committed_at, voucher_number, voucher_series, lines:journal_entry_lines(debit_amount,credit_amount)')
      .eq('company_id', attempt.company_id)
    expect(entriesError).toBeNull()
    expect(entries!.length).toBeGreaterThanOrEqual(5)
    const { data: { user } } = await client.auth.getUser()
    const { error: invalidDraft } = await client.from('journal_entries').insert({
      user_id: user!.id, company_id: attempt.company_id,
      fiscal_period_id: entries![0].fiscal_period_id, voucher_number: 0,
      entry_date: new Date().toISOString().slice(0, 10), description: 'Rejected test draft',
      source_type: 'manual', status: 'draft', committed_at: new Date().toISOString(),
    })
    expect(invalidDraft?.code).toBe('42501')
    for (const entry of entries!) {
      expect(entry.status).toBe('posted')
      expect(entry.committed_at).toBeTruthy()
      expect(entry.voucher_number).toBeGreaterThan(0)
      expect(Math.round(entry.lines.reduce((sum, line) => sum + line.debit_amount - line.credit_amount, 0) * 100)).toBe(0)
    }
    const { data: runs } = await client.from('salary_runs').select('salary_entry_id,avgifter_entry_id,vacation_entry_id')
      .eq('company_id', attempt.company_id).eq('status', 'booked')
    expect(runs).toHaveLength(1)
    expect(Object.values(runs![0]).every(id => entries!.some(entry => entry.id === id))).toBe(true)
    const { data: invoice } = await client.from('invoices').select('journal_entry_id')
      .eq('company_id', attempt.company_id).eq('invoice_number', 'F-2026001').single()
    expect(entries!.some(entry => entry.id === invoice!.journal_entry_id)).toBe(true)
    const second = await POST(new Request('http://localhost/api/sandbox/seed', { method: 'POST' }))
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ seeded: false, topped_up: true })
    const { count } = await client.from('journal_entries').select('id', { count: 'exact', head: true })
      .eq('company_id', attempt.company_id)
    expect(count).toBe(entries!.length)
    // A complete pre-migration demo has no attempt row. Adopt it without reseeding.
    const { error: removeMarker } = await service.from('sandbox_seed_attempts').delete().eq('user_id', user!.id)
    expect(removeMarker).toBeNull()
    const legacy = await POST(new Request('http://localhost/api/sandbox/seed', { method: 'POST' }))
    expect(await legacy.json()).toEqual({ seeded: false, topped_up: true })
    const { data: adopted } = await client.from('sandbox_seed_attempts').select('company_id,status').single()
    expect(adopted).toMatchObject({ company_id: attempt.company_id, status: 'complete' })
    expect(Date.now() - start).toBeLessThan(300_000)
  }, 300_000)
})
