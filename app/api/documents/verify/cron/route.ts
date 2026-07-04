import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'

/**
 * GET /api/documents/verify/cron: weekly Sunday 03:00 UTC.
 * Spot-checks WORM archive integrity by recomputing SHA-256 for the next
 * batch of documents and writing INTEGRITY_FAILURE rows to the audit log
 * for any mismatches.
 */
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
    .limit(parseInt(process.env.DOCUMENT_VERIFY_BATCH_SIZE || '500', 10))

  if (fetchError) {
    ctx.log.error('failed to fetch documents for verify', fetchError)
    return errorResponse(fetchError, ctx.log, { requestId: ctx.requestId })
  }

  if (!documents || documents.length === 0) {
    return NextResponse.json({ message: 'No documents to verify', processed: 0 })
  }

  let verified = 0
  let failures = 0

  const summary = await ctx.forEach('document', documents, async (doc, itemCtx) => {
    const { data: fileData, error: downloadError } = await supabase.storage
      .from('documents')
      .download(doc.storage_path)

    if (downloadError || !fileData) {
      throw new Error(downloadError?.message || 'download_failed')
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
    downloadErrors: summary.failed,
  })

  return NextResponse.json({
    processed: summary.total,
    verified,
    failures,
    errors: summary.failed,
  })
})
