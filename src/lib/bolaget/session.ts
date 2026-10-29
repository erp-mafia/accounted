/**
 * What the dashboard's /api/bolaget routes share: the operation context from
 * a route context, the gate as a response, the company line of the PDFs,
 * and who may see a full personnummer (an owner or admin, ABL 5:5 printout).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { NextResponse } from 'next/server'
import { getCompanyRole } from '@/lib/auth/require-write'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { COMPANY_ADMIN_ROLES } from '@/lib/operations/access'
import type { OperationContext } from '@/lib/operations/types'
import type { Logger } from '@/lib/logger'
import { bolagetGate } from './gate'
import type { PdfCompany } from './pdf-data'

export interface BolagetRouteContext {
  supabase: SupabaseClient
  companyId: string
  user: { id: string }
  log: Logger
  requestId?: string
}

export function operationContext(ctx: BolagetRouteContext): OperationContext {
  return { supabase: ctx.supabase, companyId: ctx.companyId, userId: ctx.user.id, log: ctx.log }
}

/** The gate's refusal as a response, or null when the company may use the registers. */
export async function bolagetGateResponse(ctx: BolagetRouteContext): Promise<NextResponse | null> {
  const code = await bolagetGate(ctx.supabase, ctx.companyId)
  return code ? errorResponseFromCode(code, ctx.log, { requestId: ctx.requestId }) : null
}

export async function companyForPdf(supabase: SupabaseClient, companyId: string): Promise<PdfCompany> {
  const { data, error } = await supabase.from('companies').select('name, org_number').eq('id', companyId).maybeSingle()
  if (error) throw new Error(`companies read failed: ${error.message}`)
  const row = (data ?? {}) as { name?: string | null; org_number?: string | null }
  return { name: row.name?.trim() || 'Bolaget', org_number: row.org_number ?? null }
}

/** Whether the caller is an owner or admin: they print the aktiebok with full personnummer. */
export async function callerIsCompanyAdmin(supabase: SupabaseClient, userId: string, companyId: string): Promise<boolean> {
  const result = await getCompanyRole(supabase, userId, { companyId })
  return result.ok && (COMPANY_ADMIN_ROLES as readonly string[]).includes(result.role)
}
