/**
 * The PSU-ID a bank resource was created with, kept so every later call to
 * the same resource sends it again.
 *
 * Open Payments (written answer, 2026-10-14): when a consent or a payment was
 * created with a personnummer as PSU-ID, several banks require the same PSU-ID
 * on every later call to it (accounts, transactions and balances under the
 * consent, a payment's status in a decoupled flow, a cancel). The number on
 * file for the connection's owner is not that number when an e-mail-login
 * person typed theirs, or when a firmatecknare signed through a link; a
 * payment status read had none at all.
 *
 *   - bank_connection_psus: the number an Open Payments connection's current
 *     consent was created with, upserted whenever a consent is created for
 *     the row.
 *   - payment_batch_psus: the number a signing's payments were created with.
 *
 * Encrypted with the BankID key as payment_signers holds it; read and written
 * by the service role only. Nothing here ever logs a personnummer: a stored
 * value that cannot be read or decrypted is one warn line without it, and the
 * caller falls back to what it did before (the number on file, or none).
 */

import { decryptStoredPersonalNumber, encryptPersonalNumberForStorage } from '@/lib/auth/bankid'
import { normalizeSignerPersonalNumber } from '@/lib/auth/bankid-signer'
import { createLogger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/server'

/** Where a connection's number came from when its consent was created. */
export type ConnectionPsuSource = 'typed' | 'on_file' | 'signatory_link'

export interface StoredConnectionPsu {
  personalNumber: string
  source: ConnectionPsuSource
}

const log = createLogger('resource-psu')

const SOURCES: ReadonlySet<string> = new Set(['typed', 'on_file', 'signatory_link'])

/** A database error's own message (never a value from the row). */
function messageOf(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' ? message : 'unknown'
}

function decrypted(stored: unknown, what: 'connection' | 'batch', id: string): string | null {
  if (typeof stored !== 'string' || stored.length === 0) return null
  try {
    const number = normalizeSignerPersonalNumber(decryptStoredPersonalNumber(stored))
    if (number) return number
  } catch {
    // Falls through to the warn line below.
  }
  log.warn('stored PSU-ID could not be decrypted; falling back', { [what === 'connection' ? 'connectionId' : 'batchId']: id })
  return null
}

/** The number the connection's consent was created with, or null when none is stored (or it cannot be read). */
export async function storedConnectionPsu(connectionId: string): Promise<StoredConnectionPsu | null> {
  try {
    const { data, error } = await createServiceClient()
      .from('bank_connection_psus')
      .select('psu_id_enc, source')
      .eq('connection_id', connectionId)
      .maybeSingle()
    if (error) throw error
    const row = data as { psu_id_enc?: unknown; source?: unknown } | null
    if (!row) return null
    const personalNumber = decrypted(row.psu_id_enc, 'connection', connectionId)
    if (!personalNumber) return null
    const source = typeof row.source === 'string' && SOURCES.has(row.source) ? (row.source as ConnectionPsuSource) : 'typed'
    return { personalNumber, source }
  } catch (error) {
    log.warn('stored PSU-ID could not be read; falling back', { connectionId, message: messageOf(error) })
    return null
  }
}

/**
 * Keep the number a consent for the connection was just created with. A new
 * consent for the same row (a restart that had to create one, Svea's second
 * consent) overwrites. Best effort: a failed write leaves the later calls on
 * the number on file, as before, and never fails the consent.
 */
export async function rememberConnectionPsu(input: {
  connectionId: string
  companyId: string
  personalNumber: string | null
  source: ConnectionPsuSource
}): Promise<void> {
  const normalized = normalizeSignerPersonalNumber(input.personalNumber)
  if (!normalized) return
  try {
    const { error } = await createServiceClient()
      .from('bank_connection_psus')
      .upsert(
        {
          connection_id: input.connectionId,
          company_id: input.companyId,
          psu_id_enc: encryptPersonalNumberForStorage(normalized),
          source: input.source,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'connection_id' },
      )
    if (error) throw error
  } catch (error) {
    log.warn('PSU-ID of a bank consent not stored', { connectionId: input.connectionId, message: messageOf(error) })
  }
}

/** The number the signing's payments were created with, or null when none is stored (or it cannot be read). */
export async function storedBatchPsu(batchId: string): Promise<string | null> {
  try {
    const { data, error } = await createServiceClient()
      .from('payment_batch_psus')
      .select('psu_id_enc')
      .eq('batch_id', batchId)
      .maybeSingle()
    if (error) throw error
    const row = data as { psu_id_enc?: unknown } | null
    return row ? decrypted(row.psu_id_enc, 'batch', batchId) : null
  } catch (error) {
    log.warn('stored PSU-ID could not be read; falling back', { batchId, message: messageOf(error) })
    return null
  }
}

/** Keep the number a signing's payments were created with. Best effort, like rememberConnectionPsu. */
export async function rememberBatchPsu(input: { batchId: string; companyId: string; personalNumber: string | null }): Promise<void> {
  const normalized = normalizeSignerPersonalNumber(input.personalNumber)
  if (!normalized) return
  try {
    const { error } = await createServiceClient()
      .from('payment_batch_psus')
      .upsert(
        { batch_id: input.batchId, company_id: input.companyId, psu_id_enc: encryptPersonalNumberForStorage(normalized) },
        { onConflict: 'batch_id' },
      )
    if (error) throw error
  } catch (error) {
    log.warn('PSU-ID of a payment signing not stored', { batchId: input.batchId, message: messageOf(error) })
  }
}
