import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { getSuggestedCategories, getSuggestedTemplates, type SuggestedCategory, type SuggestedTemplate } from '@/lib/transactions/category-suggestions'
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

  // Build category history from user's past categorized transactions
  const { data: historicalTxns } = await supabase
    .from('transactions')
    .select('category')
    .eq('company_id', companyId)
    .not('is_business', 'is', null)
    .neq('category', 'uncategorized')
    .neq('category', 'private')
    .limit(200)

  const categoryHistory: Record<string, number> = {}
  if (historicalTxns) {
    for (const tx of historicalTxns) {
      categoryHistory[tx.category] = (categoryHistory[tx.category] || 0) + 1
    }
  }

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
      categoryHistory
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

  // Inject document template suggestions from matched inbox items
  try {
    const { data: matchedInboxItems } = await supabase
      .from('invoice_inbox_items')
      .select('matched_transaction_id, suggested_template_id, suggested_template_confidence')
      .eq('company_id', companyId)
      .in('matched_transaction_id', ids)
      .not('suggested_template_id', 'is', null)

    if (matchedInboxItems && matchedInboxItems.length > 0) {
      console.log(`[suggest-categories] Found ${matchedInboxItems.length} matched inbox items with template suggestions`)
      const { getTemplateById } = await import('@/lib/bookkeeping/booking-templates')

      for (const item of matchedInboxItems) {
        const txId = item.matched_transaction_id as string
        const templateId = item.suggested_template_id as string
        const template = getTemplateById(templateId)
        if (!template) {
          console.log(`[suggest-categories] Template "${templateId}" not found, skipping`)
          continue
        }

        console.log(`[suggest-categories] Injecting document template: tx=${txId} → ${templateId} (${template.name_sv}, debit=${template.debit_account}, confidence=${item.suggested_template_confidence})`)

        // Add to template_suggestions at the top with boosted confidence
        const existing = template_suggestions[txId] || []
        const docTemplate: SuggestedTemplate = {
          template_id: templateId,
          name_sv: template.name_sv,
          name_en: template.name_en,
          group: template.group,
          debit_account: template.debit_account,
          credit_account: template.credit_account,
          confidence: Math.min((item.suggested_template_confidence as number) || 0.8, 1),
          description_sv: template.description_sv,
          risk_level: template.risk_level,
          requires_review: template.requires_review,
        }
        template_suggestions[txId] = [docTemplate, ...existing.filter((t) => t.template_id !== templateId)]
      }
    }
  } catch {
    // Non-blocking
  }

  return NextResponse.json({ suggestions, template_suggestions })
}
