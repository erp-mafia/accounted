import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { uploadDocument, validateDocumentFile } from '@/lib/core/documents/document-service'
import { planPermitsAttach } from '@/lib/documents/underlag-import'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

ensureInitialized()

const AttachFieldsSchema = z.object({
  journal_entry_id: z.string().uuid(),
  /**
   * The fiscal year the user reviewed this batch against, echoed back from the
   * plan. Required, and checked against the target's own year on every request
   * including overrides: it is the only thing that makes the year enforceable
   * server-side. Deriving it from the target instead would be tautological, an
   * entry is by construction inside its own period, and that is precisely the
   * hole that let a 2023 receipt land on a 2025 verifikat.
   */
  fiscal_period_id: z.string().uuid(),
  /**
   * Set ONLY when the user resolved this file by hand because its filename
   * carries no usable reference. Honored server-side ONLY for filenames the
   * resolver cannot place in the declared year: a resolvable filename must
   * land where it points, override or not. Company ownership, the year
   * assertion and the period lock are always enforced.
   *
   * Choosing among candidates the server itself proposed is NOT an override:
   * those targets pass the check already, and flagging them would switch the
   * guard off on exactly the ambiguous rows it exists for.
   */
  override: z.boolean(),
})

/**
 * POST /api/import/documents/attach: archive one underlag file and link it to a
 * migrated verifikat.
 *
 * multipart/form-data:
 *   file:              the underlag
 *   journal_entry_id:  the target the user approved in the preview
 *   fiscal_period_id:  the year the plan was built against (echoed back)
 *   override:          'true' when the target was chosen by hand
 *
 * One file per request on purpose: a folder migration is hundreds of files, the
 * browser streams them one at a time with visible progress, and a failure on
 * file 200 leaves the first 199 correctly attached instead of rolling back work
 * that is legally irreversible anyway.
 *
 * Idempotent per (verifikat, content): re-running the same import converges on
 * the same document row rather than archiving duplicates, via the deterministic
 * document id that `idempotency_key` reserves.
 */
export const POST = withRouteContext(
  'import.documents.attach',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const formData = await request.formData()
    const file = formData.get('file') as File | null

    if (!file) {
      return errorResponseFromCode('DOC_UPLOAD_NO_FILE', log, { requestId })
    }

    const fields = AttachFieldsSchema.safeParse({
      journal_entry_id: formData.get('journal_entry_id'),
      fiscal_period_id: formData.get('fiscal_period_id'),
      override: formData.get('override') === 'true',
    })
    if (!fields.success) {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: {
          issues: fields.error.issues.map((i) => ({
            field: i.path.join('.'),
            reason: i.message,
          })),
        },
      })
    }
    const {
      journal_entry_id: journalEntryId,
      fiscal_period_id: fiscalPeriodId,
      override,
    } = fields.data

    const validationError = validateDocumentFile({ size: file.size, type: file.type })
    if (validationError) {
      const code = /storlek|stor|MB/i.test(validationError)
        ? 'DOC_UPLOAD_TOO_LARGE'
        : 'DOC_UPLOAD_UNSUPPORTED_TYPE'
      return errorResponseFromCode(code, log, {
        requestId,
        details: { reason: validationError, sizeBytes: file.size, mimeType: file.type },
      })
    }

    const opLog = log.child({ filename: file.name, journalEntryId })

    // Tenant check first and explicitly: RLS covers the cookie session, but the
    // link is irreversible, so the route never takes the client's word for which
    // company an entry belongs to.
    const { data: entry, error: entryError } = await supabase
      .from('journal_entries')
      .select('id, fiscal_period_id, status, source_voucher_series, source_voucher_number')
      .eq('id', journalEntryId)
      .eq('company_id', companyId!)
      .maybeSingle()

    if (entryError) {
      opLog.error('underlag attach target lookup failed', entryError)
      return errorResponseFromCode('DOC_LINK_FAILED', opLog, { requestId })
    }
    if (!entry) {
      return errorResponseFromCode('DOC_LINK_ENTRY_NOT_FOUND', opLog, { requestId })
    }

    // Underlag references a verifikation (BFL 5 kap 6-7 §), so the target must
    // BE one: posted, or reversed (a storno'd original keeps its underlag). The
    // SIE import posts entries inside its own transaction, so a draft here
    // should be unreachable, but this route writes irreversible links and does
    // not lean on an invariant enforced in another file.
    if (entry.status !== 'posted' && entry.status !== 'reversed') {
      opLog.warn('underlag attach refused: target entry is not posted', {
        entryStatus: entry.status,
      })
      return errorResponseFromCode('UNDERLAG_ENTRY_NOT_POSTED', opLog, { requestId })
    }

    // The batch declared a fiscal year and the user reviewed the plan against
    // it. The target must actually be in that year. Enforced FIRST and
    // unconditionally, overrides included: a hand-resolved filename is a
    // statement about which verifikat, never about which year, and this is the
    // only check that makes the declared year mean anything on the server.
    if (entry.fiscal_period_id !== fiscalPeriodId) {
      opLog.warn('underlag attach refused: target sits in a different fiscal year', {
        declaredFiscalPeriodId: fiscalPeriodId,
        entryFiscalPeriodId: entry.fiscal_period_id,
      })
      return errorResponseFromCode('UNDERLAG_PERIOD_MISMATCH', opLog, { requestId })
    }

    // The file must additionally land where the preview said it would. A stale
    // plan in the browser (the user re-imported SIE in another tab, say) would
    // otherwise scatter underlag across the wrong verifikat. The resolver runs
    // on EVERY request: an override only relaxes it for filenames it cannot
    // place at all, never for a filename that resolves elsewhere.
    if (!override && entry.source_voucher_number == null) {
      // Not a SIE-migrated verifikat, so no filename can ever resolve to it.
      // Say that plainly instead of reporting a mismatch the user can't fix.
      return errorResponseFromCode('UNDERLAG_ENTRY_NOT_MIGRATED', opLog, { requestId })
    }
    const permitted = await planPermitsAttach(
      supabase,
      companyId!,
      file.name,
      journalEntryId,
      fiscalPeriodId,
      override,
    )
    if (!permitted) {
      opLog.warn('underlag attach refused: filename does not resolve to the target', { override })
      return errorResponseFromCode('UNDERLAG_REF_MISMATCH', opLog, { requestId })
    }

    try {
      const buffer = await file.arrayBuffer()

      const document = await uploadDocument(
        supabase,
        user.id,
        companyId!,
        { name: file.name, buffer, type: file.type },
        {
          upload_source: 'file_upload',
          journal_entry_id: journalEntryId,
          // The file lands on a posted verifikat by construction, so the
          // booking is already known and a model pass per file buys nothing.
          // Run inline through document.uploaded (the bus awaits its
          // handlers), that pass was the bulk of a 10-minute foreground wait
          // on a few hundred migrated files (#2188). Same opt-out as the
          // provider underlag sweep (#1783), for the same reason.
          extractionOwner: 'none',
          // Scope the deterministic id to the target verifikat: the same
          // receipt may legitimately back several verifikat, so content alone
          // must not dedupe across them.
          idempotency_key: journalEntryId,
        },
      )

      return NextResponse.json({ data: document })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown'

      // enforce_period_lock_documents: a migrated year is often closed by the
      // time the receipts arrive, and the trigger blocks the link outright.
      if (/locked\/closed fiscal period|Bokföringen är låst/i.test(message)) {
        return errorResponseFromCode('DOC_UPLOAD_PERIOD_LOCKED', opLog, {
          requestId,
          details: { reason: getErrorMessage(err) },
        })
      }
      if (/kunde inte verifieras|matchar inte den angivna filtypen/i.test(message)) {
        opLog.warn('underlag attach rejected by content validation', { reason: message })
        return errorResponseFromCode('DOC_UPLOAD_INVALID_CONTENT', opLog, {
          requestId,
          details: { reason: getErrorMessage(err) },
        })
      }

      opLog.error('underlag attach failed', err as Error)
      return errorResponseFromCode('DOC_UPLOAD_STORAGE_FAILED', opLog, { requestId })
    }
  },
  { requireWrite: true },
)
