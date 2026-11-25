import { describe, it, expect, vi } from 'vitest'
import { creditMirrorsIssueOre, fetchIssueBookedOre, issueBookedOre } from '../ledger-carried-sek'

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

describe('fetchIssueBookedOre', () => {
  function rpcClient(answer: (ids: string[]) => Array<Record<string, unknown>>, error: unknown = null) {
    const rpc = vi.fn(async (_name: string, args: { p_invoice_ids: string[] }) => ({
      data: error ? null : answer(args.p_invoice_ids),
      error,
    }))
    return { supabase: { rpc } as never, rpc }
  }
  const row = (id: string, sek: number | string, total = 999.75) => ({ invoice_id: id, sek, currency: 'SEK', total, deduction_total: null })

  it('reads nothing for no ids', async () => {
    const { supabase, rpc } = rpcClient(() => [])
    expect((await fetchIssueBookedOre(supabase, 'company-1', [])).size).toBe(0)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('keys the öre each issue booked, leaving out issues that booked none', async () => {
    const { supabase } = rpcClient(() => [row('inv-1', '1000.00'), row('inv-2', 999.75), row('inv-3', 1000, 1000.4)])

    const out = await fetchIssueBookedOre(supabase, 'company-1', ['inv-1', 'inv-2', 'inv-3'])

    expect([...out]).toEqual([['inv-1', -0.25], ['inv-3', 0.4]])
  })

  it('reads the ids in batches of 200, each id once', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `inv-${i}`)
    const { supabase, rpc } = rpcClient((batch) => batch.map((id) => row(id, 1000)))

    const out = await fetchIssueBookedOre(supabase, 'company-1', [...ids, 'inv-0'])

    expect(rpc).toHaveBeenCalledTimes(3)
    expect(rpc.mock.calls[0]).toEqual(['invoice_issue_receivable_sek', { p_company_id: 'company-1', p_invoice_ids: ids.slice(0, 200) }])
    expect(out.size).toBe(450)
  })

  it('throws on a read error', async () => {
    const { supabase } = rpcClient(() => [], { message: 'boom', code: '57014' })
    await expect(fetchIssueBookedOre(supabase, 'company-1', ['inv-1'])).rejects.toThrow()
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
  const credit = { credited_invoice_id: 'inv-1', currency: 'SEK', total: -999.75 }

  it('mirrors when the original issue booked its öre, in one read', async () => {
    const { supabase, rpc } = client(original, 1000)
    expect(await creditMirrorsIssueOre(supabase, 'company-1', credit)).toBe(true)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('invoice_issue_receivable_sek', { p_company_id: 'company-1', p_invoice_ids: ['inv-1'] })
  })

  it('does not mirror an exact issue, a missing issue verifikat or a foreign original', async () => {
    expect(await creditMirrorsIssueOre(client(original, 999.75).supabase, 'company-1', credit)).toBe(false)
    expect(await creditMirrorsIssueOre(client(original, null).supabase, 'company-1', credit)).toBe(false)
    expect(await creditMirrorsIssueOre(client({ ...original, currency: 'EUR' }, 1000).supabase, 'company-1', credit)).toBe(false)
  })

  it('a credit without an original, or without öre in its total, costs no read', async () => {
    const { supabase, rpc } = client(original, 1000)
    expect(await creditMirrorsIssueOre(supabase, 'company-1', { ...credit, credited_invoice_id: null })).toBe(false)
    expect(await creditMirrorsIssueOre(supabase, 'company-1', { ...credit, total: -1000 })).toBe(false)
    expect(await creditMirrorsIssueOre(supabase, 'company-1', { ...credit, currency: 'EUR' })).toBe(false)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('reads the deduction from the row: a ROT original issued at its rounded customer share', async () => {
    const rot = client({ currency: 'SEK', total: 837.5, deduction_total: 418 }, 420)
    expect(await creditMirrorsIssueOre(rot.supabase, 'company-1', { ...credit, total: -837.5 })).toBe(true)
  })
})
