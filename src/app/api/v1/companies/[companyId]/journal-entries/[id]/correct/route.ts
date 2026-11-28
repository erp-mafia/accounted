/**
 * POST /api/v1/companies/{companyId}/journal-entries/{id}/correct
 *
 * 3-step correction flow per Bokföringslagen (BFL 5 kap 5 §): the original
 * stays posted, a storno reversal nullifies it, and a corrected entry is
 * posted with the new lines. All three remain in the verifikationsserie,
 * linked via reverses_id, reversed_by_id, and correction_of_id.
 *
 * Body: `{ lines: [...], description?, allow_deep_chain?, sides_swapped? }`: the new balanced
 * lines. The corrected entry inherits entry_date, fiscal_period_id, and
 * voucher_series from the original; when the original's date is in a locked
 * or closed year, or on or before the company lock date, the storno and the
 * corrected entry are both dated in the first open, unlocked period instead
 * and name the original. Its description defaults to
 * "Rättelse: <original>"; pass `description` to override it (e.g. when the
 * original label named the wrong account). `allow_deep_chain` bypasses the
 * correction-chain depth guard (CORRECTION_CHAIN_TOO_DEEP at 3+ levels).
 * Lines that are the original with debit and credit swapped answer
 * MEANINGLESS_CORRECTION (negates_original) unless `sides_swapped` says the
 * original itself had the sides swapped (crm#1397).
 *
 * Idempotent (mandatory Idempotency-Key). Dry-runnable.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { stornoTargetLockedResponse } from '@/lib/api/v1/storno-target-refusal'
import { correctionLanding } from '@/lib/vat/moved-correction-vat'
import { rcBasisTwiceVoucherWarning } from '@/lib/vat/voucher-rc-basis-twice-warning'
import { CorrectJournalEntrySchema } from '@/lib/api/schemas'
import { validateBalance } from '@/lib/bookkeeping/engine'
import { assertCorrectedImportVatBase } from '@/lib/bookkeeping/import-vat-base'
import { debitTotal, unattendedCeilingRefusal } from '@/lib/bookkeeping/unattended-ceiling'
import { correctionBusinessEvents } from '@/lib/bookkeeping/ledger-business-events'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { linkBasisColumns } from '@/lib/links/stamp'
import { postingPort } from '@/lib/posting/port'
import { correctionChainDepth, CORRECTION_CHAIN_GUARD_DEPTH } from '@/lib/core/bookkeeping/correction-chain'
import { voucherOwnerOrNull } from '@/lib/core/bookkeeping/voucher-owner'
import { OWNED_BY_PITFALL, VoucherOwnerSchema } from '@/lib/api/v1/voucher-owner-schema'
import { negatesOriginal } from '@/lib/core/bookkeeping/correction-shape'
import { CorrectionChainTooDeepError, MeaninglessCorrectionError, isBookkeepingError } from '@/lib/bookkeeping/errors'

const JournalEntryCorrected = z.object({
  reversal_id: z.string().uuid(),
  corrected_id: z.string().uuid(),
  original_id: z.string().uuid(),
  voucher_series: z.string(),
  reversal_voucher_number: z.number().int(),
  corrected_voucher_number: z.number().int(),
  owned_by: VoucherOwnerSchema.nullable(),
  entry_date: z.string(),
  warnings: z
    .array(z.object({ code: z.string(), message_sv: z.string(), message_en: z.string() }))
    .optional(),
})

registerEndpoint({
  operation: 'journal-entries.correct',
  method: 'POST',
  path: '/api/v1/companies/:companyId/journal-entries/:id/correct',
  summary: 'Correct a posted journal entry (BFL 5:5 storno-then-replace).',
  description:
    'Per Bokföringslagen 5 kap 5 §, posted entries cannot be modified. This endpoint creates the canonical correction trail: a storno reversing the original, then a new entry with the corrected lines. All three are visible in the verifikationsserie and linked via reverses_id / reversed_by_id / correction_of_id. Idempotent. Dry-runnable.',
  useWhen:
    'You need to amend a posted verifikation. Use this rather than /reverse when the entry is being REPLACED with new lines: /reverse just nullifies.',
  doNotUseFor:
    'Drafts (no voucher_number: cancel via dashboard). Already-corrected entries (the chain only supports one correction; correct the latest in the chain).',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'The new lines must balance. JOURNAL_ENTRY_NOT_BALANCED if not.',
    'The original\'s entry_date and fiscal_period_id are inherited. When the original\'s fiscal year is locked or closed, or its date is on or before the company lock date, the storno and the corrected entry are both dated in the first open, unlocked period instead (today when today lies in it), their descriptions name the original voucher and date, and the original stays as booked; a dry run and the answer return that entry_date. When such a pair changes VAT (26xx), warnings[] (code VAT_OF_MOVED_CORRECTION) names the momsperiod the error belongs to and whether it is filed: a filed return is corrected instead. An opening balance, year-end or VAT settlement entry keeps its date and returns PERIOD_LOCKED; NO_OPEN_PERIOD_FOR_DATE when the next fiscal year does not exist yet.',
    'Three voucher numbers are advanced in this call: the original (already burned), the reversal, and the corrected. The series stays unbroken.',
    'A chain 3+ corrections deep returns CORRECTION_CHAIN_TOO_DEEP (409). Compute the net effect of the whole chain and book ONE correction, or pass allow_deep_chain=true to override.',
    'Lines that are the original with debit and credit swapped return MEANINGLESS_CORRECTION (400, details.reason negates_original): the storno already reverses the original. To only cancel an entry use /reverse; pass sides_swapped=true only when the original itself was booked with the sides swapped.',
    'Lines crediting import VAT (2615/2625/2635, boxes 60-62) need the taxable amount in box 50 (4545-4547) in the same lines, else 400 IMPORT_VAT_WITHOUT_BASE; reverse charge books its output VAT on 2614/2624/2634.',
    'Lines with a 45xx/4598 basis pair beside an account that reports boxes 20-24 itself (a cost account with a reverse-charge momskod, or a basis account booked as the cost) count the purchase twice: warnings[] carries REVERSE_CHARGE_BASIS_TWICE. The correction still posts; remove the pair unless it is meant.',
    OWNED_BY_PITFALL,
    'An entry linked to a bank transaction keeps its amount on that transaction\'s bank ledger account (the account the bank says the money moved on): lines that move it to another bank account (19xx or a cash account ledger) return 409 CORRECTION_BANK_ACCOUNT_CHANGED (details.bank_account, details.moved_to). If the transaction does not belong to the entry, reverse the entry instead.',
  ],
  example: {
    request: {
      lines: [
        { account_number: '6570', debit_amount: 75, credit_amount: 0, line_description: 'Bankavgift (rättad)' },
        { account_number: '1930', debit_amount: 0, credit_amount: 75, line_description: 'Företagskonto' },
      ],
    },
    response: {
      data: {
        reversal_id: '4d2a…',
        corrected_id: '7b3a…',
        original_id: '0e9c…',
        voucher_series: 'A',
        reversal_voucher_number: 144,
        corrected_voucher_number: 145,
        owned_by: null,
        entry_date: '2026-03-14',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'bookkeeping:write',
  risk: 'high',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  request: { body: CorrectJournalEntrySchema },
  response: { success: dataEnvelope(JournalEntryCorrected) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'journal-entries.correct',
  async (request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Journal entry id must be a UUID.' },
      })
    }
    const entryId = idParse.data

    const rawBodyResult = await readV1JsonBody(request, ctx)
    if (!rawBodyResult.ok) return rawBodyResult.response
    const rawBody = rawBodyResult.body
    const parsed = CorrectJournalEntrySchema.safeParse(rawBody)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    const { lines, description, allow_deep_chain, sides_swapped } = parsed.data

    const balance = validateBalance(lines)
    if (!balance.valid) {
      return v1ErrorResponseFromCode('JOURNAL_ENTRY_NOT_BALANCED', ctx.log, {
        requestId: ctx.requestId,
        details: { total_debit: balance.totalDebit, total_credit: balance.totalCredit },
      })
    }

    // Pre-flight: confirm the original is posted (storno-service throws
    // CANNOT_CORRECT_NON_POSTED otherwise but we want the structured envelope).
    const { data: original, error: fetchErr } = await ctx.supabase
      .from('journal_entries')
      .select('id, status, entry_date, fiscal_period_id, voucher_series, correction_of_id, reverses_id, source_type, source_id, lines:journal_entry_lines(account_number, debit_amount, credit_amount)')
      .eq('company_id', ctx.companyId!)
      .eq('id', entryId)
      .maybeSingle()

    if (fetchErr) return v1ErrorResponse(fetchErr, ctx.log, { requestId: ctx.requestId })
    if (!original) {
      return v1ErrorResponseFromCode('JOURNAL_ENTRY_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }
    const typed = original as {
      id: string
      status: string
      entry_date: string
      voucher_series: string
      correction_of_id: string | null
      reverses_id: string | null
      source_type: string | null
      source_id: string | null
      lines?: Array<{ account_number: string; debit_amount: number | string; credit_amount: number | string }> | null
      // The storno target check reads the original's year.
      fiscal_period_id: string
    }
    if (typed.status !== 'posted') {
      return v1ErrorResponseFromCode('CANNOT_CORRECT_NON_POSTED', ctx.log, {
        requestId: ctx.requestId,
        details: { current_status: typed.status },
      })
    }

    // Chain-depth guard BEFORE the dry-run return: a dry run must give the
    // same verdict the real execution would, so a depth-3 chain without the
    // override reports CORRECTION_CHAIN_TOO_DEEP here too. correctEntry
    // re-checks on the real path.
    if (!allow_deep_chain) {
      const chain = await correctionChainDepth(ctx.supabase, ctx.companyId!, typed)
      if (chain.depth >= CORRECTION_CHAIN_GUARD_DEPTH) {
        return v1ErrorResponse(
          new CorrectionChainTooDeepError(chain.depth, chain.rootVoucher),
          ctx.log,
          { requestId: ctx.requestId },
        )
      }
    }

    // A second reversal is refused before the dry-run return too, so the dry
    // run answers what the real call would (correctEntry re-checks).
    if (!sides_swapped && negatesOriginal(lines, typed.lines ?? [])) {
      return v1ErrorResponse(new MeaninglessCorrectionError('negates_original'), ctx.log, {
        requestId: ctx.requestId,
      })
    }

    // Where the storno and the corrected entry land: correctEntry's own check,
    // run here with the same option so the dry run gives the real verdict. On
    // the original's date while its year is open; else in the first open,
    // unlocked period after it. A date that cannot move (an opening balance,
    // year-end or VAT settlement entry) keeps the structured PERIOD_LOCKED,
    // which beats letting the engine throw a Swedish string that falls
    // through to BOOKKEEPING_DATABASE_ERROR.
    // Moved out of a locked period, a pair that changes VAT also carries the
    // advice on the momsperiod the error belongs to (lib/vat/moved-correction-vat.ts).
    let landing: Awaited<ReturnType<typeof correctionLanding>>
    try {
      landing = await correctionLanding(ctx.supabase, ctx.companyId!, typed, lines)
    } catch (err) {
      const refused = await stornoTargetLockedResponse(ctx, err, typed.fiscal_period_id, 'entry_date')
      if (refused) return refused
      if (isBookkeepingError(err)) return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
      throw err
    }

    // Importmoms keeps its ruta 50 base in the corrected lines (#94): the rule
    // correctEntry runs at commit, here before the dry-run return too.
    try {
      await assertCorrectedImportVatBase(ctx.supabase, ctx.companyId!, typed.source_type, lines)
    } catch (err) {
      return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
    }

    // An API key's unattended ceiling, which correctEntry asks for the storno
    // and the corrected verifikat before either is drafted: here before the
    // dry-run return too.
    const overCeiling = unattendedCeilingRefusal(Math.max(debitTotal(typed.lines ?? []), debitTotal(lines)))
    if (overCeiling) return v1ErrorResponse(overCeiling, ctx.log, { requestId: ctx.requestId })

    // The object the verifikat books, if any (advice, never a refusal): the
    // correction is a new verifikat it does not point at, so name it.
    const ownedBy = await voucherOwnerOrNull(ctx.supabase, ctx.companyId!, typed)
    // A basis pair beside an account that reports ruta 20-24 itself counts
    // the purchase twice (lib/vat/voucher-rc-basis-twice-warning.ts): advice,
    // never a refusal, and a failed read never stops the rättelse.
    const basisTwice = await rcBasisTwiceVoucherWarning(ctx.supabase, ctx.companyId!, {
      lines,
      replaces: {
        entry_date: typed.entry_date,
        lines: (typed.lines ?? []).map((l) => ({
          account_number: l.account_number,
          debit_amount: Number(l.debit_amount) || 0,
          credit_amount: Number(l.credit_amount) || 0,
        })),
      },
      ...(typed.source_type === 'opening_balance' ? { opening_balance: true } : {}),
    }).catch((err: unknown) => {
      ctx.log.warn('reverse-charge basis check failed (continuing)', err as Error)
      return null
    })
    const warningList = [landing.vatWarning, basisTwice]
      .filter((w): w is NonNullable<typeof w> => w != null)
      .map((w) => ({ code: w.code, message_sv: w.message_sv, message_en: w.message_en }))
    const vatWarnings = warningList.length > 0 ? { warnings: warningList } : {}

    if (ctx.dryRun) {
      return dryRunPreview(
        {
          original_id: entryId,
          would_create_reversal: true,
          would_create_corrected: true,
          voucher_series: typed.voucher_series,
          inherited_entry_date: typed.entry_date,
          // Where the storno and the corrected entry are dated: the original's
          // date, or the first open period's when the original's is locked.
          entry_date: landing.target.date,
          new_lines_balance: { debit: balance.totalDebit, credit: balance.totalCredit },
          owned_by: ownedBy,
          ...vatWarnings,
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    try {
      // Posting port (step 2i): ledger.storno and ledger.correction of the
      // verifikat while POSTING_EVENTS is on, client_asserted on a key.
      const { reversal, corrected } = await postingPort.correctJournalEntry({
        supabase: ctx.supabase,
        companyId: ctx.companyId!,
        userId: ctx.userId,
        entryId,
        ...correctionBusinessEvents({ entryId, occurredOn: todayIsoStockholm, linkBasis: () => linkBasisColumns('user_created') }),
        correction: {
          lines,
          options: {
            description,
            allowDeepChain: allow_deep_chain,
            ...(sides_swapped ? { sidesSwapped: true } : {}),
            inFirstOpenPeriodWhenLocked: true,
          },
        },
      })
      return ok(
        {
          reversal_id: reversal.id,
          corrected_id: corrected.id,
          original_id: entryId,
          voucher_series: corrected.voucher_series,
          reversal_voucher_number: reversal.voucher_number,
          corrected_voucher_number: corrected.voucher_number,
          owned_by: ownedBy,
          entry_date: corrected.entry_date,
          ...vatWarnings,
        },
        { requestId: ctx.requestId },
      )
    } catch (err) {
      if (isBookkeepingError(err)) {
        return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
      }
      ctx.log.error('journal-entries.correct failed', err as Error, { entryId })
      return v1ErrorResponseFromCode('BOOKKEEPING_DATABASE_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { step: 'correct' },
      })
    }
  },
  { requireIdempotencyKey: true },
)
