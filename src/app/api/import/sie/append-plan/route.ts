import { NextResponse } from 'next/server'
import { detectEncoding, decodeBuffer, parseSIEFile } from '@/lib/import/sie-parser'
import { suggestSIEMappings } from '@/lib/import/sie-preview-mappings'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { SIEJobMappingsSchema, SIEJobOptionsSchema } from '@/lib/api/schemas'
import { resolveSIEFiscalYear, SIEIntakeNotFoundError, SIEJobValidationError } from '@/lib/import/sie-jobs'
import { sieJobValidationResponse } from '@/lib/import/sie-job-validation-response'
import { loadMappings } from '@/lib/import/sie-import'
import { readSIERequestFile } from '@/lib/import/sie-intake'
import { hasSIEFileExtension } from '@/lib/import/sie-file-extensions'
import { planSIEAppend } from '@/lib/import/sie-append'

export const maxDuration = 300

/** The options the plan reads; every other import option is the job's. */
const AppendPlanOptionsSchema = SIEJobOptionsSchema.pick({
  includePossibleDuplicates: true,
  voucherSeries: true,
  seriesMap: true,
})

/**
 * POST /api/import/sie/append-plan
 * The wizard's "Lägg till nya verifikat" preview (issue #108): what an append
 * of the uploaded file to its imported year would do, voucher by voucher,
 * read-only. The same planner refuses at submit and decides in the job.
 */
export const POST = withRouteContext('sie_import.append_plan', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx
  try {
    const form = await request.formData()
    const file = await readSIERequestFile(form, supabase, companyId)
    if (!(file instanceof File)) return errorResponseFromCode('SIE_PARSE_NO_FILE', log, { requestId })
    if (!hasSIEFileExtension(file.name)) return errorResponseFromCode('SIE_PARSE_INVALID_TYPE', log, { requestId })
    const options = AppendPlanOptionsSchema.safeParse(JSON.parse(String(form.get('options') ?? '{}')))
    if (!options.success) return errorResponse(options.error, log, { requestId })
    const buffer = await file.arrayBuffer()
    const content = decodeBuffer(buffer, detectEncoding(buffer))
    const parsed = parseSIEFile(content)
    let mappings
    if (form.get('mappings')) {
      const checked = SIEJobMappingsSchema.safeParse(JSON.parse(String(form.get('mappings'))))
      if (!checked.success) return errorResponse(checked.error, log, { requestId })
      mappings = checked.data
    } else {
      // The mappings the execute route would use without the wizard's.
      mappings = SIEJobMappingsSchema.parse(
        suggestSIEMappings(parsed, BAS_REFERENCE, await loadMappings(supabase, companyId!)).mappings)
    }
    await resolveSIEFiscalYear(supabase, companyId!, parsed)
    const plan = await planSIEAppend(supabase, companyId!, parsed, mappings, options.data)
    return NextResponse.json({ data: plan })
  } catch (error) {
    if (error instanceof SyntaxError) return errorResponseFromCode('VALIDATION_ERROR', log, { requestId })
    if (error instanceof SIEIntakeNotFoundError) {
      return errorResponseFromCode('NOT_FOUND', log, {
        requestId,
        messageSv: 'Den uppladdade SIE-filen hittades inte. Ladda upp filen igen.',
        messageEn: 'The uploaded SIE file was not found. Upload the file again.',
        details: { field: 'storagePath' },
      })
    }
    if (error instanceof SIEJobValidationError) return sieJobValidationResponse(error, log, requestId)
    return errorResponse(error, log, { requestId })
  }
})
