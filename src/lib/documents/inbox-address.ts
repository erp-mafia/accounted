import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The company's document inbox address: mail sent or forwarded here becomes
 * an inbox item (each attachment, or the mail body itself when there is none).
 *
 * One definition for every agent-facing read: the briefing,
 * gnubok_list_inbox_items, the Kvittojakten worklist and the company context
 * and Arkiv resources each composed it on their own, and the two reads an
 * agent actually calls when it looks for the address (the briefing and the
 * inbox list) did not carry it at all (crm#1174).
 *
 * Null when this install has no inbound mail domain (RESEND_INBOUND_DOMAIN)
 * or the company has no active inbox. A failed read is null too: in every
 * caller the address rides along with something else and is never a reason to
 * fail that read.
 */
export async function resolveInboxAddress(
  supabase: SupabaseClient,
  companyId: string,
): Promise<string | null> {
  const domain = process.env.RESEND_INBOUND_DOMAIN
  if (!domain) return null
  try {
    const { data, error } = await supabase
      .from('company_inboxes')
      .select('local_part')
      .eq('company_id', companyId)
      .eq('status', 'active')
      .maybeSingle()
    const localPart = (data as { local_part?: string } | null)?.local_part
    if (error || !localPart) return null
    return `${localPart}@${domain}`
  } catch {
    return null
  }
}

/**
 * The name part of an inbox address for a company name: the same slug
 * public.generate_inbox_local_part() builds before it appends the random
 * suffix (and stores as company_inboxes.slug_seed). Swedish vowels and a few
 * accents folded, lowercased, every other run of characters one hyphen, at
 * most 24 characters, `company` when nothing is left.
 */
export function inboxSlugForName(name: string | null | undefined): string {
  const fold: Record<string, string> = { å: 'a', ä: 'a', ö: 'o', é: 'e', è: 'e', ê: 'e', à: 'a', â: 'a', ü: 'u', ñ: 'n' }
  let slug = (name ?? '').toLowerCase().replace(/[åäöéèêàâüñ]/g, (ch) => fold[ch] ?? ch)
  slug = slug.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  slug = slug.slice(0, 24).replace(/-+$/, '')
  return slug || 'company'
}

/**
 * Whether an inbox address (or its local part) still carries the company's
 * current name. The address is slugged once and a rename leaves it alone on
 * purpose (suppliers already send to it), so after a rename this turns false
 * and an owner or admin can mint one with the new name (rename_company_inbox)
 * while the old one keeps receiving.
 */
export function inboxAddressCarriesName(address: string, companyName: string | null | undefined): boolean {
  const at = address.indexOf('@')
  const localPart = (at >= 0 ? address.slice(0, at) : address).split('+')[0]!
  // The stored slug_seed is the local part without its `-xxxx` suffix.
  return localPart.replace(/-[^-]+$/, '') === inboxSlugForName(companyName)
}

/**
 * The inbox address with a plus-address tag: `acme-7f3k@in.example` and
 * `lev` give `acme-7f3k+lev@in.example`. The webhook files a mail on the part
 * before the first `+`, so the tag never changes which company it reaches; it
 * only declares the kind (`lev` a supplier invoice, `ver` an underlag).
 *
 * An address without a local part is returned as is: there is nothing to tag.
 */
export function tagInboxAddress(address: string, tag: 'lev' | 'ver'): string {
  const at = address.lastIndexOf('@')
  if (at <= 0) return address
  return `${address.slice(0, at)}+${tag}${address.slice(at)}`
}
