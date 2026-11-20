/**
 * gnubok_set_document_type (operation documents.set-type), crm#2016: an agent
 * that uploaded board and general meeting minutes found no tool to give an
 * archived document its type, so the person retyped each one in Dokument. The
 * tool is generated from the operation, stages set_document_type, and
 * approval runs the service Dokument's "Ändra typ" runs
 * (lib/documents/classify/set-type.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/documents/classify/set-type', () => ({ setDocumentTypeByPerson: vi.fn() }))

import { setDocumentTypeByPerson } from '@/lib/documents/classify/set-type'
import { DOC_TYPES } from '@/lib/documents/classify/taxonomy'
import { operationForPendingType } from '@/lib/operations/registry'
import { documentsSetType } from '@/lib/operations/documents'
import { OPERATION_RISK_TIERS } from '@/lib/pending-operations/risk-tiers'
import { TOOL_SCOPE_MAP } from '@/lib/auth/scope-catalog'
import { createLogger } from '@/lib/logger'
import { tools } from '../server'

const DOC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const ACTOR = { type: 'api_key', id: 'key-1' } as const
const STORED = { id: DOC, file_name: 'styrelseprotokoll-2026-05.pdf', doc_type: null }

const setDocumentType = tools.find((t) => t.name === 'gnubok_set_document_type')!

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_set_document_type', () => {
  it('is a search-only staging tool gated by documents:write, at low risk', () => {
    expect(setDocumentType).toBeDefined()
    expect(setDocumentType.catalogVisibility).toBe('search')
    expect(TOOL_SCOPE_MAP.gnubok_set_document_type).toBe('documents:write')
    expect(setDocumentType.description).toMatch(/^Stage /)
    expect(setDocumentType.description.length).toBeLessThanOrEqual(280)
    expect(OPERATION_RISK_TIERS.set_document_type).toBe('low')
  })

  it('is the first hit for the search the reporting agent made, reachable through the stage bridge', async () => {
    const search = tools.find((t) => t.name === 'gnubok_search_tools')!
    const result = (await search.execute(
      { query: 'document type dokumenttyp', __keyScopes: ['documents:write', 'transactions:write'] },
      'company-1', 'user-1', {} as never, ACTOR,
    )) as { tools: Array<{ name: string; callable_via?: string }> }

    expect(result.tools[0]).toMatchObject({ name: 'gnubok_set_document_type', callable_via: 'stage_tool' })
  })

  it('takes the document and one of the types Dokument offers, the same list', () => {
    const schema = setDocumentType.inputSchema as {
      properties: Record<string, { enum?: readonly string[] }>
      required?: string[]
      additionalProperties?: boolean
    }
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required).toEqual(['document_id', 'doc_type'])
    expect(schema.properties.doc_type.enum).toEqual([...DOC_TYPES])
    expect(schema.properties.doc_type.enum).toEqual(expect.arrayContaining(['minutes.board', 'minutes.agm']))
  })

  it('refuses a type outside the list before anything is read or staged', async () => {
    const { supabase, findCall } = createQueuedMockSupabase()

    await expect(
      setDocumentType.execute({ document_id: DOC, doc_type: 'aktiebok' }, 'company-1', 'user-1', supabase as never, ACTOR),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(findCall('document_attachments', 'select')).toBeUndefined()
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('refuses a document the company does not hold at staging, looked up in that company only', async () => {
    const { supabase, enqueue, findCall, findCalls } = createQueuedMockSupabase()
    enqueue({ data: null })

    await expect(
      setDocumentType.execute({ document_id: DOC, doc_type: 'minutes.board' }, 'company-1', 'user-1', supabase as never, ACTOR),
    ).rejects.toMatchObject({ code: 'DOC_NOT_FOUND' })
    expect(findCalls('document_attachments', 'eq')).toEqual(expect.arrayContaining([['id', DOC], ['company_id', 'company-1']]))
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('dry run previews both types by their names in Dokument and stages nothing', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: STORED })

    const result = (await setDocumentType.execute(
      { document_id: DOC, doc_type: 'minutes.board', dry_run: true },
      'company-1', 'user-1', supabase as never, ACTOR,
    )) as { staged: boolean; dry_run: boolean; risk_level: string; preview: Record<string, unknown> }

    expect(result.staged).toBe(false)
    expect(result.dry_run).toBe(true)
    expect(result.risk_level).toBe('low')
    expect(result.preview).toMatchObject({
      file_name: STORED.file_name,
      current_type: 'Utan typ',
      new_type: 'Styrelseprotokoll',
      doc_type_before: null,
      doc_type: 'minutes.board',
    })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
    expect(setDocumentTypeByPerson).not.toHaveBeenCalled()
  })

  it('stages set_document_type, types nothing itself, with params the commit validates back', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: STORED })
    enqueue({ data: { id: 'op-1' } })

    const result = (await setDocumentType.execute(
      { document_id: DOC, doc_type: 'minutes.agm' },
      'company-1', 'user-1', supabase as never, ACTOR,
    )) as { staged: boolean }

    expect(result.staged).toBe(true)
    expect(setDocumentTypeByPerson).not.toHaveBeenCalled()
    expect(findCall('document_attachments', 'update')).toBeUndefined()
    const insert = findCall('pending_operations', 'insert')?.[0] as { operation_type: string; title: string; params: Record<string, unknown> }
    expect(insert.operation_type).toBe('set_document_type')
    expect(insert.title).toBe('Ändra dokumenttyp: styrelseprotokoll-2026-05.pdf (Stämmoprotokoll)')
    expect(insert.params).toEqual({ document_id: DOC, doc_type: 'minutes.agm' })
    expect(operationForPendingType('set_document_type')).toBe(documentsSetType)
    expect(documentsSetType.input.parse(insert.params)).toEqual(insert.params)
  })

  describe('approval (documents.set-type run)', () => {
    const ctx = (supabase: unknown) => ({ supabase: supabase as never, companyId: 'company-1', userId: 'approver-1', log: createLogger('test') })

    it('runs the service Dokument runs, as the approving person, and answers the type it replaced', async () => {
      vi.mocked(setDocumentTypeByPerson).mockResolvedValue({ status: 'set', documentId: DOC, docType: 'minutes.board', previousDocType: 'other', withdrawnAgreementId: null })
      const supabase = {}

      const out = await documentsSetType.run(ctx(supabase), { document_id: DOC, doc_type: 'minutes.board' }, { dryRun: false })

      expect(setDocumentTypeByPerson).toHaveBeenCalledExactlyOnceWith(supabase, { companyId: 'company-1', documentId: DOC, userId: 'approver-1', docType: 'minutes.board' })
      expect(out).toEqual({ ok: true, data: { document_id: DOC, doc_type: 'minutes.board', previous_doc_type: 'other' } })
    })

    it('answers DOC_NOT_FOUND when the document is gone by approval', async () => {
      vi.mocked(setDocumentTypeByPerson).mockResolvedValue({ status: 'not_found' })

      expect(await documentsSetType.run(ctx({}), { document_id: DOC, doc_type: 'minutes.board' }, { dryRun: false })).toEqual({ ok: false, code: 'DOC_NOT_FOUND' })
    })

    it('fails the approval, without a type, when the service could not save it', async () => {
      vi.mocked(setDocumentTypeByPerson).mockResolvedValue({ status: 'error', reason: 'insert failed: boom' })

      const out = await documentsSetType.run(ctx({}), { document_id: DOC, doc_type: 'minutes.board' }, { dryRun: false })

      expect(out).toMatchObject({ ok: false, code: 'UNKNOWN_ERROR' })
    })
  })
})
