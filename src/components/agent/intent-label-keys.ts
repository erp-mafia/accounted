/**
 * The agent_chat message key that names a conversation by its intent, for
 * the surfaces that read the user's language (an untitled conversation's
 * title on /chat/[id]). The same intents as INTENT_LABELS in
 * conversation-display.ts, whose Swedish intentLabel the sidebar and the
 * sheet still read without a translator; intent-label-keys.test.ts keeps the
 * two saying the same thing until those surfaces pass one.
 */
// Null-prototype for the same reason as INTENT_LABELS: intent_id comes from
// the database, and 'toString' must not resolve to a function.
export const INTENT_LABEL_KEYS: Readonly<Record<string, string>> = Object.assign(Object.create(null), {
  'transaction.categorization': 'intent_transaction',
  'invoice.draft': 'intent_invoice',
  'supplier_invoice.review': 'intent_supplier_invoice',
  'vat.review': 'intent_vat_review',
  'bokslut.step': 'intent_bokslut',
  'verifikation.draft': 'intent_verifikation',
  'kpi.explain': 'intent_kpi',
  'settings.help': 'intent_settings',
  'inbox.bulk-book': 'intent_inbox_bulk_book',
})

/** The key of an intent's name; general help and an unknown intent get the general one, never the id. */
export function intentLabelKey(intentId: string): string {
  return INTENT_LABEL_KEYS[intentId] ?? 'intent_general'
}
