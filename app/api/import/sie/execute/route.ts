import { after, NextResponse } from 'next/server'
import { detectEncoding, decodeBuffer, parseSIEFile } from '@/lib/import/sie-parser'
import { suggestMappings } from '@/lib/import/account-mapper'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { SIEJobMappingsSchema, SIEJobOptionsSchema } from '@/lib/api/schemas'
import { submitSIEJob } from '@/lib/import/sie-jobs'
import { runSIEWorker } from '@/lib/import/sie-job-worker'
import { SIE_LIMITS } from '@/lib/import/sie-job-contract'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { SIEAccountMappingRecord } from '@/lib/import/types'
import { readSIERequestFile } from '@/lib/import/sie-intake'

export const maxDuration = 300

/** Submit an execution; no ledger work runs before the 202 response. */
export const POST = withRouteContext('sie_import.execute', async (request,ctx) => {
  const {supabase,companyId,user,log,requestId} = ctx
  try {
    const form = await request.formData()
    const file = await readSIERequestFile(form,supabase,companyId)
    if (!(file instanceof File)) return errorResponseFromCode('SIE_PARSE_NO_FILE',log,{requestId})
    if (!/\.(sie|se|si)$/i.test(file.name)) return errorResponseFromCode('SIE_PARSE_INVALID_TYPE',log,{requestId})
    if (file.size > SIE_LIMITS.fileBytes) return errorResponseFromCode('SIE_PARSE_FILE_TOO_LARGE',log,{requestId})
    if (!file.size) return errorResponseFromCode('SIE_PARSE_EMPTY',log,{requestId})
    const options = SIEJobOptionsSchema.parse(JSON.parse(String(form.get('options') ?? '{}')))
    const buffer = await file.arrayBuffer()
    const content = decodeBuffer(buffer,detectEncoding(buffer))
    let mappings
    if (form.get('mappings')) mappings = SIEJobMappingsSchema.parse(JSON.parse(String(form.get('mappings'))))
    else {
      const stored = await fetchAllRows<SIEAccountMappingRecord>(({from,to}) => supabase.from('sie_account_mappings')
        .select('*').eq('company_id',companyId).order('source_account').range(from,to))
      mappings = SIEJobMappingsSchema.parse(suggestMappings(parseSIEFile(content).accounts,BAS_REFERENCE,stored))
    }
    const job = await submitSIEJob(supabase,companyId!,user.id,content,mappings,{...options,filename:file.name},file)
    after(async () => { await runSIEWorker({importId:job.id}) })
    return NextResponse.json({data:{importId:job.id,state:job.job_state,statusUrl:`/api/import/sie/${job.id}`}},
      {status:202,headers:{Location:`/api/import/sie/${job.id}`,'Retry-After':'2'}})
  } catch (error) {
    if (error instanceof SyntaxError) return errorResponseFromCode('VALIDATION_ERROR',log,{requestId})
    return errorResponse(error,log,{requestId})
  }
},{requireWrite:true})
