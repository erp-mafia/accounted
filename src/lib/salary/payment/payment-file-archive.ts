/**
 * The archived salary payment files of a run: every file the payment-file
 * builder (build-payment-file.ts) handed out, as the immutable
 * salary_payment_files row it wrote first (BFL 7 kap. 1 §, seven-year
 * retention). A regeneration adds a row and never rewrites one, so the list
 * is the record of what went to the bank.
 *
 * Shared by the v1 list route (GET /salary-runs/{id}/payment-files) and the
 * MCP operation (lib/operations/salary-payment-files.ts). Newest first, keyset
 * paginated on (generated_at, id) with the default v1 cursor.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { decodeDefaultCursor, encodeDefaultCursor } from '@/lib/api/v1/pagination'
import type { SalaryPaymentFileFormat } from './build-payment-file'

export interface ArchivedSalaryPaymentFile {
  /** Id of the archived row (the payment_file_id the generate call returned). */
  payment_file_id: string
  format: SalaryPaymentFileFormat
  filename: string
  content_type: 'application/xml' | 'text/plain'
  /** Encoding of `content` as downloaded; sha256 and byte_size are over those bytes. */
  charset: 'utf-8' | 'iso-8859-1'
  sha256: string
  byte_size: number
  payment_date: string
  /** Employees with a positive net payout (credit transfers in the file). */
  employee_count: number
  total_amount: number
  generated_at: string
  /** The file exactly as generated. */
  content: string
}

export type ListSalaryPaymentFilesResult =
  | { ok: true; files: ArchivedSalaryPaymentFile[]; nextCursor: string | null }
  | { ok: false; code: 'RUN_NOT_FOUND' }
  /** The database error itself: its SQLSTATE decides the answer. */
  | { ok: false; code: 'DB_ERROR'; cause: unknown }

type Row = {
  id: string
  format: SalaryPaymentFileFormat
  filename: string
  content_type: 'application/xml' | 'text/plain'
  charset: 'utf-8' | 'iso-8859-1'
  sha256: string
  byte_size: number
  payment_date: string
  employee_count: number
  total_amount: number | string
  generated_at: string
  content: string
}

export async function listSalaryPaymentFiles(
  supabase: SupabaseClient,
  input: { companyId: string; salaryRunId: string; limit: number; cursor?: string | null },
): Promise<ListSalaryPaymentFilesResult> {
  // The run itself first, so an empty list unambiguously means "run exists,
  // no file generated yet".
  const { data: run, error: runErr } = await supabase
    .from('salary_runs')
    .select('id')
    .eq('company_id', input.companyId)
    .eq('id', input.salaryRunId)
    .maybeSingle()
  if (runErr) return { ok: false, code: 'DB_ERROR', cause: runErr }
  if (!run) return { ok: false, code: 'RUN_NOT_FOUND' }

  // The default cursor carries (created_at, id); here the timestamp is
  // generated_at, the archive row's only clock.
  const decoded = decodeDefaultCursor(input.cursor)

  // Explicit projection: never SELECT *. One literal so the phantom-column
  // guard (tests/schema) can check every name against the migration.
  let query = supabase
    .from('salary_payment_files')
    .select('id, format, filename, content_type, charset, sha256, byte_size, payment_date, employee_count, total_amount, generated_at, content')
    .eq('company_id', input.companyId)
    .eq('salary_run_id', input.salaryRunId)
    .order('generated_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(input.limit + 1)

  if (decoded) {
    query = query.or(
      `generated_at.lt.${decoded.ts},and(generated_at.eq.${decoded.ts},id.lt.${decoded.id})`,
    )
  }

  const { data, error } = await query
  if (error) return { ok: false, code: 'DB_ERROR', cause: error }

  const rows = ((data ?? []) as unknown) as Row[]
  const trimmed = rows.slice(0, input.limit)
  const last = trimmed[trimmed.length - 1]
  const nextCursor = rows.length > input.limit && last
    ? encodeDefaultCursor({ id: last.id, created_at: last.generated_at })
    : null

  return {
    ok: true,
    nextCursor,
    files: trimmed.map((r) => ({
      payment_file_id: r.id,
      format: r.format,
      filename: r.filename,
      content_type: r.content_type,
      charset: r.charset,
      sha256: r.sha256,
      byte_size: r.byte_size,
      payment_date: r.payment_date,
      employee_count: r.employee_count,
      // PostgREST may serialize numeric as a string on some stacks.
      total_amount: Number(r.total_amount),
      generated_at: r.generated_at,
      content: r.content,
    })),
  }
}
