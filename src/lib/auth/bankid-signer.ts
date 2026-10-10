/**
 * The person who signs at a bank with BankID: a payment (lib/payments/orders)
 * today, and the bank consents of the connection layer when they land.
 *
 * The bank needs the signer's personnummer to know whose BankID to expect. It
 * comes from the person's own BankID login (bankid_identities) when they have
 * one, else from what they typed; it is never stored on an order or a
 * connection, and never logged.
 */

import { decryptStoredPersonalNumber } from '@/lib/auth/bankid'
import { expandPersonnummerTo12, validatePersonnummer } from '@/lib/salary/personnummer-format'
import { createServiceClient } from '@/lib/supabase/server'

/** A personnummer as the 12 digits (YYYYMMDDNNNN) a bank expects, or null when it is not a valid one. */
export function normalizeSignerPersonalNumber(raw: string | null | undefined): string | null {
  if (!raw) return null
  const full = expandPersonnummerTo12(raw)
  return full && validatePersonnummer(full).valid ? full : null
}

/** The personnummer from the person's BankID login, or null when they have none. */
export async function signerPersonalNumberFromBankIdLogin(userId: string): Promise<string | null> {
  try {
    const { data } = await createServiceClient()
      .from('bankid_identities')
      .select('personal_number_enc')
      .eq('user_id', userId)
      .maybeSingle()
    const stored = (data as { personal_number_enc?: unknown } | null)?.personal_number_enc
    if (!stored) return null
    return normalizeSignerPersonalNumber(decryptStoredPersonalNumber(stored as string))
  } catch {
    return null
  }
}

/** Whether the person has a BankID login on file, so signing needs no typed personnummer. */
export async function hasBankIdLogin(userId: string): Promise<boolean> {
  try {
    const { data } = await createServiceClient().from('bankid_identities').select('user_id').eq('user_id', userId).maybeSingle()
    return Boolean(data)
  } catch {
    return false
  }
}
