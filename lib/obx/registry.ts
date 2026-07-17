/**
 * OBX registry / verify helpers (ADR 014).
 * Attest authenticity by hash — does not replace SoR year-seal import (ADR 013).
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type ObxRegistryCustodyEvent = {
  type: string
  at: string
  actor?: string
  note?: string
}

export type ObxRegistryPublishInput = {
  companyId: string
  userId: string
  fiscalYear: string
  manifestHash: string
  innerManifestHash?: string
  chainRoot?: string
  orgNumber?: string
  originSystem?: string
  custodyEvent?: ObxRegistryCustodyEvent
}

export type ObxRegistryRow = {
  id: string
  company_id: string
  fiscal_year: string
  manifest_hash: string
  inner_manifest_hash: string | null
  chain_root: string | null
  org_number: string | null
  origin_system: string | null
  custody_json: ObxRegistryCustodyEvent[]
  published_at: string
}

export type ObxVerifyResult = {
  status: 'VERIFIED' | 'NOT_FOUND' | 'MISMATCH'
  match?: ObxRegistryRow
  message: string
}

export async function publishToObxRegistry(
  supabase: SupabaseClient,
  input: ObxRegistryPublishInput,
): Promise<ObxRegistryRow> {
  const custody: ObxRegistryCustodyEvent[] = []
  if (input.custodyEvent) custody.push(input.custodyEvent)

  const { data: existing } = await supabase
    .from('company_obx_registry')
    .select('id, custody_json')
    .eq('company_id', input.companyId)
    .eq('fiscal_year', input.fiscalYear)
    .eq('manifest_hash', input.manifestHash)
    .maybeSingle()

  const mergedCustody = Array.isArray(existing?.custody_json)
    ? [...(existing.custody_json as ObxRegistryCustodyEvent[]), ...custody]
    : custody

  if (existing?.id) {
    const { data, error } = await supabase
      .from('company_obx_registry')
      .update({
        inner_manifest_hash: input.innerManifestHash ?? null,
        chain_root: input.chainRoot ?? null,
        org_number: input.orgNumber ?? null,
        origin_system: input.originSystem ?? null,
        custody_json: mergedCustody,
        published_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .select('*')
      .single()
    if (error) throw new Error(error.message)
    return data as ObxRegistryRow
  }

  const { data, error } = await supabase
    .from('company_obx_registry')
    .insert({
      company_id: input.companyId,
      user_id: input.userId,
      fiscal_year: input.fiscalYear,
      manifest_hash: input.manifestHash,
      inner_manifest_hash: input.innerManifestHash ?? null,
      chain_root: input.chainRoot ?? null,
      org_number: input.orgNumber ?? null,
      origin_system: input.originSystem ?? null,
      custody_json: mergedCustody,
    })
    .select('*')
    .single()

  if (error) throw new Error(error.message)
  return data as ObxRegistryRow
}

export async function verifyAgainstObxRegistry(
  supabase: SupabaseClient,
  input: {
    companyId?: string
    manifestHash?: string
    innerManifestHash?: string
    fiscalYear?: string
  },
): Promise<ObxVerifyResult> {
  const hash = input.innerManifestHash ?? input.manifestHash
  if (!hash) {
    return { status: 'NOT_FOUND', message: 'No hash provided' }
  }

  let query = supabase.from('company_obx_registry').select('*').limit(5)

  if (input.companyId) query = query.eq('company_id', input.companyId)
  if (input.fiscalYear) query = query.eq('fiscal_year', input.fiscalYear)

  if (input.innerManifestHash) {
    query = query.eq('inner_manifest_hash', input.innerManifestHash)
  } else if (input.manifestHash) {
    query = query.eq('manifest_hash', input.manifestHash)
  }

  const { data, error } = await query
  if (error) throw new Error(error.message)

  const rows = (data ?? []) as ObxRegistryRow[]
  if (rows.length === 0) {
    return { status: 'NOT_FOUND', message: 'No registry entry matches the hash' }
  }

  return {
    status: 'VERIFIED',
    match: rows[0],
    message: 'Hash matches hosted OBX registry',
  }
}
