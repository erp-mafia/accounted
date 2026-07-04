import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { getSuggestedCategories, getSuggestedTemplates, buildMerchantHistory, merchantHistoryFor, type SuggestedCategory, type SuggestedTemplate } from '@/lib/transactions/category-suggestions'
import { findCounterpartyTemplatesBatch, formatCounterpartyName, toCounterpartyTemplateId } from '@/lib/bookkeeping/counterparty-templates'
import { requireCompanyId } from '@/lib/company/context'
import type { Transaction, EntityType } from '@/types'

/**
 * POST /api/transactions/suggest-categories
 * Batch endpoint for getting category suggestions for multiple transactions
 */
export async function POST(request: Request) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

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
    .select('category, merchant_name')
    .eq('company_id', companyId)
    .not('is_business', 'is', null)
    .neq('category', 'uncategorized')
    .neq('category', 'private')
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
      merchantHistoryFor(merchantHistory, (tx as Transaction).merchant_name)
    )
    template_suggestions[tx.id] = await getSuggestedTemplates(tx as Transaction, entityType, mappingRules || undefined)
  }

  // Inject counterparty template matches as top suggestions
  for (const tx of transactions) {
    const cpMatch = counterpartyMatches.get(tx.id)
    if (!cpMatch) continue

    const tmpl = cpMatch.template
    const cpSuggestion: SuggestedTemplate = {
      template_id: toCounterpartyTemplateId(tmpl.id),
      name_sv: formatCounterpartyName(tmpl.counterparty_name),
      name_en: formatCounterpartyName(tmpl.counterparty_name),
      group: 'counterparty',
      debit_account: tmpl.debit_account,
      credit_account: tmpl.credit_account,
      confidence: cpMatch.confidence,
      description_sv: `${tmpl.occurrence_count} tidigare bokföringar`,
      risk_level: 'NONE',
      requires_review: false,
      line_pattern: tmpl.line_pattern ?? null,
    }

    const existing = template_suggestions[tx.id] || []
    template_suggestions[tx.id] = [cpSuggestion, ...existing]
  }


  return NextResponse.json({ suggestions, template_suggestions })
}
