/**
 * The Att göra rows that are a count and a place to go: which exist for a
 * given set of worklist counts, in which group, where they lead and how many
 * things each stands for. Pure, so the mapping from counts to rows is tested
 * without rendering; AttGoraSection adds the words and the icons, and builds
 * the rows that carry data of their own (an invoice, a person, a document).
 */

import type { WorklistCategory } from '@/lib/worklist/types'
import { attestRemainder, type NeedGroup } from './need-model'
import type { StepItemsKind } from './StepItems'

export interface CountRowSpec {
  key: string
  group: NeedGroup
  href: string
  /** The number the row shows. */
  count: number
  /** What it adds to the headline: 0 for a row whose things another row already counts. */
  things: number
  /** dashboard.<labelKey> and, when present, dashboard.<hintKey>. */
  labelKey: string
  hintKey?: string
  /** The worklist category behind it (the AI action reads it). */
  category?: WorklistCategory
  /**
   * What its Börja step lists (StepItems): the items behind the count. Absent
   * for the two rows whose items have no single bounded read (the accounts to
   * reconcile, what Arkiv noticed): their step shows the count and the way in.
   */
  items?: StepItemsKind
  /** What the earliest date of those items is: when the oldest came in, or when the first falls due. */
  earliest?: 'oldest' | 'due'
}

export interface CountRowInput {
  counts: Record<WorklistCategory, number>
  /** The Dokumentinkorg is a paid surface: its row shows only with it. */
  hasAi: boolean
  /** Where the company's inbox lives. */
  inboxHref: string
  /** Several-invoice matches that have rows of their own. */
  invoiceSetRows: number
  /** Attest rows of the signed-in person, shown one per invoice. */
  personAttestRows: number
  /** The company's open questions (lib/questions); 0 where the question list is not switched on. */
  openQuestions?: number
}

export function countRowSpecs({ counts, hasAi, inboxHref, invoiceSetRows, personAttestRows, openQuestions = 0 }: CountRowInput): CountRowSpec[] {
  const specs: CountRowSpec[] = []
  const add = (count: number, spec: Omit<CountRowSpec, 'count' | 'things'> & { things?: number }) => {
    if (count > 0) specs.push({ ...spec, count, things: spec.things ?? count })
  }
  const n = (category: WorklistCategory) => Math.max(0, counts[category] ?? 0)

  add(attestRemainder(n('supplier_invoice_approval'), personAttestRows), {
    key: 'supplier-approval', items: 'attest', earliest: 'due', group: 'attest', href: '/supplier-invoices?tab=registered', labelKey: 'row_supplier_approval', category: 'supplier_invoice_approval',
  })

  add(n('book_transaction'), {
    key: 'book-transactions', items: 'bank_rows', earliest: 'oldest', group: 'book', href: '/transactions?view=inbox', labelKey: 'row_book_transactions', category: 'book_transaction',
  })
  add(n('book_skattekonto'), {
    key: 'book-skattekonto', items: 'skattekonto', earliest: 'oldest', group: 'book', href: '/transactions?source=skatteverket&view=inbox', labelKey: 'row_book_skattekonto', category: 'book_skattekonto',
  })
  // The single-invoice matches: among the transactions to book already.
  add(Math.max(0, n('suggested_match') - Math.max(0, invoiceSetRows)), {
    key: 'suggested-matches', items: 'matches', earliest: 'oldest', group: 'book', href: '/transactions', labelKey: 'row_suggested_matches', things: 0,
  })
  add(hasAi ? n('inbox_document') : 0, {
    key: 'inbox-documents', items: 'inbox', earliest: 'oldest', group: 'book', href: inboxHref, labelKey: 'row_inbox_documents', hintKey: 'row_inbox_documents_detail', category: 'inbox_document',
  })
  add(n('collection_settlements_to_book'), {
    key: 'collection-settlements', items: 'settlements', earliest: 'oldest', group: 'book', href: '/invoices/settlements', labelKey: 'row_collection_settlements_to_book', hintKey: 'row_collection_settlements_to_book_detail',
  })
  add(n('collected_payments_to_book'), {
    key: 'collected-payments', items: 'collected_payments', earliest: 'oldest', group: 'book', href: '/invoices/settlements', labelKey: 'row_collected_payments_to_book', hintKey: 'row_collected_payments_to_book_detail',
  })

  add(n('collection_decision'), {
    key: 'collection-decision', items: 'collection_decision', group: 'decide', href: '/invoices?status=collections', labelKey: 'row_collection_decision', hintKey: 'row_collection_decision_detail',
  })

  // The question list is one place to go, whatever the number of questions.
  add(Math.max(0, Math.floor(openQuestions)), {
    key: 'company-questions', group: 'decide', href: '/questions', labelKey: 'row_company_questions', things: 1,
  })

  add(n('document_relevance'), {
    key: 'document-relevance', items: 'held_documents', earliest: 'oldest', group: 'review', href: '/arkiv', labelKey: 'row_document_relevance', hintKey: 'row_document_relevance_detail',
  })
  add(n('document_unclassified'), {
    key: 'document-unclassified', items: 'unclassified', earliest: 'oldest', group: 'review', href: '/arkiv/granska#typ', labelKey: 'row_document_unclassified',
  })
  add(n('document_field_review'), {
    key: 'document-field-review', items: 'field_review', earliest: 'oldest', group: 'review', href: '/arkiv/granska#falt', labelKey: 'row_document_field_review', hintKey: 'row_document_field_review_detail',
  })
  add(n('arkiv_finding'), {
    key: 'arkiv-finding', group: 'review', href: '/arkiv/granska#fynd', labelKey: 'row_arkiv_finding', hintKey: 'row_arkiv_finding_detail',
  })
  add(n('peppol_delivery_failed'), {
    key: 'peppol-failed', items: 'peppol_failed', earliest: 'oldest', group: 'review', href: '/invoices', labelKey: 'row_peppol_delivery_failed', hintKey: 'row_peppol_delivery_failed_detail',
  })
  add(n('collection_attention'), {
    key: 'collection-attention', items: 'collection_attention', group: 'review', href: '/invoices?status=collections', labelKey: 'row_collection_attention', hintKey: 'row_collection_attention_detail',
  })

  add(n('verifikat_missing_document'), {
    key: 'missing-underlag', items: 'missing_underlag', earliest: 'oldest', group: 'upload', href: '/bookkeeping?missingUnderlag=true', labelKey: 'row_missing_underlag', category: 'verifikat_missing_document',
    // A backlog is one job, not one decision per voucher: counted as one thing
    // so hundreds of old vouchers do not drown the headline. The row shows the number.
    things: 1,
  })

  add(n('deadline_action'), {
    key: 'deadlines', items: 'deadlines', earliest: 'due', group: 'watch', href: '/deadlines', labelKey: 'row_deadlines', category: 'deadline_action',
  })
  add(n('agreement_payment_missed'), {
    key: 'agreement-missed', items: 'agreement_missed', earliest: 'due', group: 'watch', href: '/arkiv/avtal', labelKey: 'row_agreement_payment_missed', hintKey: 'row_agreement_payment_missed_detail',
  })
  add(n('reconciliation_due'), {
    key: 'reconciliation-due', group: 'watch', href: '/reconciliation', labelKey: 'row_reconciliation_due', hintKey: 'row_reconciliation_due_detail', category: 'reconciliation_due',
  })

  return specs
}
