import type { SupabaseClient } from '@supabase/supabase-js'
import { withdrawDerivedAgreement } from '@/lib/arkiv/agreements/store'
import { isArkivBrainEnabled } from '@/lib/arkiv/flag'
import { enqueueDocumentJob } from '@/lib/documents/jobs/queue'
import { recordHumanClassification } from './classify'
import type { DocType } from './taxonomy'

export type SetDocumentTypeOutcome =
  | { status: 'set'; documentId: string; docType: DocType; previousDocType: string | null; withdrawnAgreementId: string | null }
  | { status: 'not_found' }
  | { status: 'error'; reason: string }

/**
 * A person says what a document is: Dokument's "Ändra typ"
 * (POST /api/documents/[id]/classification), an approved
 * gnubok_set_document_type, and the doc_type an MCP upload names. The type
 * becomes the current classification and the model never overrides it. An
 * admitted document stays admitted; a held one is admitted by this answer too
 * (naming the type is saying it belongs here). The type decides the schema,
 * so the extraction is queued again where the Arkiv brain runs; what the old
 * type derived (an agreement, its obligations, deadlines and facts) is
 * withdrawn unless the new type is the same kind of agreement.
 *
 * Only a document of `companyId` is typed: the client is the service role on
 * every caller, so the company filter is the tenancy check.
 */
export async function setDocumentTypeByPerson(
  supabase: SupabaseClient,
  input: { companyId: string; documentId: string; userId: string; docType: DocType },
): Promise<SetDocumentTypeOutcome> {
  const { companyId, documentId, userId, docType } = input
  const { data: doc, error } = await supabase
    .from('document_attachments')
    .select('id, doc_type')
    .eq('id', documentId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) return { status: 'error', reason: `document fetch failed: ${error.message}` }
  if (!doc) return { status: 'not_found' }
  const previousDocType = (doc as { doc_type?: string | null }).doc_type ?? null

  // Withdraw first, save the type after: a failed withdrawal leaves the old type in place with nothing
  // half-corrected, and the withdrawal is idempotent, so a retry finishes the job.
  const withdrawn = await withdrawDerivedAgreement(supabase, documentId, docType, `Dokumentet är ${docType}, inte ett avtal (rättat av en person)`)
  if (withdrawn.status === 'error') return { status: 'error', reason: withdrawn.reason }
  const out = await recordHumanClassification(supabase, documentId, userId, { docType, relevance: 'relevant' })
  if (out.status !== 'classified') return { status: 'error', reason: 'reason' in out ? out.reason : 'Kunde inte spara.' }
  // The brain reads the record out of the retyped document; the shelf keeps the type and the pages.
  if (isArkivBrainEnabled(companyId)) await enqueueDocumentJob(supabase, companyId, documentId, 'extract')
  return {
    status: 'set',
    documentId,
    docType,
    previousDocType,
    withdrawnAgreementId: withdrawn.status === 'withdrawn' ? withdrawn.agreementId : null,
  }
}
