import { NextResponse } from 'next/server'
import { getCompanyRole } from '@/lib/auth/require-write'
import { BankFileAccountIdentitySchema } from '@/lib/api/schemas'
import { accountIdentity } from '@/lib/import/bank-file/account-identity'
import { chooseBankFileLedger, importBankFile, type BankFileRefusal } from '@/lib/import/bank-file/import-file'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { ParsedBankTransaction, BankFileFormatId, BankFileAccountIdentity } from '@/lib/import/bank-file/types'

// Bank-file imports run a sequential, per-row ingest (insert + invoice/supplier
// matching + FX lookup). A full-year file (300+ rows) takes ~85s of server time,
// which sits right on the platform's default function limit and gets killed
// mid-run: the import "spins then aborts" for the user. Give it the same 5-minute
// budget the SIE import route uses (app/api/import/sie/execute/route.ts).
export const maxDuration = 300

interface ExecuteRequest {
  transactions: ParsedBankTransaction[]
  format: BankFileFormatId
  filename: string
  file_hash: string
  skip_duplicates: boolean
  auto_categorize: boolean
  settlement_account?: string
  /** The statement's own account, as the parse route read it from the file. */
  account?: BankFileAccountIdentity | null
}

/**
 * POST /api/import/bank-file/execute
 *
 * Executes the import of confirmed bank transactions: the ledger the person
 * picked is checked first, then importBankFile does what every door does.
 */
export const POST = withRouteContext(
  'bank_file.execute',
  async (request, ctx) => {
    const { user, supabase, log, requestId } = ctx

    // We still call getCompanyRole because viewers are allowed through with
    // rawInsertOnly behavior: `requireWrite: true` would block them. The
    // wrapper already resolved the company (and usually the role), so the
    // helper repeats neither read.
    const roleCheck = await getCompanyRole(supabase, user.id, { companyId: ctx.companyId, role: ctx.role })
    if (!roleCheck.ok) {
      // Inject the request id for traceability and pass through.
      if (!roleCheck.response.headers.get('X-Request-Id')) {
        roleCheck.response.headers.set('X-Request-Id', requestId)
      }
      return roleCheck.response
    }
    const { role, companyId } = roleCheck

    const body: ExecuteRequest = await request.json()
    const {
      transactions, format, filename, file_hash,
      skip_duplicates: _skip_duplicates = true,
      auto_categorize: _auto_categorize = true,
      settlement_account,
    } = body

    if (!transactions || transactions.length === 0) {
      return errorResponseFromCode('BANK_FILE_NO_TRANSACTIONS', log, { requestId })
    }

    const opLog = log.child({ filename, fileHash: file_hash, txCount: transactions.length })

    // The file names its own bank account (crm#1204). When that account is
    // already a cash account here, the rows belong on it and on no other
    // ledger: elsewhere the dedup account guard rightly sees another account,
    // and every row the bank feed already holds comes in a second time. A
    // file naming no known account imports as before. Checked before any
    // write, so a refusal leaves nothing behind.
    const accountPayload = BankFileAccountIdentitySchema.nullable().optional().safeParse(body.account)
    if (!accountPayload.success) {
      return errorResponseFromCode('VALIDATION_ERROR', opLog, {
        requestId,
        details: { field: 'account', issues: accountPayload.error.issues },
      })
    }
    const refused = (refusal: BankFileRefusal) =>
      errorResponseFromCode(refusal.code, opLog, {
        requestId,
        ...(refusal.details ? { details: refusal.details } : {}),
        ...(refusal.messageSv ? { messageSv: refusal.messageSv, messageEn: refusal.messageEn } : {}),
      })
    const opCtx = { supabase, companyId, userId: user.id, log: opLog }

    const chosen = await chooseBankFileLedger(opCtx, {
      transactions,
      account: accountPayload.data ? accountIdentity(accountPayload.data) : null,
      settlementAccount: settlement_account,
    })
    if (!chosen.ok) return refused(chosen)

    const outcome = await importBankFile(opCtx, {
      transactions,
      format,
      filename,
      fileHash: file_hash,
      settlementAccount: chosen.ledger,
      rawInsertOnly: role === 'viewer',
      arrival: { fetchedBy: { type: 'user', user_id: user.id }, via: 'app' },
    })
    if (!outcome.ok) return refused(outcome)

    // The per-row skip list stays server-side: a statement re-exported with
    // shifted row positions skips every row on content, and the wizard's
    // preview step already marked those rows one by one. The response keeps
    // the count and its split by reason (duplicates_by_reason).
    const { skipped: _skipped, ...ingestSummary } = outcome.data.ingest
    return NextResponse.json({
      data: {
        import_id: outcome.data.importId,
        ...ingestSummary,
      },
    })
  },
)
