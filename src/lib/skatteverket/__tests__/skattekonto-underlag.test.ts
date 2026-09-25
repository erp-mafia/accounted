import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DocumentUploadSource } from '@/types'

const { uploadDocument } = vi.hoisted(() => ({ uploadDocument: vi.fn() }))
vi.mock('@/lib/core/documents/document-service', () => ({ uploadDocument }))

import {
  archiveLinkedSkattekontoUnderlag,
  buildSkattekontoUnderlagModel,
  skattekontoUnderlagFilename,
} from '../skattekonto-underlag'

const companyId = '31eb7268-8d2a-4bdc-a79a-a257888fd5fa'
const entryId = 'a109544f-3443-46c9-8e47-b79276df7ec1'
const rowId = 'e8a70936-b2c9-480d-a8a3-53a6c7f2919d'
const periodId = 'ddc19df7-2292-4dfa-9270-8c993695b40b'

const row = {
  id: rowId,
  journal_entry_id: entryId,
  transaktionsidentitet: 12345,
  transaktionsdatum: '2026-09-05',
  transaktionstext: 'Kostnadsränta',
  belopp_skatteverket: -43,
  imported_at: '2026-09-06T08:00:00Z',
}
const entry = {
  id: entryId, status: 'posted', voucher_series: 'A', voucher_number: 51,
  fiscal_period_id: periodId,
}
const period = { id: periodId, is_closed: false, locked_at: null as string | null }

/** Project selected columns so provenance tests also cover the document query contract. */
function makeSupabase(options: {
  rows?: typeof row[]
  entries?: typeof entry[]
  periods?: typeof period[]
  documents?: Array<{ journal_entry_id: string; file_name: string; upload_source: DocumentUploadSource | null }>
} = {}) {
  const tables: Record<string, Record<string, unknown>[]> = {
    skattekonto_transactions: options.rows ?? [row],
    journal_entries: options.entries ?? [entry],
    fiscal_periods: options.periods ?? [period],
    document_attachments: options.documents ?? [],
    company_settings: [{ company_id: companyId, company_name: 'Aemulus Sverige AB', org_number: '5590154851' }],
  }
  const queries: Array<{ table: string; filters: Array<[string, unknown]> }> = []
  const supabase = {
    from(table: string) {
      const filters: Array<[string, unknown]> = []
      queries.push({ table, filters })
      let records = [...(tables[table] ?? [])]
      const builder = {
        select(columns: string) {
          const selected = columns.split(',').map(column => column.trim())
          records = records.map(record => Object.fromEntries(selected.map(column => [column, record[column]])))
          return builder
        },
        eq(column: string, value: unknown) {
          filters.push([column, value])
          // Fixtures omit columns that the service selects only as filters.
          records = records.filter(record => !(column in record) || record[column] === value)
          return builder
        },
        not() { return builder },
        in(column: string, values: unknown[]) {
          records = records.filter(record => values.includes(record[column]))
          return builder
        },
        order() { return builder },
        range(from: number, to: number) {
          return Promise.resolve({ data: records.slice(from, to + 1), error: null })
        },
        maybeSingle() {
          return Promise.resolve({ data: records[0] ?? null, error: null })
        },
        then(resolve: (result: { data: Record<string, unknown>[]; error: null }) => void) {
          resolve({ data: records.slice(0, 1000), error: null })
        },
      }
      return builder
    },
  }
  return { supabase: supabase as unknown as SupabaseClient, queries }
}

beforeEach(() => {
  uploadDocument.mockReset()
  uploadDocument.mockResolvedValue({ id: 'archived-document' })
})

describe('skattekonto underlag', () => {
  it('identifies a negative SKV amount and the numbered voucher', () => {
    const model = buildSkattekontoUnderlagModel(
      row, entry,
      { company_name: 'Aemulus Sverige AB', org_number: '5590154851' },
    )
    expect(model).toMatchObject({
      voucher: 'A51', amount: -43, transactionIdentity: 12345,
      companyName: 'Aemulus Sverige AB',
    })
  })

  it('archives an API snapshot on a posted voucher', async () => {
    const { supabase, queries } = makeSupabase()
    const result = await archiveLinkedSkattekontoUnderlag(supabase, companyId, 'user-1')

    expect(result).toEqual({ archived: 1, failed: 0 })
    expect(queries[0].filters).toContainEqual(['company_id', companyId])
    expect(queries[0].filters).toContainEqual(['source', 'api'])
    expect(uploadDocument).toHaveBeenCalledWith(
      supabase, 'user-1', companyId,
      expect.objectContaining({
        name: skattekontoUnderlagFilename(rowId, entryId),
        type: 'application/pdf',
      }),
      expect.objectContaining({
        upload_source: 'system', journal_entry_id: entryId, extractionOwner: 'none',
        idempotency_key: `skattekonto-underlag:${rowId}:${entryId}`,
      }),
    )
    const file = uploadDocument.mock.calls[0][3]
    expect(new TextDecoder().decode(new Uint8Array(file.buffer).slice(0, 4))).toBe('%PDF')
  })

  it('does not replace an existing user-supplied underlag', async () => {
    const { supabase } = makeSupabase({
      documents: [{ journal_entry_id: entryId, file_name: 'SKV-kontoutdrag.pdf', upload_source: 'file_upload' }],
    })
    expect(await archiveLinkedSkattekontoUnderlag(supabase, companyId, 'user-1'))
      .toEqual({ archived: 0, failed: 0 })
    expect(uploadDocument).not.toHaveBeenCalled()
  })

  it.each(['file_upload', 'api', null] as const)(
    'preserves a document with a generated-looking filename from source %s', async uploadSource => {
      const { supabase } = makeSupabase({
        documents: [{
          journal_entry_id: entryId, file_name: 'Skattekonto_API_user-statement.pdf',
          upload_source: uploadSource,
        }],
      })
      expect(await archiveLinkedSkattekontoUnderlag(supabase, companyId, 'user-1'))
        .toEqual({ archived: 0, failed: 0 })
      expect(uploadDocument).not.toHaveBeenCalled()
    },
  )

  it('allows a missing snapshot alongside an unrelated system-generated document', async () => {
    const { supabase } = makeSupabase({
      documents: [{ journal_entry_id: entryId, file_name: 'system-summary.pdf', upload_source: 'system' }],
    })
    expect(await archiveLinkedSkattekontoUnderlag(supabase, companyId, 'user-1'))
      .toEqual({ archived: 1, failed: 0 })
    expect(uploadDocument).toHaveBeenCalledTimes(1)
  })

  it.each(['user', 'generated'] as const)('reads beyond 1000 documents before checking %s underlag', async type => {
    const documents = Array.from({ length: 1000 }, (_, index) => ({
      journal_entry_id: entryId, file_name: `system-${index}.pdf`, upload_source: 'system' as const,
    }))
    const { supabase } = makeSupabase({ documents: [...documents, {
      journal_entry_id: entryId,
      file_name: type === 'user' ? 'user-statement.pdf' : skattekontoUnderlagFilename(rowId, entryId),
      upload_source: type === 'user' ? 'file_upload' : 'system',
    }] })
    expect(await archiveLinkedSkattekontoUnderlag(supabase, companyId, 'user-1'))
      .toEqual({ archived: 0, failed: 0 })
    expect(uploadDocument).not.toHaveBeenCalled()
  })

  it('does not duplicate a previously generated document', async () => {
    const { supabase } = makeSupabase({
      documents: [{ journal_entry_id: entryId, file_name: skattekontoUnderlagFilename(rowId, entryId), upload_source: 'system' }],
    })
    expect(await archiveLinkedSkattekontoUnderlag(supabase, companyId, 'user-1'))
      .toEqual({ archived: 0, failed: 0 })
    expect(uploadDocument).not.toHaveBeenCalled()
  })

  it('adds the remaining API row when a multi-row voucher has one generated file', async () => {
    const secondRow = {
      ...row,
      id: 'af40f289-227c-4751-8fb1-5e59ee9e08a6',
      transaktionsidentitet: 12346,
      belopp_skatteverket: 43,
    }
    const { supabase } = makeSupabase({
      rows: [row, secondRow],
      documents: [{ journal_entry_id: entryId, file_name: skattekontoUnderlagFilename(rowId, entryId), upload_source: 'system' }],
    })
    expect(await archiveLinkedSkattekontoUnderlag(supabase, companyId, 'user-1'))
      .toEqual({ archived: 1, failed: 0 })
    expect(uploadDocument.mock.calls[0][3].name)
      .toBe(skattekontoUnderlagFilename(secondRow.id, entryId))
  })

  it('does not attach to a locked fiscal period', async () => {
    const { supabase } = makeSupabase({
      periods: [{ ...period, locked_at: '2026-09-20T00:00:00Z' }],
    })
    expect(await archiveLinkedSkattekontoUnderlag(supabase, companyId, 'user-1'))
      .toEqual({ archived: 0, failed: 0 })
    expect(uploadDocument).not.toHaveBeenCalled()
  })

  it('leaves failed archives retryable', async () => {
    uploadDocument.mockRejectedValueOnce(new Error('Storage unavailable'))
    const { supabase } = makeSupabase()
    expect(await archiveLinkedSkattekontoUnderlag(supabase, companyId, 'user-1'))
      .toEqual({ archived: 0, failed: 1 })
    expect(await archiveLinkedSkattekontoUnderlag(supabase, companyId, 'user-1'))
      .toEqual({ archived: 1, failed: 0 })
  })

  it('renders identical bytes on retries for the same SKV data', async () => {
    const { supabase } = makeSupabase()
    await archiveLinkedSkattekontoUnderlag(supabase, companyId, 'user-1')
    await archiveLinkedSkattekontoUnderlag(supabase, companyId, 'user-1')
    const first = Buffer.from(uploadDocument.mock.calls[0][3].buffer)
    const second = Buffer.from(uploadDocument.mock.calls[1][3].buffer)
    expect(first.equals(second)).toBe(true)
  })
})
