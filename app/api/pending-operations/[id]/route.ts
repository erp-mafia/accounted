import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { buildMappingResultFromCategory, getCategoryAccountMapping } from '@/lib/bookkeeping/category-mapping'
import { buildTransactionEntryLines } from '@/lib/bookkeeping/transaction-entries'
import { getVatRate } from '@/lib/bookkeeping/vat-entries'
import type { EntityType, Transaction, TransactionCategory, VatTreatment } from '@/types'

// PATCH /api/pending-operations/[id]
//
// Edit-before-approve. Today only supports staged categorize_transaction
// operations: the user can pick a different category (and/or VAT treatment)
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
    // Underlag's actual VAT override (null clears it; omit to preserve)
    vat_amount: z.number().min(0).nullable().optional(),
  })
  .refine(
    (v) => v.category !== undefined || v.vat_treatment !== undefined || v.vat_amount !== undefined,
    { message: 'Nothing to update' },
  )

export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'pending_operation.update',
  async (request, { supabase, companyId }, { params }) => {
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
        { error: `Operation already ${op.status}: cannot edit.` },
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

    // Resolve whether the (possibly defaulted) treatment carries a rate-based
    // VAT line: only then can a vat_amount override survive. An explicit
    // override on a VAT-less treatment is a caller error; a preserved one from
    // before the edit is simply stale and gets dropped.
    const probe = getCategoryAccountMapping(
      newCategory, (tx as Transaction).amount, isBusiness, entityType, newVatTreatment,
    )
    const carriesRateVat =
      isBusiness &&
      probe.vatTreatment !== null &&
      probe.vatTreatment !== 'reverse_charge' &&
      getVatRate(probe.vatTreatment as VatTreatment) > 0

    let newVatAmount: number | null
    if (body.vat_amount !== undefined) {
      if (body.vat_amount !== null && !carriesRateVat) {
        return NextResponse.json(
          { error: 'vat_amount kräver en momspliktig vat_treatment (standard_25, reduced_12 eller reduced_6).' },
          { status: 400 },
        )
      }
      newVatAmount = body.vat_amount
    } else {
      const previous = typeof oldParams.vat_amount === 'number' ? oldParams.vat_amount : null
      newVatAmount = carriesRateVat ? previous : null
    }

    let mapping
    try {
      mapping = buildMappingResultFromCategory(
        newCategory,
        tx as Transaction,
        isBusiness,
        entityType,
        newVatTreatment,
        newVatAmount,
      )
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Ogiltig momsjustering' },
        { status: 400 },
      )
    }

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
      // Re-derive the exact journal lines (net cost line, VAT, gross bank):
      // spreading oldPreview would otherwise leave stale lines from staging.
      lines: buildTransactionEntryLines(tx as Transaction, mapping).map((l) => ({
        account_number: l.account_number,
        debit_amount: l.debit_amount,
        credit_amount: l.credit_amount,
        description: l.line_description ?? '',
      })),
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
      vat_amount: newVatAmount,
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
  },
  { requireWrite: true },
)
