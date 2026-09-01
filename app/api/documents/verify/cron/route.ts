import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { downloadDocumentObject } from '@/lib/core/documents/document-service'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'

/**
 * GET /api/documents/verify/cron: nightly 03:00 UTC (schedule in vercel.json).
 * Spot-checks WORM archive integrity by recomputing SHA-256 for the next
 * batch of documents and appending the outcome to document_integrity_checks.
 * Hash mismatches and unreadable storage objects additionally get an
 * INTEGRITY_FAILURE row in the audit log, which is the durable incident
 * surface.
 *
 * Both the queue and the stamp live in document_integrity_checks and NOT in
 * document_attachments.last_integrity_check_at (now legacy): any UPDATE of a
 * document linked to an entry in a closed/locked period is rejected by
 * enforce_period_lock_documents() (migration 017, legally required and never
 * touched), which had this cron wedged at 200 of 200 rejected per night with
 * both write errors discarded. See
 * supabase/migrations/20260901130000_document_integrity_checks.sql.
 */

// Vercel function budget; verification is sequential, see batch size below.
export const maxDuration = 300

// Measured ~0.8s per document (download + hash + ledger append), so 200
// documents finish in ~160s with headroom inside the 300s budget. The previous
// default of 500 hit the platform timeout around item ~250 every night, so the
// tail of the queue was never reached.
const DEFAULT_VERIFY_BATCH_SIZE = 200

type ServiceClient = ReturnType<typeof createServiceRoleClient>

type IntegrityResult = 'passed' | 'hash_mismatch' | 'object_missing'

/** One row of public.next_documents_for_integrity_check(). */
interface QueuedDocument {
  id: string
  user_id: string
  company_id: string
  storage_path: string
  sha256_hash: string
  file_name: string
  last_checked_at: string | null
}

/**
 * Append the outcome of one check to the integrity ledger. The write error is
 * returned, never swallowed: a lost ledger row leaves the document at the head
 * of the queue, and discarding exactly this error is why the control stayed
 * dead for weeks without anyone noticing.
 */
async function recordCheck(
  supabase: ServiceClient,
  doc: QueuedDocument,
  result: IntegrityResult,
  computedHash: string | null,
  detail: string | null
): Promise<{ error: { message: string } | null }> {
  const { error } = await supabase.from('document_integrity_checks').insert({
    company_id: doc.company_id,
    document_id: doc.id,
    checked_at: new Date().toISOString(),
    expected_sha256: doc.sha256_hash,
    computed_sha256: computedHash,
    storage_path: doc.storage_path,
    result,
    detail,
  })

  return { error }
}

export const GET = withCronContext('cron.documents_verify', async (_request, ctx) => {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    return errorResponseFromCode('INTERNAL_ERROR', ctx.log, {
      requestId: ctx.requestId,
      details: { reason: 'Missing Supabase configuration' },
    })
  }

  const supabase = createServiceRoleClient(supabaseUrl, supabaseServiceKey)

  const batchSize =
    parseInt(process.env.DOCUMENT_VERIFY_BATCH_SIZE || '', 10) || DEFAULT_VERIFY_BATCH_SIZE

  // Least-recently-checked first, never-checked ahead of those, tie-broken on
  // created_at so the drain is a deterministic FIFO rather than heap order.
  const { data, error: fetchError } = await supabase.rpc('next_documents_for_integrity_check', {
    p_limit: batchSize,
  })

  if (fetchError) {
    ctx.log.error('failed to fetch documents for verify', fetchError)
    return errorResponse(fetchError, ctx.log, { requestId: ctx.requestId })
  }

  const documents = (data ?? []) as QueuedDocument[]

  if (documents.length === 0) {
    return NextResponse.json({ message: 'No documents to verify', processed: 0 })
  }

  let verified = 0
  let failures = 0
  let missingObjects = 0
  // Ledger and audit writes the database rejected. Counted, logged and shipped
  // in the response so a broken write path shows up on the first run instead
  // of weeks later.
  let writeFailures = 0

  const summary = await ctx.forEach('document', documents, async (doc, itemCtx) => {
    // Dual-layout download: the batch is snapshotted up front, and a
    // concurrent Phase B backfill (scripts/backfill-document-storage-paths.ts)
    // can re-home an object from the legacy uploader-scoped key to the
    // company-scoped key (and later remove the source) mid-batch, leaving
    // doc.storage_path stale. Trusting the stale pointer here wrote a
    // PERMANENT false DOCUMENT_OBJECT_MISSING INTEGRITY_FAILURE row into the
    // immutable audit log for a healthy document. The helper tries the
    // stored pointer first, then the alternate layout.
    const { blob: fileData, error: downloadError } = await downloadDocumentObject(
      supabase,
      doc.storage_path,
      doc.company_id
    )

    if (downloadError || !fileData) {
      // The storage object is unreadable: surface it as an incident in the
      // audit log. The action stays INTEGRITY_FAILURE because the DB check
      // constraint audit_log_action_check allows a fixed set of actions;
      // the DOCUMENT_OBJECT_MISSING marker in description and new_state
      // distinguishes a missing object from a hash mismatch.
      const reason = downloadError?.message || 'download_failed'
      const { error: auditError } = await supabase.from('audit_log').insert({
        user_id: doc.user_id,
        company_id: doc.company_id,
        action: 'INTEGRITY_FAILURE',
        table_name: 'document_attachments',
        record_id: doc.id,
        description: `DOCUMENT_OBJECT_MISSING: storage object for document "${doc.file_name}" at "${doc.storage_path}" could not be downloaded: ${reason}`,
        old_state: { sha256_hash: doc.sha256_hash },
        new_state: { reason: 'DOCUMENT_OBJECT_MISSING', download_error: reason },
      })

      if (auditError) {
        // Append no ledger row, so the document keeps its place at the head of
        // the queue and the incident write is re-attempted on the next run.
        writeFailures++
        itemCtx.log.error('audit insert failed for missing object', new Error(auditError.message), {
          documentId: doc.id,
        })
        throw new Error(`audit insert failed for missing object: ${auditError.message}`)
      }

      const { error: ledgerError } = await recordCheck(
        supabase,
        doc,
        'object_missing',
        null,
        `DOCUMENT_OBJECT_MISSING: ${reason}`
      )

      if (ledgerError) {
        writeFailures++
        itemCtx.log.error('integrity ledger write failed', new Error(ledgerError.message), {
          documentId: doc.id,
          result: 'object_missing',
        })
        throw new Error(`integrity ledger write failed: ${ledgerError.message}`)
      }

      missingObjects++
      itemCtx.log.error('document object missing', new Error(reason), {
        documentId: doc.id,
        fileName: doc.file_name,
        storagePath: doc.storage_path,
      })
      throw new Error(`DOCUMENT_OBJECT_MISSING: ${reason}`)
    }

    const buffer = await fileData.arrayBuffer()
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    const computedHash = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')

    const isValid = computedHash === doc.sha256_hash

    if (!isValid) {
      // Audit row before ledger row: if the ledger row landed first and the
      // audit write then failed, the document would leave the queue with the
      // incident lost. This order re-checks it tomorrow instead.
      const { error: auditError } = await supabase.from('audit_log').insert({
        user_id: doc.user_id,
        company_id: doc.company_id,
        action: 'INTEGRITY_FAILURE',
        table_name: 'document_attachments',
        record_id: doc.id,
        description: `Integrity check failed for document "${doc.file_name}": stored hash ${doc.sha256_hash}, computed hash ${computedHash}`,
        old_state: { sha256_hash: doc.sha256_hash },
        new_state: { computed_hash: computedHash },
      })

      if (auditError) {
        writeFailures++
        itemCtx.log.error('audit insert failed for hash mismatch', new Error(auditError.message), {
          documentId: doc.id,
        })
        throw new Error(`audit insert failed for hash mismatch: ${auditError.message}`)
      }
    }

    const { error: ledgerError } = await recordCheck(
      supabase,
      doc,
      isValid ? 'passed' : 'hash_mismatch',
      computedHash,
      isValid ? null : `stored hash ${doc.sha256_hash}, computed hash ${computedHash}`
    )

    if (ledgerError) {
      writeFailures++
      itemCtx.log.error('integrity ledger write failed', new Error(ledgerError.message), {
        documentId: doc.id,
        result: isValid ? 'passed' : 'hash_mismatch',
      })
      throw new Error(`integrity ledger write failed: ${ledgerError.message}`)
    }

    if (!isValid) {
      itemCtx.log.error('integrity failure', new Error('hash_mismatch'), {
        documentId: doc.id,
        fileName: doc.file_name,
        storedHash: doc.sha256_hash,
        computedHash,
      })
      failures++
    } else {
      verified++
    }
  })

  ctx.log.info('document verify summary', {
    processed: summary.total,
    verified,
    failures,
    missingObjects,
    writeFailures,
    downloadErrors: summary.failed,
  })

  if (writeFailures > 0) {
    // Loud on its own line: a rejected ledger write means the queue does not
    // advance, which is exactly the silent stall this cron just came out of.
    ctx.log.error('integrity ledger writes rejected', new Error('integrity_write_failed'), {
      processed: summary.total,
      writeFailures,
    })
  }

  return NextResponse.json({
    processed: summary.total,
    verified,
    failures,
    missingObjects,
    writeFailures,
    errors: summary.failed,
  })
})
