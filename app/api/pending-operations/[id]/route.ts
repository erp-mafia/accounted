import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { buildMappingResultFromCategory } from '@/lib/bookkeeping/category-mapping'
import type { EntityType, Transaction, TransactionCategory, VatTreatment } from '@/types'

// PATCH /api/pending-operations/[id]
//
// Edit-before-approve. Today only supports staged categorize_transaction
// operations — the user can pick a different category (and/or VAT treatment)
// before clicking Godkänn. We re-derive the booking via the same mapping
// engine the commit path uses so the preview the user approves equals the
// preview that gets posted.
//
// Other operation types return 400. As specialized editors land (e.g. edit
// invoice line items before send) they extend this dispatcher.

ensureInitialized()

const CATEGORIES = [
  'income_services', 'income_products', 'income_other',
  'expense_equipment', 'expense_software', 'expense_travel', 'expense_office',
  'expense_marketing', 'expense_professional_services', 'expense_education',
  'expense_representation', 'expense_consumables', 'expense_vehicle',
  'expense_telecom', 'expense_bank_fees', 'expense_card_fees',
  'expense_currency_exchange', 'expense_other', 'private', 'uncategorized',
] as const satisfies readonly TransactionCategory[]

const VAT_TREATMENTS = [
  'standard_25', 'reduced_12', 'reduced_6',
  'reverse_charge', 'export', 'exempt',
] as const satisfies readonly VatTreatment[]

const PatchSchema = z
  .object({
    category: z.enum(CATEGORIES).optional(),
    vat_treatment: z.enum(VAT_TREATMENTS).nullable().optional(),
  })
  .refine(
    (v) => v.category !== undefined || v.vat_treatment !== undefined,
    { message: 'Nothing to update' },
  )

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)
  const { id } = await params

  let body: z.infer<typeof PatchSchema>
  try {
    body = PatchSchema.parse(await request.json())
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid body' },
      { status: 400 },
    )
  }

  const { data: op } = await supabase
    .from('pending_operations')
    .select('id, company_id, operation_type, status, params, preview_data, title')
    .eq('id', id)
    .eq('company_id', companyId)
    .maybeSingle()
  if (!op) return NextResponse.json({ error: 'Pending operation not found' }, { status: 404 })

  if (op.status !== 'pending') {
    return NextResponse.json(
      { error: `Operation already ${op.status} — cannot edit.` },
      { status: 409 },
    )
  }

  if (op.operation_type !== 'categorize_transaction') {
    return NextResponse.json(
      { error: `Editing ${op.operation_type} is not supported.` },
      { status: 400 },
    )
  }

  const oldParams = (op.params as Record<string, unknown>) ?? {}
  const newCategory =
    body.category ?? (oldParams.category as TransactionCategory | undefined)
  const newVatTreatment =
    body.vat_treatment !== undefined
      ? (body.vat_treatment ?? undefined)
      : (oldParams.vat_treatment as VatTreatment | undefined)

  if (!newCategory) {
    return NextResponse.json({ error: 'category is required' }, { status: 400 })
  }

  const txId = oldParams.transaction_id as string | undefined
  if (!txId) {
    return NextResponse.json(
      { error: 'Operation has no transaction_id; cannot re-derive.' },
      { status: 500 },
    )
  }

  // Re-derive the preview using the same mapping engine the commit path uses.
  const { data: tx } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', txId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (!tx) {
    return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
  }

  const { data: settings } = await supabase
    .from('company_settings')
    .select('entity_type')
    .eq('company_id', companyId)
    .maybeSingle()
  const entityType = ((settings?.entity_type as EntityType) || 'enskild_firma')

  const isBusiness = newCategory !== 'private'
  const mapping = buildMappingResultFromCategory(
    newCategory,
    tx as Transaction,
    isBusiness,
    entityType,
    newVatTreatment,
  )

  if (!mapping.debit_account || !mapping.credit_account) {
    return NextResponse.json(
      { error: `Inget kontomappning för kategorin "${newCategory}" (${entityType}).` },
      { status: 400 },
    )
  }

  const oldPreview = (op.preview_data as Record<string, unknown>) ?? {}
  const newPreview = {
    ...oldPreview,
    debit_account: mapping.debit_account,
    credit_account: mapping.credit_account,
    amount: Math.abs((tx as Transaction).amount),
    currency: (tx as Transaction).currency,
    vat_lines: (mapping.vat_lines ?? []).map((v) => ({
      account: v.account_number,
      amount: v.debit_amount || v.credit_amount,
    })),
    category: newCategory,
  }

  const newParams = {
    ...oldParams,
    category: newCategory,
    vat_treatment: newVatTreatment ?? null,
  }

  const { data: updated, error } = await supabase
    .from('pending_operations')
    .update({ params: newParams, preview_data: newPreview })
    .eq('id', id)
    .eq('company_id', companyId)
    .select('id, params, preview_data, title, status')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ data: updated })
}
