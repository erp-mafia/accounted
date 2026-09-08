import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getSuggestedCategories, getSuggestedTemplates, buildMerchantHistory, merchantHistoryFor, buildCounterpartySuggestion, type SuggestedCategory, type SuggestedTemplate } from '@/lib/transactions/category-suggestions'
import { findCounterpartyTemplatesBatch } from '@/lib/bookkeeping/counterparty-templates'
import { loadCounterLegTopology, type CounterLegTopology } from '@/lib/cash-accounts/service'
import type { Transaction, EntityType, CategorizationTemplate, InvoiceExtractionResult } from '@/types'
import { underlagContextFrom, withUnderlagAsCounterparty, type UnderlagContext } from '@/lib/bookkeeping/underlag-context'

/**
 * POST /api/transactions/suggest-categories
 * Batch endpoint for getting category suggestions for multiple transactions
 */
export const POST = withRouteContext(
  'transaction.suggest_categories',
  async (request, { supabase, companyId }) => {
    const { transaction_ids } = await request.json()

    if (!Array.isArray(transaction_ids) || transaction_ids.length === 0) {
      return NextResponse.json({ error: 'transaction_ids is required' }, { status: 400 })
    }

    // Limit batch size
    const ids = transaction_ids.slice(0, 50)

    // Fetch transactions
    const { data: transactions, error: txError } = await supabase
      .from('transactions')
      .select('*')
      .eq('company_id', companyId)
      .in('id', ids)

    if (txError || !transactions) {
      return NextResponse.json({ error: 'Failed to fetch transactions' }, { status: 500 })
    }

    // Fetch user's mapping rules (once, for all transactions)
    const { data: mappingRules } = await supabase
      .from('mapping_rules')
      .select('*')
      .or(`company_id.eq.${companyId},company_id.is.null`)
      .eq('is_active', true)
      .order('priority', { ascending: false })

    // Counterparty-keyed history from past categorized transactions: the
    // suggestion engine only surfaces history tied to the SAME merchant
    // (global frequency padding produced identical low-confidence spreads).
    const { data: historicalTxns } = await supabase
      .from('transactions')
      .select('category, merchant_name, description, original_description')
      .eq('company_id', companyId)
      .not('is_business', 'is', null)
      .neq('category', 'uncategorized')
      .neq('category', 'private')
      .order('date', { ascending: false })
      .limit(200)

    const merchantHistory = buildMerchantHistory(historicalTxns ?? [])

    // Fetch entity type for template matching
    const { data: settings } = await supabase
      .from('company_settings')
      .select('entity_type')
      .eq('company_id', companyId)
      .single()
    const entityType = (settings?.entity_type as EntityType) || undefined

    // The underlag each transaction already carries, from either door: the
    // inbox item matched to it, or the document pinned to the row. Its
    // supplier and line items are searched alongside the bank text below.
    const underlagByTx = await loadUnderlagContexts(supabase, companyId, transactions as Transaction[])

    // Batch counterparty template matching (1 DB query, in-memory matching)
    const counterpartyMatches = await findCounterpartyTemplatesBatch(supabase, companyId, transactions as Transaction[])
    // A second pass keyed on the invoice's supplier name, for the rows the
    // bank's text found nothing for. Marked so the row can say "Underlag".
    const docKeyed = (transactions as Transaction[])
      .filter((tx) => !counterpartyMatches.has(tx.id) && underlagByTx.get(tx.id)?.supplierName)
      .map((tx) => withUnderlagAsCounterparty(tx, underlagByTx.get(tx.id)))
    const docMatches = docKeyed.length > 0
      ? await findCounterpartyTemplatesBatch(supabase, companyId, docKeyed)
      : new Map<string, { template: CategorizationTemplate; confidence: number }>()

    // Generate initial suggestions for each transaction
    const suggestions: Record<string, SuggestedCategory[]> = {}
    const template_suggestions: Record<string, SuggestedTemplate[]> = {}

    for (const tx of transactions) {
      suggestions[tx.id] = getSuggestedCategories(
        tx as Transaction,
        mappingRules || [],
        merchantHistoryFor(
          merchantHistory,
          (tx as Transaction).merchant_name,
          (tx as Transaction).original_description ?? (tx as Transaction).description,
        )
      )
      template_suggestions[tx.id] = await getSuggestedTemplates(
        tx as Transaction,
        entityType,
        mappingRules || undefined,
        underlagByTx.get(tx.id) ?? null,
      )
    }

    // Inject counterparty template matches as top suggestions. A learned
    // template can carry the ledger it was learned on. The same rules
    // guardCounterLegs applies at commit (issue #1643 problem 4) decide what
    // the transactions page is offered, so a suggestion is never shown that
    // the commit guard would refuse, and never withheld that it would book:
    //   - a 19xx leg that is a TWIN of the transaction's own row (same IBAN,
    //     same currency: the stale bank leg of a template learned before a
    //     reconnect moved the account, or the other enabled ledger of one
    //     connection) is rewritten to the settlement ledger; if that leaves
    //     the settlement ledger against itself the suggestion is withheld,
    //   - a remaining 19xx leg in the orphaned set (revoked connection, or a
    //     stale twin of some live account) is a counter-position orphan and
    //     the suggestion is withheld: it would pre-fill a junk balance-sheet
    //     account in the booking dialog.
    // Static library templates only reference BAS business accounts plus the
    // literal 1930 settlement placeholder, so they never need this check.
    // The transaction's OWN settlement ledger is exempt: a transaction still
    // stranded on the orphaned row settles there.
    let counterLegTopology: CounterLegTopology | null | undefined
    const guardLearnedTemplate = async (
      tmpl: CategorizationTemplate,
      tx: Transaction,
    ): Promise<CategorizationTemplate | null> => {
      const isCashLedger = (a: string | null | undefined): a is string => !!a && /^19\d{2}$/.test(a)
      const accounts = [
        tmpl.debit_account,
        tmpl.credit_account,
        ...(tmpl.line_pattern ?? []).map((entry) => entry.account),
      ].filter(isCashLedger)
      if (accounts.length === 0) return tmpl
      if (counterLegTopology === undefined) {
        counterLegTopology = await loadCounterLegTopology(supabase, companyId)
      }
      if (!counterLegTopology) return tmpl
      const { settlementLedger, twins } = counterLegTopology.contextFor(tx.cash_account_id)

      let guarded = tmpl
      if (settlementLedger && accounts.some((a) => twins.has(a))) {
        const rewrite = (a: string): string => (twins.has(a) ? settlementLedger : a)
        guarded = {
          ...tmpl,
          debit_account: rewrite(tmpl.debit_account),
          credit_account: rewrite(tmpl.credit_account),
          line_pattern: tmpl.line_pattern
            ? tmpl.line_pattern.map((entry) => ({ ...entry, account: rewrite(entry.account) }))
            : tmpl.line_pattern,
        }
        if (guarded.debit_account === settlementLedger && guarded.credit_account === settlementLedger) {
          return null
        }
      }

      const remaining = [
        guarded.debit_account,
        guarded.credit_account,
        ...(guarded.line_pattern ?? []).map((entry) => entry.account),
      ].filter(isCashLedger)
      const orphanHit = remaining.some(
        (a) => a !== settlementLedger && counterLegTopology!.orphaned.has(a),
      )
      return orphanHit ? null : guarded
    }

    for (const tx of transactions) {
      const bankMatch = counterpartyMatches.get(tx.id)
      const docMatch = bankMatch ? undefined : docMatches.get(tx.id)
      const cpMatch = bankMatch ?? docMatch
      if (!cpMatch) continue
      const template = await guardLearnedTemplate(cpMatch.template, tx as Transaction)
      if (!template) continue

      const cpSuggestion = buildCounterpartySuggestion(template, cpMatch.confidence)
      if (docMatch) cpSuggestion.matched_on = 'underlag'

      const existing = template_suggestions[tx.id] || []
      template_suggestions[tx.id] = [cpSuggestion, ...existing]
    }


    return NextResponse.json({ suggestions, template_suggestions })
  },
)

/**
 * One underlag context per transaction that has one. Reads are best-effort:
 * a failure here leaves the proposal as it was, computed from the bank text.
 */
async function loadUnderlagContexts(
  supabase: Parameters<typeof findCounterpartyTemplatesBatch>[0],
  companyId: string,
  transactions: Transaction[],
): Promise<Map<string, UnderlagContext>> {
  const out = new Map<string, UnderlagContext>()
  const ids = transactions.map((t) => t.id)
  if (ids.length === 0) return out

  const { data: items } = await supabase
    .from('invoice_inbox_items')
    .select('matched_transaction_id, extracted_data')
    .eq('company_id', companyId)
    .in('matched_transaction_id', ids)
  for (const row of (items ?? []) as Array<{ matched_transaction_id: string; extracted_data: InvoiceExtractionResult | null }>) {
    const ctx = underlagContextFrom(row.extracted_data)
    if (ctx && !out.has(row.matched_transaction_id)) out.set(row.matched_transaction_id, ctx)
  }

  const pinned = transactions.filter((t) => t.document_id && !out.has(t.id))
  if (pinned.length > 0) {
    const { data: docs } = await supabase
      .from('document_attachments')
      .select('id, extracted_data')
      .eq('company_id', companyId)
      .in('id', pinned.map((t) => t.document_id as string))
    const byDoc = new Map(
      ((docs ?? []) as Array<{ id: string; extracted_data: InvoiceExtractionResult | null }>).map((d) => [d.id, d.extracted_data]),
    )
    for (const tx of pinned) {
      const ctx = underlagContextFrom(byDoc.get(tx.document_id as string) ?? null)
      if (ctx) out.set(tx.id, ctx)
    }
  }
  return out
}
