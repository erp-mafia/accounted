import type { SupabaseClient } from '@supabase/supabase-js'
import type { ReconciliationAttachment } from './schemas'

/**
 * The account_reconciliation_attachments table, read and written in one
 * place. Pure storage rows: the file bytes live in Supabase Storage and are
 * handled by attachments.ts, so the pärm and the archive can list underlag
 * without touching the bucket.
 */

const COLUMNS =
  'id, account_key, through_date, file_name, mime_type, size_bytes, storage_bucket, storage_path, sha256, note, uploaded_by, uploaded_at, removed_at, removed_by, removed_reason'

export interface AttachmentRow extends ReconciliationAttachment {
  storage_bucket: string
  storage_path: string
}

function mapRow(row: Record<string, unknown>): AttachmentRow {
  return {
    id: row.id as string,
    account_key: row.account_key as string,
    through_date: row.through_date as string,
    file_name: row.file_name as string,
    mime_type: row.mime_type as string,
    size_bytes: Number(row.size_bytes ?? 0),
    storage_bucket: row.storage_bucket as string,
    storage_path: row.storage_path as string,
    sha256: row.sha256 as string,
    note: (row.note as string | null) ?? null,
    uploaded_by: row.uploaded_by as string,
    uploaded_at: row.uploaded_at as string,
    removed_at: (row.removed_at as string | null) ?? null,
    removed_by: (row.removed_by as string | null) ?? null,
    removed_reason: (row.removed_reason as string | null) ?? null,
  }
}

/** The public shape: no bucket or path (those are served through the file route). */
export function toPublicAttachment(row: AttachmentRow): ReconciliationAttachment {
  const { storage_bucket: _bucket, storage_path: _path, ...rest } = row
  void _bucket
  void _path
  return rest
}

export interface ListAttachmentsOptions {
  includeRemoved?: boolean
}

/** Files for one account and balansdag, oldest first (the order they were attached). */
export async function listAttachmentRows(
  supabase: SupabaseClient,
  companyId: string,
  accountKey: string,
  throughDate: string,
  options: ListAttachmentsOptions = {},
): Promise<AttachmentRow[]> {
  let query = supabase
    .from('account_reconciliation_attachments')
    .select(COLUMNS)
    .eq('company_id', companyId)
    .eq('account_key', accountKey)
    .eq('through_date', throughDate)
    .order('uploaded_at', { ascending: true })
  if (!options.includeRemoved) query = query.is('removed_at', null)
  const { data, error } = await query
  if (error) throw new Error(`Kunde inte hämta underlag: ${error.message}`)
  return ((data ?? []) as Record<string, unknown>[]).map(mapRow)
}

/** Every active file with a balansdag inside [from, to], for the pärm and the archive. */
export async function listAttachmentRowsInRange(
  supabase: SupabaseClient,
  companyId: string,
  from: string,
  to: string,
  options: ListAttachmentsOptions = {},
): Promise<AttachmentRow[]> {
  let query = supabase
    .from('account_reconciliation_attachments')
    .select(COLUMNS)
    .eq('company_id', companyId)
    .gte('through_date', from)
    .lte('through_date', to)
    .order('account_key', { ascending: true })
    .order('through_date', { ascending: true })
    .order('uploaded_at', { ascending: true })
    .limit(2000)
  if (!options.includeRemoved) query = query.is('removed_at', null)
  const { data, error } = await query
  if (error) throw new Error(`Kunde inte hämta underlag: ${error.message}`)
  return ((data ?? []) as Record<string, unknown>[]).map(mapRow)
}

export async function getAttachmentRow(
  supabase: SupabaseClient,
  companyId: string,
  accountKey: string,
  attachmentId: string,
): Promise<AttachmentRow | null> {
  const { data, error } = await supabase
    .from('account_reconciliation_attachments')
    .select(COLUMNS)
    .eq('company_id', companyId)
    .eq('account_key', accountKey)
    .eq('id', attachmentId)
    .maybeSingle()
  if (error) throw new Error(`Kunde inte hämta underlag: ${error.message}`)
  return data ? mapRow(data as Record<string, unknown>) : null
}

export interface InsertAttachmentInput {
  account_key: string
  through_date: string
  file_name: string
  mime_type: string
  size_bytes: number
  storage_bucket: string
  storage_path: string
  sha256: string
  note: string | null
  uploaded_by: string
}

export async function insertAttachmentRow(
  supabase: SupabaseClient,
  companyId: string,
  input: InsertAttachmentInput,
): Promise<AttachmentRow> {
  const { data, error } = await supabase
    .from('account_reconciliation_attachments')
    .insert({ company_id: companyId, ...input })
    .select(COLUMNS)
    .single()
  if (error) throw new Error(`Kunde inte spara underlag: ${error.message}`)
  return mapRow(data as Record<string, unknown>)
}

/** Removal is a stamp; the row and the file stay (BFL 7 kap.). Null when already removed or missing. */
export async function stampAttachmentRemoved(
  supabase: SupabaseClient,
  companyId: string,
  attachmentId: string,
  input: { removed_by: string; reason: string | null },
): Promise<AttachmentRow | null> {
  const { data, error } = await supabase
    .from('account_reconciliation_attachments')
    .update({ removed_at: new Date().toISOString(), removed_by: input.removed_by, removed_reason: input.reason })
    .eq('company_id', companyId)
    .eq('id', attachmentId)
    .is('removed_at', null)
    .select(COLUMNS)
    .maybeSingle()
  if (error) throw new Error(`Kunde inte ta bort underlag: ${error.message}`)
  return data ? mapRow(data as Record<string, unknown>) : null
}
