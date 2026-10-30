/**
 * Which of the card numbers read off documents are the company's own cards.
 *
 * A receipt's card (extracted_data.payment.cardLast4) is what the vision
 * model read off a masked number, digit by digit, and it can be wrong: a
 * card ending 6776 read as 5905 (crm#1534). A read number is trusted as the
 * card that paid only when the company already knows that card:
 *   - a registered company card (cash_accounts, kind 'card', card_last4), or
 *   - a card its own bank rows name (the card token a statement prints,
 *     ./card-token.ts).
 * Any other number is a read number of an unknown card, however near a
 * known one: it is never snapped to the card it resembles. Matching does not
 * use it (./refresh.ts) and the Inkorg shows it as read, not as fact.
 *
 * Server only (a Supabase client); the pure token reading is ./card-token.ts.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { cardTokensIn, normaliseCardLast4 } from './card-token'

/** Bank rows read per card number to find the statement's own token for it. */
export const STATEMENT_ROWS_PER_CARD = 20
/**
 * Card numbers checked per read, the first ones given (a list passes its
 * newest items first); any past them counts as unknown. Prod 2026-10-30:
 * a company's inbox names 2 distinct card numbers at the median, 13 at p99.
 */
export const MAX_CARDS_CHECKED = 20

/** The card number a reading says paid it (extracted_data.payment.cardLast4), or null. */
export function readCardOf(extracted: unknown): string | null {
  const payment = (extracted as { payment?: { cardLast4?: unknown } | null } | null)?.payment
  return normaliseCardLast4(payment?.cardLast4 ?? null)
}

/** Whether the card a reading names is one of `known`; null when it names none. */
export function readCardKnown(extracted: unknown, known: ReadonlySet<string>): boolean | null {
  const card = readCardOf(extracted)
  return card === null ? null : known.has(card)
}

/** The card numbers among `cards` the company knows; throws on a failed read. */
export async function readKnownCards(
  supabase: SupabaseClient,
  companyId: string,
  cards: ReadonlyArray<unknown>,
): Promise<Set<string>> {
  const wanted = [...new Set(cards.map(normaliseCardLast4).filter((c): c is string => c !== null))].slice(0, MAX_CARDS_CHECKED)
  const known = new Set<string>()
  if (wanted.length === 0) return known

  const { data: accounts, error } = await supabase
    .from('cash_accounts')
    .select('card_last4')
    .eq('company_id', companyId)
    .eq('kind', 'card')
  if (error) throw new Error(`known cards: card account read failed: ${error.message}`)
  for (const account of (accounts ?? []) as Array<{ card_last4: string[] | null }>) {
    for (const card of account.card_last4 ?? []) {
      const digits = normaliseCardLast4(card)
      if (digits && wanted.includes(digits)) known.add(digits)
    }
  }

  // The rest: does any bank row print it as a card? The four digits narrow
  // the read; the token shape decides (an amount or an order number holding
  // the same digits is no card).
  await Promise.all(
    wanted
      .filter((card) => !known.has(card))
      .map(async (card) => {
        const { data: rows, error: rowsError } = await supabase
          .from('transactions')
          .select('merchant_name, description, original_description')
          .eq('company_id', companyId)
          .or(`merchant_name.ilike.%${card}%,description.ilike.%${card}%,original_description.ilike.%${card}%`)
          .order('date', { ascending: false })
          .limit(STATEMENT_ROWS_PER_CARD)
        if (rowsError) throw new Error(`known cards: bank row read failed: ${rowsError.message}`)
        const texts = ((rows ?? []) as Array<Record<string, string | null>>).flatMap((row) => [
          row.merchant_name,
          row.description,
          row.original_description,
        ])
        if (cardTokensIn(texts).includes(card)) known.add(card)
      }),
  )
  return known
}
