/**
 * setDocumentTypeByPerson: the one service behind Dokument's "Ändra typ",
 * an approved gnubok_set_document_type and the doc_type of an MCP upload
 * (crm#2016).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('../classify', () => ({ recordHumanClassification: vi.fn() }))
vi.mock('@/lib/documents/jobs/queue', () => ({ enqueueDocumentJob: vi.fn() }))
vi.mock('@/lib/arkiv/agreements/store', () => ({ withdrawDerivedAgreement: vi.fn() }))

import { setDocumentTypeByPerson } from '../set-type'
import { recordHumanClassification } from '../classify'
import { enqueueDocumentJob } from '@/lib/documents/jobs/queue'
import { withdrawDerivedAgreement } from '@/lib/arkiv/agreements/store'

const DOC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const INPUT = { companyId: 'company-1', documentId: DOC, userId: 'user-1', docType: 'minutes.board' as const }

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  process.env.ARKIV_BRAIN_COMPANY_IDS = 'company-1'
  vi.mocked(withdrawDerivedAgreement).mockResolvedValue({ status: 'skipped', reason: 'no_agreement' })
  vi.mocked(recordHumanClassification).mockResolvedValue({ status: 'classified', admission: 'admitted' } as never)
})

describe('setDocumentTypeByPerson', () => {
  it('records a person\'s type, re-extracts under the brain, and answers the type it replaced', async () => {
    enqueue({ data: { id: DOC, doc_type: null } })

    const out = await setDocumentTypeByPerson(supabase as never, INPUT)

    expect(out).toEqual({ status: 'set', documentId: DOC, docType: 'minutes.board', previousDocType: null, withdrawnAgreementId: null })
    expect(recordHumanClassification).toHaveBeenCalledExactlyOnceWith(supabase, DOC, 'user-1', { docType: 'minutes.board', relevance: 'relevant' })
    expect(enqueueDocumentJob).toHaveBeenCalledExactlyOnceWith(supabase, 'company-1', DOC, 'extract')
  })

  it('looks the document up in the given company only: another company\'s document is not found and nothing is written', async () => {
    enqueue({ data: null })

    const out = await setDocumentTypeByPerson(supabase as never, INPUT)

    expect(out).toEqual({ status: 'not_found' })
    expect(findCalls('document_attachments', 'eq')).toEqual(expect.arrayContaining([['id', DOC], ['company_id', 'company-1']]))
    expect(withdrawDerivedAgreement).not.toHaveBeenCalled()
    expect(recordHumanClassification).not.toHaveBeenCalled()
  })

  it('keeps the old type when the withdrawal of what it derived fails', async () => {
    enqueue({ data: { id: DOC, doc_type: 'agreement.loan' } })
    vi.mocked(withdrawDerivedAgreement).mockResolvedValueOnce({ status: 'error', reason: 'agreement delete failed: boom' })

    const out = await setDocumentTypeByPerson(supabase as never, INPUT)

    expect(out).toEqual({ status: 'error', reason: 'agreement delete failed: boom' })
    expect(recordHumanClassification).not.toHaveBeenCalled()
    expect(enqueueDocumentJob).not.toHaveBeenCalled()
  })

  it('names the agreement it withdrew and the type before', async () => {
    enqueue({ data: { id: DOC, doc_type: 'agreement.loan' } })
    vi.mocked(withdrawDerivedAgreement).mockResolvedValueOnce({ status: 'withdrawn', agreementId: 'agr-1', facts: 2, deadlines: 1 } as never)

    const out = await setDocumentTypeByPerson(supabase as never, INPUT)

    expect(out).toMatchObject({ status: 'set', previousDocType: 'agreement.loan', withdrawnAgreementId: 'agr-1' })
    expect(withdrawDerivedAgreement).toHaveBeenCalledWith(supabase, DOC, 'minutes.board', expect.stringContaining('minutes.board'))
  })

  it('answers the type a booked document showed when its period lock kept the type on the classification', async () => {
    enqueue({ data: { id: DOC, doc_type: null, journal_entry_id: 'je-1', journal_entry_line_id: null } })
    enqueue({ data: [{ document_id: DOC, doc_type: 'receipt' }] })

    const out = await setDocumentTypeByPerson(supabase as never, INPUT)

    expect(out).toMatchObject({ status: 'set', previousDocType: 'receipt' })
    expect(findCalls('document_classifications', 'eq')).toEqual([['is_current', true]])
  })

  it('answers an error when the classification is not saved, and queues no extraction', async () => {
    enqueue({ data: { id: DOC, doc_type: null } })
    vi.mocked(recordHumanClassification).mockResolvedValueOnce({ status: 'error', reason: 'insert failed: boom' } as never)

    expect(await setDocumentTypeByPerson(supabase as never, INPUT)).toEqual({ status: 'error', reason: 'insert failed: boom' })
    expect(enqueueDocumentJob).not.toHaveBeenCalled()
  })

  it('queues no extraction for a company outside the brain rollout', async () => {
    process.env.ARKIV_BRAIN_COMPANY_IDS = 'someone-else'
    enqueue({ data: { id: DOC, doc_type: null } })

    expect((await setDocumentTypeByPerson(supabase as never, INPUT)).status).toBe('set')
    expect(enqueueDocumentJob).not.toHaveBeenCalled()
  })
})
