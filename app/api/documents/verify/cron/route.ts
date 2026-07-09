import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'

/**
 * GET /api/documents/verify/cron: nightly 03:00 UTC (schedule in vercel.json).
 * Spot-checks WORM archive integrity by recomputing SHA-256 for the next
 * batch of documents and writing INTEGRITY_FAILURE rows to the audit log
 * for any mismatches. Documents whose storage object cannot be downloaded
 * get an INTEGRITY_FAILURE row marked DOCUMENT_OBJECT_MISSING and are still
 * stamped as checked so they stop head-blocking the nulls-first queue.
 */

// Vercel function budget; verification is sequential, see batch size below.
export const maxDuration = 300

// Measured ~0.8s per document (download + hash + stamp), so 200 documents
// finish in ~160s with headroom inside the 300s budget. The previous default
// of 500 hit the platform timeout around item ~250 every night, so the tail
// of the queue was never reached.
const DEFAULT_VERIFY_BATCH_SIZE = 200

export const GET = withCronContext('cron.documents_verify', async (_request, ctx) => {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    return errorResponseFromCode('INTERNAL_ERROR', ctx.log, {
      requestId: ctx.requestId,
      details: { reason: 'Missing Supabase configuration' },
    })
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  const { data: documents, error: fetchError } = await supabase
    .from('document_attachments')
    .select('id, user_id, company_id, storage_path, sha256_hash, file_name')
    .eq('is_current_version', true)
    .order('last_integrity_check_at', { ascending: true, nullsFirst: true })
    .limit(parseInt(process.env.DOCUMENT_VERIFY_BATCH_SIZE || '', 10) || DEFAULT_VERIFY_BATCH_SIZE)

  if (fetchError) {
    ctx.log.error('failed to fetch documents for verify', fetchError)
    return errorResponse(fetchError, ctx.log, { requestId: ctx.requestId })
  }

  if (!documents || documents.length === 0) {
    return NextResponse.json({ message: 'No documents to verify', processed: 0 })
  }

  let verified = 0
  let failures = 0
  let missingObjects = 0

  const summary = await ctx.forEach('document', documents, async (doc, itemCtx) => {
    const { data: fileData, error: downloadError } = await supabase.storage
      .from('documents')
      .download(doc.storage_path)

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
        // Leave last_integrity_check_at untouched so the document is retried
        // (and the incident write re-attempted) on the next run.
        throw new Error(`audit insert failed for missing object: ${auditError.message}`)
      }

      // Stamp the check so the row stops sorting to the head of the
      // nulls-first queue every night; the audit row above is the durable
      // incident surface.
      await supabase
        .from('document_attachments')
        .update({ last_integrity_check_at: new Date().toISOString() })
        .eq('id', doc.id)

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

    await supabase
      .from('document_attachments')
      .update({ last_integrity_check_at: new Date().toISOString() })
      .eq('id', doc.id)

    if (!isValid) {
      await supabase.from('audit_log').insert({
        user_id: doc.user_id,
        company_id: doc.company_id,
        action: 'INTEGRITY_FAILURE',
        table_name: 'document_attachments',
        record_id: doc.id,
        description: `Integrity check failed for document "${doc.file_name}": stored hash ${doc.sha256_hash}, computed hash ${computedHash}`,
        old_state: { sha256_hash: doc.sha256_hash },
        new_state: { computed_hash: computedHash },
      })

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
    downloadErrors: summary.failed,
  })

  return NextResponse.json({
    processed: summary.total,
    verified,
    failures,
    missingObjects,
    errors: summary.failed,
  })
})
