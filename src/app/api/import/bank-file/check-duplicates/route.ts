import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { BankFileCheckDuplicatesSchema } from '@/lib/api/schemas'
import { generateExternalId } from '@/lib/import/bank-file/parser'
import { previewDuplicates } from '@/lib/transactions/dedup-preview'
import type { ParsedBankTransaction } from '@/lib/import/bank-file/types'
import { ensureInitialized } from '@/lib/init'

ensureInitialized()

/**
 * POST /api/import/bank-file/check-duplicates
 *
 * Read-only duplicate preview for the bank-file import wizard: given the
 * parsed rows and their format, reports which rows execute-side ingest will
 * skip as duplicates (exact external_id collisions + the content bridge), so
 * the wizard can warn BEFORE the user confirms instead of silently importing
 * fewer rows than promised.
 *
 * A dedicated endpoint rather than part of /parse because the generic_csv
 * path re-parses client-side after column mapping and never re-hits the parse
 * route. The preview runs the decision function execute runs; it is ADVISORY
 * only because the settlement account is not picked yet (see
 * lib/transactions/dedup-preview.ts), so execute's own ingest result stays
 * authoritative. Nothing is written here.
 */
export const POST = withRouteContext(
  'bank_file.check_duplicates',
  async (request, ctx) => {
    const { supabase, companyId, log } = ctx

    const validation = await validateBody(request, BankFileCheckDuplicatesSchema, {
      log,
      operation: 'bank_file.check_duplicates',
    })
    if (!validation.success) return validation.response
    const { transactions, format } = validation.data

    // Identical id derivation to the execute route: generateExternalId over
    // the same rows in the same order, so preview Layer-1 collides on exactly
    // the ids execute will collide on.
    const raws = transactions.map((tx, index) => ({
      date: tx.date,
      description: tx.description,
      amount: tx.amount,
      currency: tx.currency || 'SEK',
      external_id: generateExternalId(
        {
          date: tx.date,
          description: tx.description,
          amount: tx.amount,
          currency: tx.currency || 'SEK',
          raw_line: tx.raw_line ?? undefined,
        } satisfies ParsedBankTransaction,
        format,
        index,
      ),
      // The same channel tag execute stamps: the cross-channel and
      // hand-entered mirrors are gated on it.
      import_source: format === 'camt053' ? 'camt053' : `csv_${format}`,
    }))

    const preview = await previewDuplicates(supabase, companyId, raws)

    return NextResponse.json({ data: preview })
  },
)
