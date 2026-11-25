import { describe, it, expect, vi } from 'vitest'
import { creditMirrorsIssueOre, fetchIssueReceivableSek, issueBookedOre } from '../ledger-carried-sek'

/**
 * What an invoice's own issue verifikat put on 151x, and the öresavrundning
 * that tells (crm#2283): invoice_issue_receivable_sek read in batches,
 * compared with the customer's share at issue by bookedOreRounding.
 */

describe('issueBookedOre', () => {
  it('reads the öre an issue booked: 999,75 on 1 000 is -0,25, 1 000,40 on 1 000 is 0,40', () => {
    expect(issueBookedOre({ currency: 'SEK', total: 999.75 }, 1000)).toBe(-0.25)
    expect(issueBookedOre({ currency: 'SEK', total: 1000.4 }, 1000)).toBe(0.4)
  })

  it('a kreditfaktura reads the other way round', () => {
    expect(issueBookedOre({ currency: 'SEK', total: -999.75 }, -1000)).toBe(0.25)
  })

  it('compares the customer share at issue: the total less a ROT/RUT deduction', () => {
    expect(issueBookedOre({ currency: 'SEK', total: 837.5, deduction_total: 418 }, 420)).toBe(-0.5)
  })

  it('is zero for an exact issue, a gap of a krona or more, a foreign invoice and no issue verifikat', () => {
    expect(issueBookedOre({ currency: 'SEK', total: 999.75 }, 999.75)).toBe(0)
    expect(issueBookedOre({ currency: 'SEK', total: 999.75 }, 2000)).toBe(0)
    expect(issueBookedOre({ currency: 'EUR', total: 99.75 }, 100)).toBe(0)
    expect(issueBookedOre({ currency: 'SEK', total: 999.75 }, undefined)).toBe(0)
  })

  it('reads numeric columns that arrive as strings', () => {
    expect(issueBookedOre({ currency: 'SEK', total: '999.75', deduction_total: null }, 1000)).toBe(-0.25)
  })
})

describe('fetchIssueReceivableSek', () => {
  function rpcClient(answer: (ids: string[]) => Array<{ invoice_id: string; sek: number | string }>, error: unknown = null) {
    const rpc = vi.fn(async (_name: string, args: { p_invoice_ids: string[] }) => ({
      data: error ? null : answer(args.p_invoice_ids),
      error,
    }))
    return { supabase: { rpc } as never, rpc }
  }

  it('reads nothing for no ids', async () => {
    const { supabase, rpc } = rpcClient(() => [])
    expect((await fetchIssueReceivableSek(supabase, 'company-1', [])).size).toBe(0)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('reads the ids in batches, each once, and keys the öre-rounded figure by invoice', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `inv-${i}`)
    const { supabase, rpc } = rpcClient((batch) => batch.map((id) => ({ invoice_id: id, sek: '1000.00' })))

    const out = await fetchIssueReceivableSek(supabase, 'company-1', [...ids, 'inv-0'])

    expect(rpc).toHaveBeenCalledTimes(3)
    expect(rpc.mock.calls[0]).toEqual(['invoice_issue_receivable_sek', { p_company_id: 'company-1', p_invoice_ids: ids.slice(0, 200) }])
    expect(out.size).toBe(450)
    expect(out.get('inv-449')).toBe(1000)
  })

  it('throws on a read error', async () => {
    const { supabase } = rpcClient(() => [], { message: 'boom', code: '57014' })
    await expect(fetchIssueReceivableSek(supabase, 'company-1', ['inv-1'])).rejects.toThrow()
  })
})

describe('creditMirrorsIssueOre', () => {
  /** The function's one row for the original: its figure and its own facts. */
  function client(original: Record<string, unknown> | null, issueSek: number | null) {
    const rpc = vi.fn(async () => ({
      data: original && issueSek != null ? [{ invoice_id: 'inv-1', sek: issueSek, ...original }] : [],
      error: null,
    }))
    return { supabase: { rpc } as never, rpc }
  }
  const original = { currency: 'SEK', total: 999.75, deduction_total: 0 }

  it('mirrors when the original issue booked its öre, in one read', async () => {
    const { supabase, rpc } = client(original, 1000)
    expect(await creditMirrorsIssueOre(supabase, 'company-1', 'inv-1')).toBe(true)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('invoice_issue_receivable_sek', { p_company_id: 'company-1', p_invoice_ids: ['inv-1'] })
  })

  it('does not mirror an exact issue, a missing issue verifikat or a foreign original', async () => {
    expect(await creditMirrorsIssueOre(client(original, 999.75).supabase, 'company-1', 'inv-1')).toBe(false)
    expect(await creditMirrorsIssueOre(client(original, null).supabase, 'company-1', 'inv-1')).toBe(false)
    expect(await creditMirrorsIssueOre(client({ ...original, currency: 'EUR' }, 1000).supabase, 'company-1', 'inv-1')).toBe(false)
  })

  it('reads the deduction from the row: a ROT original issued at its rounded customer share', async () => {
    expect(await creditMirrorsIssueOre(client({ currency: 'SEK', total: 837.5, deduction_total: 418 }, 420).supabase, 'company-1', 'inv-1')).toBe(true)
  })
})
