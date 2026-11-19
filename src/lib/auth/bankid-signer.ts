/**
 * The person who signs at a bank with BankID: a payment (lib/payments/orders)
 * today, and the bank consents of the connection layer when they land.
 *
 * The bank needs the signer's personnummer to know whose BankID to expect. It
 * comes from the person's own BankID login (bankid_identities) when they have
 * one, else from the number they typed once and the bank accepted
 * (payment_signers, remembered after the first successful signing start),
 * else from what they type now. It is never stored on an order or a
 * connection, and never logged.
 */

import { decryptStoredPersonalNumber, encryptPersonalNumberForStorage } from '@/lib/auth/bankid'
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

/** The personnummer the person signed with before and the bank accepted, or null. */
export async function rememberedSignerPersonalNumber(userId: string): Promise<string | null> {
  try {
    const { data } = await createServiceClient().from('payment_signers').select('personal_number_enc').eq('user_id', userId).maybeSingle()
    const stored = (data as { personal_number_enc?: unknown } | null)?.personal_number_enc
    if (!stored) return null
    return normalizeSignerPersonalNumber(decryptStoredPersonalNumber(stored as string))
  } catch {
    return null
  }
}

/** The signer's personnummer on file: the BankID login first, else the remembered one. */
export async function signerPersonalNumberOnFile(userId: string): Promise<string | null> {
  return (await signerPersonalNumberFromBankIdLogin(userId)) ?? (await rememberedSignerPersonalNumber(userId))
}

/** Whether the person has a BankID login on file. */
export async function hasBankIdLogin(userId: string): Promise<boolean> {
  try {
    const { data } = await createServiceClient().from('bankid_identities').select('user_id').eq('user_id', userId).maybeSingle()
    return Boolean(data)
  } catch {
    return false
  }
}

/** Whether a signer's personnummer is on file (login or remembered), so signing needs no typed one. */
export async function hasSignerOnFile(userId: string): Promise<boolean> {
  if (await hasBankIdLogin(userId)) return true
  try {
    const { data } = await createServiceClient().from('payment_signers').select('user_id').eq('user_id', userId).maybeSingle()
    return Boolean(data)
  } catch {
    return false
  }
}

/**
 * Remember the number the person typed, once the bank accepted a signing start
 * with it: the next payment asks for nothing. Encrypted like the BankID login.
 */
export async function rememberSignerPersonalNumber(userId: string, personalNumber: string): Promise<void> {
  const normalized = normalizeSignerPersonalNumber(personalNumber)
  if (!normalized) return
  const { error } = await createServiceClient()
    .from('payment_signers')
    .upsert({ user_id: userId, personal_number_enc: encryptPersonalNumberForStorage(normalized), updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
  if (error) throw error
}
