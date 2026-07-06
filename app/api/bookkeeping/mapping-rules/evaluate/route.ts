import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { evaluateMappingRules } from '@/lib/bookkeeping/mapping-engine'
import { validateBody } from '@/lib/api/validate'
import { EvaluateMappingRulesSchema } from '@/lib/api/schemas'
import type { Transaction } from '@/types'

export const POST = withRouteContext('mapping_rules.evaluate', async (request, ctx) => {
  const { supabase, companyId, log } = ctx

  const validation = await validateBody(request, EvaluateMappingRulesSchema, {
    log,
    operation: 'mapping_rules.evaluate',
  })
  if (!validation.success) return validation.response
  const body = validation.data

  // Accept either a transaction ID or raw transaction data
  let transaction: Transaction

  if ('transaction_id' in body) {
    const { data, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', body.transaction_id)
      .eq('company_id', companyId)
      .single()

    if (error || !data) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
    }

    transaction = data as Transaction
  } else {
    // Schema-validated (amount required, passthrough for optional signal
    // fields) — the mapping engine only reads the fields it knows.
    transaction = body as unknown as Transaction
  }

  try {
    const result = await evaluateMappingRules(supabase, companyId, transaction)
    return NextResponse.json({ data: result })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Evaluation failed' },
      { status: 500 }
    )
  }
})
