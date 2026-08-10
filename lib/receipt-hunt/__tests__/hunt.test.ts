/**
 * huntCompany's read/write shell. The ranking is covered in select.test.ts;
 * what matters here is that a dry run cannot write, and that a real run stages
 * exactly one operation per proposal with the shape the approval card reads.
 */
import { describe, it, expect, vi } from 'vitest'
import { huntCompany } from '../hunt'

type Row = Record<string, unknown>

/**
 * Minimal PostgREST stand-in: every builder method returns the chain, and
 * awaiting it yields whatever the table was seeded with. `range` is honoured so
 * fetchAllRows terminates.
 */
function mockSupabase(tables: Record<string, Row[]>, onInsert?: (t: string, rows: Row[]) => void) {
  const inserts: Array<{ table: string; rows: Row[] }> = []
  const client = {
    from(table: string) {
      let from = 0
      let to = Number.MAX_SAFE_INTEGER
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'is', 'not', 'in', 'lte', 'gte', 'order', 'limit']) {
        chain[m] = vi.fn(() => chain)
      }
      chain.range = vi.fn((f: number, t: number) => {
        from = f
        to = t
        return chain
      })
      chain.insert = vi.fn((rows: Row[]) => {
        inserts.push({ table, rows })
        onInsert?.(table, rows)
        return Promise.resolve({ error: null })
      })
      chain.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: (tables[table] ?? []).slice(from, to + 1), error: null }).then(resolve)
      return chain
    },
  }
  return { client: client as never, inserts }
}

const TX = {
  id: 'tx-1',
  company_id: 'co-1',
  date: '2026-05-02',
  description: 'CIRCLE K 421',
  merchant_name: 'Circle K',
  amount: -438.75,
  currency: 'SEK',
  amount_sek: -438.75,
  exchange_rate: null,
}

const ITEM = {
  id: 'item-1',
  document_id: 'doc-1',
  extracted_data: {
    supplier: { name: 'Circle K' },
    invoice: { invoiceDate: '2026-05-02', currency: 'SEK' },
    totals: { total: 438.75, vatAmount: 87.75 },
  },
  channel_context: null,
}

function fixture() {
  return {
    transactions: [TX],
    invoice_inbox_items: [ITEM],
    document_attachments: [{ id: 'doc-1', file_name: 'circlek.pdf' }],
    pending_operations: [],
    company_members: [{ user_id: 'user-1', role: 'owner' }],
  }
}

describe('huntCompany', () => {
  it('writes nothing on a dry run but returns what it would have staged', async () => {
    const { client, inserts } = mockSupabase(fixture(), () => {
      throw new Error('dry run must not write')
    })

    const result = await huntCompany(client, 'co-1', 'run-1', { dryRun: true })

    expect(inserts).toHaveLength(0)
    expect(result.proposed).toBe(1)
    expect(result.proposals?.[0]).toMatchObject({ transaction_id: 'tx-1', document_id: 'doc-1' })
  })

  it('stages one operation per proposal, shaped for the approval card', async () => {
    const { client, inserts } = mockSupabase(fixture())

    const result = await huntCompany(client, 'co-1', 'run-1')

    expect(result.proposed).toBe(1)
    expect(inserts).toHaveLength(1)
    const [row] = inserts[0].rows as Array<Record<string, Record<string, unknown>>>
    expect(inserts[0].table).toBe('pending_operations')
    expect(row.operation_type).toBe('attach_document_to_transaction')
    // The executor reads exactly these two params and nothing else.
    expect(row.params).toEqual({ transaction_id: 'tx-1', document_id: 'doc-1' })
    // AttachDocumentPreview treats an absent flag as potentially destructive,
    // so it has to be present and false or the card warns about an overwrite
    // that cannot happen (these transactions have no document).
    expect(row.preview_data.existing_document_is_rakenskapsinformation).toBe(false)
    expect(row.preview_data.will_overwrite_existing).toBe(false)
    expect(row.agent_metadata.run_id).toBe('run-1')
    expect(row.actor_type).toBe('cron')
  })

  it('does not stage when the company has no members to ask', async () => {
    const tables = { ...fixture(), company_members: [] }
    const { client, inserts } = mockSupabase(tables)

    const result = await huntCompany(client, 'co-1', 'run-1')

    expect(result.skippedNoOwner).toBe(true)
    expect(result.proposed).toBe(0)
    expect(inserts).toHaveLength(0)
  })

  it('ignores a receipt whose document is already anchored to a verifikat', async () => {
    // document_attachments is filtered on journal_entry_id IS NULL by the
    // query, so an anchored doc simply is not in the attachable set.
    const tables = { ...fixture(), document_attachments: [] }
    const { client, inserts } = mockSupabase(tables)

    const result = await huntCompany(client, 'co-1', 'run-1')

    expect(result.poolSize).toBe(0)
    expect(result.proposed).toBe(0)
    expect(inserts).toHaveLength(0)
  })
})
