import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { SubledgerImportSchema } from '@/lib/import/subledger/schema'
import { parseSubledgerFile } from '@/lib/import/subledger/parser'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

/** Preview and execute share validation; the RPC revalidates every tenant link. */
export const POST = withRouteContext('import.subledger', async (request, ctx) => {
  let input: unknown
  try {
    if (request.headers.get('content-type')?.includes('multipart/form-data')) {
      const form = await request.formData()
      const file = form.get('file')
      if (!(file instanceof File) || file.size > 10 * 1024 * 1024) {
        return errorResponseFromCode('SUBLEDGER_FILE_INVALID', ctx.log, { requestId: ctx.requestId })
      }
      input = {
        company_id: form.get('company_id'), kind: form.get('kind'),
        snapshot_date: form.get('snapshot_date'),
        rows: parseSubledgerFile(await file.arrayBuffer(), file.name),
        execute: false,
      }
    } else {
      input = await request.json()
    }
  } catch (error) {
    const match = error instanceof Error ? /^SUBLEDGER_ROW_INVALID:(\d+)$/.exec(error.message) : null
    if (match) return errorResponseFromCode('SUBLEDGER_ROW_INVALID', ctx.log, { requestId: ctx.requestId, details: { row: Number(match[1]) } })
    return errorResponseFromCode('SUBLEDGER_FILE_INVALID', ctx.log, { requestId: ctx.requestId })
  }
  const parsed = SubledgerImportSchema.safeParse(input)
  if (!parsed.success) {
    return errorResponseFromCode('SUBLEDGER_INPUT_INVALID', ctx.log, { requestId: ctx.requestId })
  }
  const { company_id, kind, snapshot_date, rows, execute, preview_token } = parsed.data
  if (company_id !== ctx.companyId) {
    return errorResponseFromCode('SUBLEDGER_COMPANY_CHANGED', ctx.log, { requestId: ctx.requestId })
  }
  const { data, error } = await ctx.supabase.rpc('import_file_subledger', {
    p_company_id: ctx.companyId, p_kind: kind, p_snapshot_date: snapshot_date,
    p_rows: rows, p_execute: execute, p_preview_token: preview_token ?? null,
  })
  if (error) {
    const code = error.message.split(':')[0]
    const safeCode = /^SUBLEDGER_[A-Z_]+$/.test(code) ? code : 'SUBLEDGER_FAILED'
    return errorResponseFromCode(safeCode, ctx.log, {
      requestId: ctx.requestId,
      details: { row: /^\d+$/.test(error.message.split(':')[1] ?? '') ? Number(error.message.split(':')[1]) : undefined },
    })
  }
  return NextResponse.json({ data: { ...data, source_rows: rows } })
}, { requireWrite: true })
