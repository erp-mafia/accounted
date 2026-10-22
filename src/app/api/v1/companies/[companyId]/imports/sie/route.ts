/** Submit durable SIE work and return its operation id before ledger writes. */
import { readSIERequestFile } from '@/lib/import/sie-intake'
import { z } from 'zod'
import { accepted } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { after } from 'next/server'
import {
  parseSIEFile,
  detectEncoding,
  decodeBuffer,
} from '@/lib/import/sie-parser'
import { submitSIEJob, SIEJobValidationError } from '@/lib/import/sie-jobs'
import { runSIEWorker } from '@/lib/import/sie-job-worker'
import { suggestSIEMappings } from '@/lib/import/sie-preview-mappings'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'
import { loadMappings } from '@/lib/import/sie-import'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { SIEJobOptionsSchema } from '@/lib/api/schemas'
import { apiKeyArrivalActor } from '@/lib/intake/arrivals'

const SieImportAccepted = z.object({
  operation_id: z.string().uuid(),
  type: z.literal('import.sie'),
  status: z.literal('queued'),
  poll_url: z.string(),
})

const MAX_FILE_SIZE = 50 * 1024 * 1024 // 50 MB: matches the dashboard's limit

export const maxDuration = 300 // 5 minutes: large multi-year SIE files

registerEndpoint({
  operation: 'imports.sie',
  method: 'POST',
  path: '/api/v1/companies/:companyId/imports/sie',
  summary: 'Import a SIE4 file.',
  description:
    'Accepts a SIE4 file (CP437 / Windows-1252 / UTF-8 auto-detected, up to 50 MB) as the request body, parses it, checks for duplicate imports by file-hash, and replays every #VER + #TRANS into the company\'s bookkeeping. Returns an `operation_id` immediately: poll `GET /api/v1/operations/{id}` for status + final result. The byte-equivalent dashboard route at /api/import/sie/execute backs the same lib helper, so a SIE imported via v1 matches what the dashboard would produce.',
  useWhen:
    'Migrating bookkeeping data from another system (Fortnox, Bokio, Visma) into Accounted, restoring from a backup .se file, or recreating a period from an archive.',
  doNotUseFor:
    'Bank transaction CSV/XML imports (use POST /imports/bank). Single-voucher creation (use POST /journal-entries). Importing into a period that already has posted entries: SIE imports run on a fresh period.',
  pitfalls: [
    'Body content-type must be multipart/form-data with either a `file` field carrying the .se / .sie / .si file, or `storagePath` and `filename` fields from the signed-upload endpoint.',
    'Files up to 50 MB use POST /imports/sie/upload, then upload bytes to Storage and submit storagePath + filename. Inline multipart is limited by the hosting gateway.',
    'An identical retry returns the same execution. Deliberate replacement requires options.onExistingPeriod=replace and options.supersedesImportId naming the reviewed predecessor, and uses a new batch after storno.',
    'A fiscal year that already has a posted ingående balans booked outside an import (by hand or by a year-end close) answers 409 SIE_IMPORT_PERIOD_HAS_OPENING_BALANCE when the import would book the file\'s IB on top of it (importOpeningBalances true and no earlier bookkeeping): resend with options.importOpeningBalances=false to import the vouchers on top of the posted IB. A year that already holds an import answers 409 SIE_IMPORT_PERIOD_ALREADY_IMPORTED.',
    'A file whose #ORGNR is not the company\'s organisation number answers 409 SIE_IMPORT_ORG_NUMBER_MISMATCH with both numbers in details. Check with the user, then resend with options.confirmOrgNumberMismatch=true to import it anyway. A file without #ORGNR is not checked.',
    'The operation can take 1-5 minutes for multi-year files. The HTTP response returns immediately with operation_id; poll /operations/{id} every ~2s for status.',
    'Chunks are visible while importing. Filing and export are held until completion. Undo uses batch storno and retains accounting history.',
    'options (a JSON string field) takes createFiscalPeriod, importOpeningBalances, importTransactions, updateAccountNames (each default true), voucherSeries (for vouchers the file gives no series; default B, as the dashboard), openingBalanceSeries (default: a series the file does not use), markImportedNoDocRequired (default false), onlyUsedAccounts (default false; true leaves out the BAS accounts with no balance and no voucher line in the file, while the file\'s own non-BAS accounts are still created and the archived file keeps everything), onExistingPeriod, supersedesImportId and confirmOrgNumberMismatch; any other key is 400.',
    'Account mappings are generated server-side from the file\'s #KONTO records (plus stored per-company overrides), by the same rules as the dashboard upload: a class 9 account carrying amounts is mapped to 2999 OBS-konto, also over a stored class 9 mapping. By default the file\'s account names are carried into the chart, renaming existing accounts whose names differ: pass options.updateAccountNames=false to keep BAS default names.',
  ],
  example: {
    response: {
      data: {
        operation_id: '7ce97122-264e-49ca-a795-e01dc77425e7',
        type: 'import.sie',
        status: 'queued',
        poll_url: '/api/v1/operations/7ce97122-264e-49ca-a795-e01dc77425e7',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'bookkeeping:write',
  risk: 'high',
  idempotent: true,
  reversible: true,
  dryRunSupported: false,
  request: { contentType: 'multipart/form-data' },
  response: { success: dataEnvelope(SieImportAccepted) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'imports.sie',
  async (request, ctx) => {
    // Parse multipart form
    let formData: FormData
    try {
      formData = await request.formData()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Expected multipart/form-data with a `file` field.' },
      })
    }

    const file = await readSIERequestFile(formData,ctx.supabase,ctx.companyId!)
    if (!(file instanceof File)) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'file', message: 'Missing or invalid `file` field.' },
      })
    }
    if (file.size > MAX_FILE_SIZE) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'file',
          message: `File too large (${file.size} bytes). Max ${MAX_FILE_SIZE} bytes.`,
        },
      })
    }

    // Optional execution flags: the job's own options schema, the one the
    // dashboard and the MCP tool use, so an omitted flag gets the same
    // default on every door ("import all", series-less vouchers to series B).
    // This route used to keep its own copy, with series-less vouchers to A.
    const optionsRaw = formData.get('options')
    let parsedOptions: unknown = {}
    if (typeof optionsRaw === 'string') {
      try {
        parsedOptions = JSON.parse(optionsRaw)
      } catch (err) {
        return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
          requestId: ctx.requestId,
          details: {
            field: 'options',
            message: `options must be a valid JSON string: ${err instanceof Error ? getUserErrorMessage(err) : 'parse error'}`,
          },
        })
      }
    }
    // OWASP V4.5: unknown keys are refused, so a careless edit cannot pass
    // mass-assigned fields through (zod's default is to strip them).
    const optionsParse = SIEJobOptionsSchema.strict().safeParse(parsedOptions)
    if (!optionsParse.success) return v1ValidationError(ctx, optionsParse.error)
    const options = optionsParse.data

    // Decode + parse + hash. These are all sync / fast: done before
    // starting the operation row so a malformed file gets a 400 instead of
    // a permanently-failed operation row.
    const buffer = await file.arrayBuffer()
    const encoding = detectEncoding(buffer)
    const content = decodeBuffer(buffer, encoding)

    // OWASP V5.2: cheap content-shape check before letting the SIE parser
    // chew on arbitrary bytes. A valid SIE4 file's first 4 KiB contains at
    // least one of #FLAGGA / #PROGRAM / #FORMAT / #SIETYP at the start
    // of a line. The regex requires line-start anchoring so an HTML
    // payload with `<!-- #FLAGGA -->` in a comment can't bypass: the
    // round-3 string-contains check was tighter than no-check, but the
    // regex is tighter still.
    const headerSlice = content.slice(0, 4096)
    if (!/(^|\n)\s*#(FLAGGA|PROGRAM|FORMAT|SIETYP)\b/.test(headerSlice)) {
      return v1ErrorResponseFromCode('SIE_PARSE_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: {
          reason: 'File does not appear to be SIE4: no #FLAGGA / #PROGRAM / #FORMAT / #SIETYP header record at the start of a line in the first 4 KiB.',
        },
      })
    }

    let parsed: Awaited<ReturnType<typeof parseSIEFile>>
    try {
      parsed = parseSIEFile(content)
    } catch (err) {
      ctx.log.error('SIE parse failed', err as Error)
      return v1ErrorResponseFromCode('SIE_PARSE_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
      })
    }

    // Build account mappings server-side from the file's #KONTO records and
    // any stored per-company overrides, by the same decision the dashboard
    // upload makes (#3312): class 9 amounts to 2999, unused definitions kept.
    // (This route used to pass [] as mappings, which the import's
    // mapping-coverage guard rejects for any real file.)
    const storedMappings = await loadMappings(ctx.supabase, ctx.companyId!)
    const { mappings } = suggestSIEMappings(parsed, BAS_REFERENCE, storedMappings)

    // Reject unmappable files with a clean 400 before starting the operation
    // row, mirroring the dashboard route: the alternative is a permanently
    // failed operation from the import's coverage guard.
    const unmapped = mappings.filter((m) => !m.targetAccount)
    if (unmapped.length > 0) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'file',
          message: `${unmapped.length} account(s) in the SIE file could not be mapped to BAS accounts.`,
          unmapped_accounts: unmapped.slice(0, 5).map((m) => ({
            account: m.sourceAccount,
            name: m.sourceName,
          })),
        },
      })
    }

    let job
    try {
      job = await submitSIEJob(ctx.supabase,ctx.companyId!,ctx.userId,content,mappings,{filename:file.name,...options},file,'sie_file',{
        source:'sie', via:'partner_api',
        fetchedBy:apiKeyArrivalActor(ctx),
      })
    } catch (err) {
      // Both numbers travel in details so the caller can show them; every
      // other refusal keeps the wrapper's mapping.
      if (err instanceof SIEJobValidationError && err.code === 'SIE_IMPORT_ORG_NUMBER_MISMATCH') {
        return v1ErrorResponseFromCode(err.code, ctx.log, { requestId: ctx.requestId, details: err.details })
      }
      throw err
    }
    after(async () => { await runSIEWorker({importId:job.id}) })
    return accepted(job.id, 'import.sie', { requestId: ctx.requestId })
  },
)
