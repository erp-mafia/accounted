import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getSuggestedCategories, getSuggestedTemplates, buildMerchantHistory, merchantHistoryFor, buildCounterpartySuggestion, type SuggestedCategory, type SuggestedTemplate } from '@/lib/transactions/category-suggestions'
import { findCounterpartyTemplatesBatch } from '@/lib/bookkeeping/counterparty-templates'
import { loadCounterLegTopology, type CounterLegTopology } from '@/lib/cash-accounts/service'
import type { Transaction, EntityType, CategorizationTemplate } from '@/types'

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

    // Batch counterparty template matching (1 DB query, in-memory matching)
    const counterpartyMatches = await findCounterpartyTemplatesBatch(supabase, companyId, transactions as Transaction[])

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
      template_suggestions[tx.id] = await getSuggestedTemplates(tx as Transaction, entityType, mappingRules || undefined)
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
      const cpMatch = counterpartyMatches.get(tx.id)
      if (!cpMatch) continue
      const template = await guardLearnedTemplate(cpMatch.template, tx as Transaction)
      if (!template) continue

      const cpSuggestion = buildCounterpartySuggestion(template, cpMatch.confidence)

      const existing = template_suggestions[tx.id] || []
      template_suggestions[tx.id] = [cpSuggestion, ...existing]
    }


    return NextResponse.json({ suggestions, template_suggestions })
  },
)
