import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { providerKeyUse, readProviderKeyUseFacts, type ProviderKeyUseFacts } from '../key-use'

/**
 * crm#1476 / PH 219: "is the Bokio key still used after the migration?" The
 * connections list answers from what still reads with the key: an unfinished
 * migration job, the invoice-row pass, the Bokio supplier completion.
 */

function facts(overrides: Partial<ProviderKeyUseFacts> = {}): ProviderKeyUseFacts {
  return {
    jobStates: ['completed'],
    importedWithoutJob: false,
    invoicesAwaitingRows: false,
    supplierCompletionConsentIds: new Set(),
    newestConsentId: 'consent-1',
    ...overrides,
  }
}

describe('providerKeyUse', () => {
  it('calls the key idle once the migration completed and nothing waits on the source', () => {
    expect(providerKeyUse('consent-1', facts())).toBe('idle')
  })

  it('keeps the key in use while a job is queued, running, retrying or awaiting review', () => {
    for (const state of ['queued', 'running', 'retry_wait', 'needs_attention']) {
      expect(providerKeyUse('consent-1', facts({ jobStates: ['completed', state] }))).toBe('migration')
    }
  })

  it('keeps the key in use before any migration finished', () => {
    expect(providerKeyUse('consent-1', facts({ jobStates: [] }))).toBe('migration')
  })

  it('treats a migration from before the job queue as finished when the ledger and records came in', () => {
    expect(providerKeyUse('consent-1', facts({ jobStates: [], importedWithoutJob: true }))).toBe('idle')
  })

  it('keeps the newest connection in use while an imported invoice waits for its rows', () => {
    const f = facts({ invoicesAwaitingRows: true, newestConsentId: 'consent-new' })
    expect(providerKeyUse('consent-new', f)).toBe('invoice_rows')
    // The row pass reads with the newest connection only.
    expect(providerKeyUse('consent-1', f)).toBe('idle')
  })

  it('keeps a connection enrolled in the Bokio supplier completion in use', () => {
    expect(providerKeyUse('consent-1', facts({ supplierCompletionConsentIds: new Set(['consent-1']) }))).toBe('supplier_rows')
  })
})

type Call = { table: string; ops: [string, ...unknown[]][] }

function service(answers: Record<string, { data: unknown[] | null; error: unknown }>) {
  const calls: Call[] = []
  const from = vi.fn((table: string) => {
    const call: Call = { table, ops: [] }
    calls.push(call)
    const chain: Record<string, unknown> = {}
    for (const op of ['select', 'eq', 'or', 'is', 'limit']) {
      chain[op] = vi.fn((...args: unknown[]) => {
        call.ops.push([op, ...args])
        return chain
      })
    }
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(answers[table] ?? { data: [], error: null }).then(resolve, reject)
    return chain
  })
  return { client: { from } as unknown as SupabaseClient, calls }
}

describe('readProviderKeyUseFacts', () => {
  const opts = { hasCompletedSieImport: true, importedRecords: 3, newestConsentId: 'consent-1' }

  it('reads the three follow-ups for this company only', async () => {
    const { client, calls } = service({
      migration_jobs: { data: [{ state: 'completed' }], error: null },
      invoices: { data: [{ id: 'inv-1', invoice_items: null }], error: null },
      bokio_supplier_completion_work: { data: [{ consent_id: 'consent-1' }, { consent_id: null }], error: null },
    })

    const result = await readProviderKeyUseFacts(client, 'company-1', opts)

    expect(result).toEqual({
      jobStates: ['completed'],
      importedWithoutJob: true,
      invoicesAwaitingRows: true,
      supplierCompletionConsentIds: new Set(['consent-1']),
      newestConsentId: 'consent-1',
    })
    for (const call of calls) expect(call.ops).toContainEqual(['eq', 'company_id', 'company-1'])
    // The invoice-row pass's candidates: invoices with no rows, empty in-app drafts left out.
    const invoices = calls.find((c) => c.table === 'invoices')!
    expect(invoices.ops).toContainEqual(['eq', 'document_type', 'invoice'])
    expect(invoices.ops).toContainEqual(['or', 'status.neq.draft,total.neq.0'])
    expect(invoices.ops).toContainEqual(['is', 'invoice_items', null])
  })

  it('needs imported records, not only a ledger, to call a job-less migration finished', async () => {
    const { client } = service({})
    const result = await readProviderKeyUseFacts(client, 'company-1', { ...opts, importedRecords: 0 })
    expect(result.importedWithoutJob).toBe(false)
    expect(result.invoicesAwaitingRows).toBe(false)
  })

  it('throws on a failed read rather than calling a key idle that may not be', async () => {
    const { client } = service({ invoices: { data: null, error: { message: 'boom' } } })
    await expect(readProviderKeyUseFacts(client, 'company-1', opts)).rejects.toThrow('PROVIDER_KEY_USE_READ_FAILED')
  })
})
