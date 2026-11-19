/**
 * The public check behind /verifiera: is this file a copy that was signed
 * through Accounted? The browser hashes the file and sends only its SHA-256;
 * we look it up as a completed request's signed copy (the archived
 * document's sha256_hash) or as the original its BankID signatures carry.
 *
 * The answer says only what the signed copy's own Signeringsbevis page
 * already prints to whoever holds the file: the title, the company, who
 * signed (their BankID name and role) and when. Never a personnummer, an
 * email or an id. An exact hash is the only key, so a lookup finds nothing
 * for anyone without the file.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export interface VerifiedSigning {
  /** The file is the signed copy, or the original document that was signed. */
  match: 'signed_copy' | 'original'
  title: string
  company_name: string
  completed_at: string
  signers: Array<{ name: string; role_label: string | null; signed_at: string }>
}

const SHA256_HEX = /^[0-9a-f]{64}$/

export function isSha256Hex(value: string): boolean {
  return SHA256_HEX.test(value)
}

interface RequestRow {
  id: string
  company_id: string
  title: string
  completed_at: string | null
}

async function completedBySignedCopy(service: SupabaseClient, sha256: string): Promise<RequestRow | null> {
  const { data: docs, error } = await service
    .from('document_attachments')
    .select('id')
    .eq('sha256_hash', sha256)
    .eq('upload_source', 'system')
    .limit(20)
  if (error) throw error
  const ids = ((docs ?? []) as Array<{ id: string }>).map((d) => d.id)
  if (ids.length === 0) return null
  const { data, error: requestError } = await service
    .from('signing_requests')
    .select('id, company_id, title, completed_at')
    .in('signed_document_id', ids)
    .eq('status', 'completed')
    .order('completed_at', { ascending: false })
    .limit(1)
  if (requestError) throw requestError
  return ((data ?? []) as RequestRow[])[0] ?? null
}

async function completedByOriginal(service: SupabaseClient, sha256: string): Promise<RequestRow | null> {
  const { data, error } = await service
    .from('signing_requests')
    .select('id, company_id, title, completed_at')
    .eq('document_sha256', sha256)
    .eq('status', 'completed')
    .order('completed_at', { ascending: false })
    .limit(1)
  if (error) throw error
  return ((data ?? []) as RequestRow[])[0] ?? null
}

/** The completed signing this file belongs to, or null. Service role: the caller has no account. */
export async function verifySignedFile(service: SupabaseClient, sha256: string): Promise<VerifiedSigning | null> {
  const hash = sha256.trim().toLowerCase()
  if (!isSha256Hex(hash)) return null
  const bySignedCopy = await completedBySignedCopy(service, hash)
  const request = bySignedCopy ?? (await completedByOriginal(service, hash))
  if (!request || !request.completed_at) return null

  const [{ data: company, error: companyError }, { data: signers, error: signersError }] = await Promise.all([
    service.from('companies').select('name').eq('id', request.company_id).maybeSingle(),
    service
      .from('signing_request_signers')
      .select('role_label, signed_at, bankid_given_name, bankid_surname')
      .eq('signing_request_id', request.id)
      .eq('status', 'signed')
      .order('position'),
  ])
  if (companyError) throw companyError
  if (signersError) throw signersError
  if (!company) return null
  return {
    match: bySignedCopy ? 'signed_copy' : 'original',
    title: request.title,
    company_name: (company as { name: string | null }).name?.trim() || 'Företaget',
    completed_at: request.completed_at,
    signers: ((signers ?? []) as Array<{ role_label: string | null; signed_at: string; bankid_given_name: string | null; bankid_surname: string | null }>).map((s) => ({
      name: [s.bankid_given_name, s.bankid_surname].filter(Boolean).join(' ').trim(),
      role_label: s.role_label,
      signed_at: s.signed_at,
    })),
  }
}
