import { normalizeCounterpartyName } from '@/lib/bookkeeping/counterparty-templates'

/**
 * The bank side of a counterparty, for the graph: one key per merchant no
 * matter how the bank spelled it this month. Built on the mapping engine's
 * normaliser and then stripped of what a bank statement adds around a name
 * (card numbers, "Kortköp", "Autogiro", references) and of legal suffixes,
 * so "ALMI FÖRETAG Autogiro" and "ALMI FÖRETAG" are one node, and a party
 * called "Higgsfield Inc." is the same counterpart as the card text
 * "HIGGSFIELD". Never a match the resolver would refuse: the key is exact,
 * not fuzzy.
 */
const NOISE = new Set(['kortköp', 'kortkop', 'autogiro', 'pris', 'betalning', 'betalningar', 'faktura', 'swish', 'kontaktlös', 'contactless', 'sub', 'subscr', 'subscription', 'payment', 'ref'])
const LEGAL = new Set(['ab', 'aktiebolag', 'hb', 'kb', 'inc', 'ltd', 'llc', 'pbc', 'bv', 'b.v', 'gmbh', 'oy', 'as', 'aps', 'sa', 'srl', 'corp', 'co', 'plc', 'limited'])

export function merchantKey(raw: string | null | undefined): string {
  if (!raw) return ''
  const words = normalizeCounterpartyName(raw)
    .split(/\s+/)
    .map((w) => w.replace(/[.,*/]+$/g, ''))
    .filter((w) => w.length > 0)
    .filter((w) => !/^\d+$/.test(w))
    .filter((w) => !/^k\d{3,6}$/.test(w))
    .filter((w) => !NOISE.has(w))
  while (words.length > 1 && LEGAL.has(words[words.length - 1])) words.pop()
  return words.join(' ')
}

/** What the node is called: the cleaned key, each word capitalised, except an all-caps acronym kept short. */
export function merchantLabel(raw: string | null | undefined): string {
  const key = merchantKey(raw)
  return key
    .split(' ')
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
}
