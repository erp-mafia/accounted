import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { findOpenPaymentsSibling, openPaymentsSiblingMessage } from '../open-payments-sibling'

function supabaseReturning(result: { data?: unknown; error?: unknown }) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in']) {
    chain[m] = vi.fn((...args: unknown[]) => {
      calls.push({ method: m, args })
      return chain
    })
  }
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: result.data ?? null, error: result.error ?? null })
  const from = vi.fn(() => chain)
  return { client: { from } as unknown as SupabaseClient, from, calls }
}

describe('findOpenPaymentsSibling', () => {
  it('finds the Open Payments connection to the bank Enable Banking names differently', async () => {
    const db = supabaseReturning({ data: [{ id: 'op-1', bank_name: 'Länsförsäkringar' }] })
    const sibling = await findOpenPaymentsSibling(db.client, 'company-1', 'Länsförsäkringar Bank')
    expect(sibling).toEqual({ id: 'op-1', bank_name: 'Länsförsäkringar' })
  })

  it('reads only this company Open Payments rows in a live state, a failed sync included', async () => {
    const db = supabaseReturning({ data: [] })
    await findOpenPaymentsSibling(db.client, 'company-1', 'Swedbank')
    expect(db.from).toHaveBeenCalledWith('bank_connections')
    expect(db.calls).toContainEqual({ method: 'eq', args: ['company_id', 'company-1'] })
    expect(db.calls).toContainEqual({ method: 'eq', args: ['aggregator', 'open_payments'] })
    expect(db.calls).toContainEqual({ method: 'in', args: ['status', ['active', 'pending_selection', 'expired', 'error']] })
  })

  it('is null for another bank', async () => {
    const db = supabaseReturning({ data: [{ id: 'op-1', bank_name: 'Länsförsäkringar' }] })
    expect(await findOpenPaymentsSibling(db.client, 'company-1', 'Handelsbanken')).toBeNull()
  })

  it('never counts a bank Open Payments does not reach, and does not ask the database for it', async () => {
    const db = supabaseReturning({ data: [{ id: 'op-1', bank_name: 'Nordea' }] })
    expect(await findOpenPaymentsSibling(db.client, 'company-1', 'Nordea First Card')).toBeNull()
    expect(db.from).not.toHaveBeenCalled()
  })

  it('skips a row without a bank name', async () => {
    const db = supabaseReturning({ data: [{ id: 'op-1', bank_name: null }] })
    expect(await findOpenPaymentsSibling(db.client, 'company-1', 'SEB')).toBeNull()
  })

  it('throws a read error rather than letting the login start', async () => {
    const db = supabaseReturning({ error: { message: 'boom' } })
    await expect(findOpenPaymentsSibling(db.client, 'company-1', 'SEB')).rejects.toEqual({ message: 'boom' })
  })
})

describe('openPaymentsSiblingMessage', () => {
  it('names the bank and the way out', () => {
    const text = openPaymentsSiblingMessage({ id: 'op-1', bank_name: 'Länsförsäkringar' })
    expect(text).toContain('Länsförsäkringar')
    expect(text).toContain('Koppla bort')
  })
})
