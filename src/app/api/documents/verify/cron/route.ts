import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { NextResponse } from 'next/server'
import { withServiceCronContext, type CronItemContext } from '@/lib/api/with-cron-context'
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

/**
 * No document is started after this long. The batch size above is an
 * estimate; the median run is 106 s, and a night of slow downloads has no
 * other bound before the run is cut at the route's 300 s (declared above). A
 * document not reached has no ledger row, so it is still first in tomorrow's
 * queue.
 */
const VERIFY_TIME_BUDGET_MS = 240_000

/** Pause before the one retry of a failed download. */
const DOWNLOAD_RETRY_PAUSE_MS = 500

/**
 * After this many documents in a row that storage failed to serve for a
 * moment or as a service (isTransientStorageError), the run stops and answers
 * an error once: storage is failing, not the documents, and going on made one
 * item error per document for up to 200 documents. Refusals of one document
 * (a 403) do not count: documents uploaded together that storage refuses
 * would otherwise stop the run at the fifth, night after night. A document
 * storage could not serve is a warning on its own; the run reports them in
 * one error.
 */
const STORAGE_FAILURES_TO_STOP = 5

/**
 * Whether storage failed for a moment or as a service, saying nothing about
 * this document: no answer at all, a 5xx, 429 or 408, 401 (the service role's
 * own key), or a missing bucket (configuration). The document is left first
 * in the queue for the next run.
 */
function isTransientStorageError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return true
  const { status, message } = error as { status?: unknown; message?: unknown }
  if (typeof status !== 'number') return true
  if (typeof message === 'string' && /bucket/i.test(message)) return true
  return status >= 500 || status === 429 || status === 408 || status === 401
}

/**
 * Whether storage answered that nothing is at this key: HTTP 404, the 400
 * with statusCode "404" Supabase Storage answers for a missing object, or a
 * 400 InvalidKey (no object can be stored under a key storage rejects).
 * Anything else (a 5xx, 429, 401, 403, no answer at all) says nothing about
 * the object. A missing bucket answers "not found" too, but that is
 * configuration, never a lost document.
 */
function isObjectNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { message?: unknown; status?: unknown; statusCode?: unknown; code?: unknown; error?: unknown }
  if (typeof e.status === 'number' && e.status >= 500) return false
  const text = [e.message, e.code, e.error].filter((part): part is string => typeof part === 'string').join(' ')
  if (/bucket/i.test(text)) return false
  return e.status === 404 || e.statusCode === '404' || e.statusCode === 'InvalidKey' || /not[\s_-]?found|NoSuchKey|invalid ?key/i.test(text)
}

type ServiceClient = ReturnType<typeof createServiceRoleClient>

/**
 * unreadable: storage refuses this document at every key with something other
 * than "not found" (a 403). Recorded so the document moves behind the others
 * in the queue instead of heading it every night; it is tried again when its
 * turn comes. Migration 20261113041501.
 */
type IntegrityResult = 'passed' | 'hash_mismatch' | 'object_missing' | 'unreadable'

/** PostgreSQL check_violation: the ledger refuses a result its migration has not added yet. */
const CHECK_VIOLATION = '23514'

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
): Promise<{ error: { message: string; code?: string } | null }> {
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

export const GET = withServiceCronContext('cron.documents_verify', async (_request, ctx) => {
  const supabase = ctx.supabase

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
  // Documents storage could not serve twice (not every key answered "not
  // found"): nothing written, left first in the queue.
  let storageOutages = 0
  const storageDeferredIds: string[] = []
  // Documents storage refuses to serve at every key (a 403): recorded
  // unreadable, so they move behind the others; reported when it is new.
  let unreadable = 0
  const newlyUnreadableIds: string[] = []
  // Documents left for the next run because storage failed for a moment or
  // as a service: only these count toward the stop.
  let transientFailures = 0

  const verifyOne = async (doc: QueuedDocument, itemCtx: CronItemContext): Promise<void> => {
    // Dual-layout download: the batch is snapshotted up front, and a
    // concurrent Phase B backfill (scripts/backfill-document-storage-paths.ts)
    // can re-home an object from the legacy uploader-scoped key to the
    // company-scoped key (and later remove the source) mid-batch, leaving
    // doc.storage_path stale. Trusting the stale pointer here wrote a
    // PERMANENT false DOCUMENT_OBJECT_MISSING INTEGRITY_FAILURE row into the
    // immutable audit log for a healthy document. The helper tries the
    // stored pointer first, then the alternate layout.
    let download = await downloadDocumentObject(supabase, doc.storage_path, doc.company_id)

    if (!download.blob) {
      // One more try before anything permanent is written: a dropped
      // connection or a gateway hiccup on a healthy object must not become a
      // DOCUMENT_OBJECT_MISSING row nobody can remove.
      await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_RETRY_PAUSE_MS))
      download = await downloadDocumentObject(supabase, doc.storage_path, doc.company_id)
    }
    const { blob: fileData, error: downloadError } = download

    const errorTexts = download.errors.map((e) => e.message || 'download_failed')
    const leaveForNextRun = (transient: boolean): void => {
      storageOutages++
      if (transient) transientFailures++
      storageDeferredIds.push(doc.id)
      itemCtx.log.warn('document left for the next run: storage could not serve it', { documentId: doc.id, errors: errorTexts })
    }

    if (!fileData && !(download.errors.length > 0 && download.errors.every(isObjectNotFound))) {
      // Missing is concluded only when every key (the stored one and the
      // other layout) answered "not found". The first key's 404 with a 5xx,
      // 429, 401, 403 or no answer on the other says nothing about the
      // object: no audit row, the document is never written missing.
      if (download.errors.some(isTransientStorageError)) {
        // Storage failed for a moment or as a service: no ledger row either,
        // the document keeps its place. A warning: the run reports these in
        // one error at its end.
        leaveForNextRun(true)
        return
      }
      if (download.errors.some(isObjectNotFound)) {
        // One key holds nothing and storage refuses the other: neither missing
        // nor unreadable can be told. Left for the next run, reported in the
        // run's error; it does not stop the run.
        leaveForNextRun(false)
        return
      }
      // Storage refuses this document at every key (a 403): recorded
      // unreadable, so it moves behind the others instead of heading the
      // queue every night. Reported when it is new, not every time it comes up.
      const { data: previous } = await supabase
        .from('document_integrity_checks')
        .select('result')
        .eq('document_id', doc.id)
        .order('checked_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      const { error: ledgerError } = await recordCheck(supabase, doc, 'unreadable', null, `UNREADABLE: ${errorTexts.join('; ')}`.slice(0, 1000))
      if (ledgerError?.code === CHECK_VIOLATION) {
        // The ledger does not take 'unreadable' until its migration lands.
        leaveForNextRun(false)
        return
      }
      if (ledgerError) {
        writeFailures++
        itemCtx.log.error('integrity ledger write failed', new Error(ledgerError.message), { documentId: doc.id, result: 'unreadable' })
        throw new Error(`integrity ledger write failed: ${ledgerError.message}`)
      }
      unreadable++
      if ((previous as { result?: string } | null)?.result === 'unreadable') {
        itemCtx.log.warn('document still unreadable: storage refuses it', { documentId: doc.id, errors: errorTexts })
      } else {
        newlyUnreadableIds.push(doc.id)
      }
      return
    }

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
  }

  // One document at a time through ctx.forEach (its try/catch and per-item
  // log), with the clock and the run of storage failures checked before each.
  const deadline = ctx.startedAt + VERIFY_TIME_BUDGET_MS
  const summary = { total: 0, failed: 0 }
  let deferred = 0
  let storageFailuresInARow = 0
  for (const [index, doc] of documents.entries()) {
    if (Date.now() >= deadline || storageFailuresInARow >= STORAGE_FAILURES_TO_STOP) {
      deferred = documents.length - index
      break
    }
    // Only a failure of storage itself counts toward the stop, never a refusal of one document.
    const transientBefore = transientFailures
    const one = await ctx.forEach('document', [doc], verifyOne)
    summary.total += one.total
    summary.failed += one.failed
    storageFailuresInARow = transientFailures > transientBefore ? storageFailuresInARow + 1 : 0
  }

  ctx.log.info('document verify summary', {
    processed: summary.total,
    verified,
    failures,
    missingObjects,
    writeFailures,
    storageOutages,
    unreadable,
    deferred,
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

  const counts = {
    processed: summary.total,
    verified,
    failures,
    missingObjects,
    writeFailures,
    errors: summary.failed,
    // Present only when they happened, so a normal night answers as before.
    ...(storageOutages > 0 ? { storageOutages } : {}),
    ...(unreadable > 0 ? { unreadable } : {}),
    ...(deferred > 0 ? { deferred } : {}),
  }

  if (newlyUnreadableIds.length > 0) {
    // Once per document: a document still unreadable when its turn comes
    // again is a warning.
    ctx.log.error('documents storage refuses to serve: recorded unreadable, behind the others in the queue', {
      unreadable: newlyUnreadableIds.length,
      documentIds: newlyUnreadableIds.slice(0, 20),
    })
  }

  if (storageFailuresInARow >= STORAGE_FAILURES_TO_STOP) {
    // Storage failed for the last documents in a row: the night's check did
    // not happen. One error (this answer's log line) instead of one per document.
    return errorResponseFromCode('TRANSIENT_ERROR', ctx.log, {
      requestId: ctx.requestId,
      reason: `document verify stopped: storage could not serve ${storageFailuresInARow} documents in a row; ${deferred} left for the next run`,
      details: counts,
    })
  }

  if (storageOutages > 0) {
    // Some documents only: the run did its work, and they are first in the
    // queue tomorrow. One error, so a document that storage never serves is
    // seen every night.
    ctx.log.error('documents left for the next run: storage could not serve them', {
      storageOutages,
      documentIds: storageDeferredIds.slice(0, 20),
    })
  }

  return NextResponse.json(counts)
})
