/**
 * A meeting follows its BankID signing request on read (the pattern of the
 * stock count, lib/bokslut/stock-count/signing.ts): a completed request
 * applies the elections to the roles and signs the minutes; a declined,
 * cancelled or expired one opens them again. A later read fills in the
 * sealed copy if the seal was still running. A write the reader may not
 * make (a viewer) leaves the meeting as it was for the next writer's read.
 */
import { createLogger } from '@/lib/logger'
import type { OperationContext } from '@/lib/operations/types'
import { applyRegisterEffects } from './effects'
import { afterMeetingChange, loadDecisionRecords, loadMeetingRecord } from './store'
import type { MeetingRecord } from './types'

const log = createLogger('bolaget/meetings/signing')

interface RequestState {
  status: 'open' | 'completed' | 'declined' | 'cancelled'
  expires_at: string
  completed_at: string | null
  signed_document_id: string | null
}

export async function syncMeetingSigning(ctx: OperationContext, record: MeetingRecord): Promise<MeetingRecord> {
  if (!record.signing_request_id) return record
  if (record.status === 'signed' && record.signed_document_id) return record

  const { data, error } = await ctx.supabase
    .from('signing_requests')
    .select('status, expires_at, completed_at, signed_document_id')
    .eq('company_id', ctx.companyId)
    .eq('id', record.signing_request_id)
    .maybeSingle()
  if (error) {
    log.warn('signing request unreadable for the meeting', { meetingId: record.id, message: error.message })
    return record
  }
  const request = data as RequestState | null

  if (request?.status === 'completed') {
    if (record.status === 'held') {
      const decisions = await loadDecisionRecords(ctx.supabase, ctx.companyId, record.id)
      const applied = await applyRegisterEffects(ctx, record, decisions)
      if (!applied.ok) {
        log.warn('roles not updated from the signed minutes; the meeting stays held', { meetingId: record.id, code: applied.code })
        return record
      }
      const { data: signers } = await ctx.supabase
        .from('signing_request_signers')
        .select('name, bankid_given_name, bankid_surname, position')
        .eq('company_id', ctx.companyId)
        .eq('signing_request_id', record.signing_request_id)
        .order('position', { ascending: true })
      const names = ((signers ?? []) as Array<{ name: string; bankid_given_name: string | null; bankid_surname: string | null }>)
        .map((s) => [s.bankid_given_name, s.bankid_surname].filter(Boolean).join(' ').trim() || s.name)
        .join(', ')
      const { data: updated, error: updateError } = await ctx.supabase
        .from('corporate_meetings')
        .update({
          status: 'signed',
          signed_at: request.completed_at ?? new Date().toISOString(),
          signature_names: names.slice(0, 1000) || null,
          signed_document_id: request.signed_document_id,
        })
        .eq('company_id', ctx.companyId)
        .eq('id', record.id)
        .eq('status', 'held')
        .select('id')
        .maybeSingle()
      if (updateError || !updated) {
        if (updateError) log.warn('meeting not signed from its request', { meetingId: record.id, message: updateError.message })
        return record
      }
      await afterMeetingChange(ctx, record.id)
    } else if (request.signed_document_id) {
      const { error: copyError } = await ctx.supabase
        .from('corporate_meetings')
        .update({ signed_document_id: request.signed_document_id })
        .eq('company_id', ctx.companyId)
        .eq('id', record.id)
        .is('signed_document_id', null)
      if (copyError) log.warn('signed copy not filled in', { meetingId: record.id, message: copyError.message })
    } else {
      return record
    }
  } else if (record.status === 'held') {
    const expired = request?.status === 'open' && new Date(request.expires_at).getTime() <= Date.now()
    if (request && request.status === 'open' && !expired) return record
    const { error: clearError } = await ctx.supabase
      .from('corporate_meetings')
      .update({ signing_request_id: null })
      .eq('company_id', ctx.companyId)
      .eq('id', record.id)
      .eq('status', 'held')
    if (clearError) {
      log.warn('ended signing request not cleared', { meetingId: record.id, message: clearError.message })
      return record
    }
  } else {
    return record
  }
  return (await loadMeetingRecord(ctx.supabase, ctx.companyId, record.id)) ?? record
}
