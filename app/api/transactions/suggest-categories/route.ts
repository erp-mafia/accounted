import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getSuggestedCategories, getSuggestedTemplates, buildMerchantHistory, merchantHistoryFor, buildCounterpartySuggestion, type SuggestedCategory, type SuggestedTemplate } from '@/lib/transactions/category-suggestions'
import { findCounterpartyTemplatesBatch } from '@/lib/bookkeeping/counterparty-templates'
import { getOrphanedCounterLedgers } from '@/lib/cash-accounts/service'
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
    // template can carry the ledger it was learned on; when that ledger is an
    // orphaned cash account (revoked connection or a stale twin of a live
    // account, issue #1643 problem 4) the suggestion would pre-fill a junk
    // balance-sheet account in the booking dialog, so it is withheld here.
    // Static library templates only reference BAS business accounts plus the
    // literal 1930 settlement placeholder, so they never need this check.
    let orphanedLedgers: Set<string> | null = null
    const referencesOrphanedLedger = async (tmpl: CategorizationTemplate): Promise<boolean> => {
      const accounts = [
        tmpl.debit_account,
        tmpl.credit_account,
        ...(tmpl.line_pattern ?? []).map((entry) => entry.account),
      ].filter((a): a is string => !!a && /^19\d{2}$/.test(a))
      if (accounts.length === 0) return false
      orphanedLedgers ??= await getOrphanedCounterLedgers(supabase, companyId)
      return accounts.some((a) => orphanedLedgers!.has(a))
    }

    for (const tx of transactions) {
      const cpMatch = counterpartyMatches.get(tx.id)
      if (!cpMatch) continue
      if (await referencesOrphanedLedger(cpMatch.template)) continue

      const cpSuggestion = buildCounterpartySuggestion(cpMatch.template, cpMatch.confidence)

      const existing = template_suggestions[tx.id] || []
      template_suggestions[tx.id] = [cpSuggestion, ...existing]
    }


    return NextResponse.json({ suggestions, template_suggestions })
  },
)
