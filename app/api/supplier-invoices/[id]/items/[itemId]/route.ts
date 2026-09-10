import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { SupplierInvoiceItemAccountSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { backfillStandardBASAccounts } from '@/lib/bookkeeping/account-backfill'
import { isUnsettledSupplierInvoiceStatus } from '@/lib/supplier-invoices/lifecycle'

interface InvoiceRow {
  id: string
  status: string
  registration_journal_entry_id: string | null
}

interface ItemRow {
  id: string
  account_number: string
  line_total: number | string
  description: string
}

interface LineRow {
  id: string
  account_number: string
  debit_amount: number | string
  credit_amount: number | string
  line_description: string | null
}

function roundOre(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Plan the inline correction that moves one item's cost from its old account
 * to the new one. The registration verifikat carries the cost either as one
 * line per item or as one line per account; both shapes are handled: an
 * exact line is replaced one-for-one, an aggregate line is split so the old
 * account keeps the rest. Returns null when the entry holds nothing that
 * matches the item, which means it was corrected by hand already.
 */
export function planAccountMove(
  lines: LineRow[],
  oldAccount: string,
  newAccount: string,
  itemAmount: number,
  description: string,
): { strike: string[]; add: Array<{ account_number: string; debit_amount: number; credit_amount: number; line_description: string | null }> } | null {
  const amount = roundOre(Math.abs(itemAmount))
  if (amount === 0) return null
  const debitSide = itemAmount > 0
  const onOld = lines.filter((l) => l.account_number === oldAccount)
  const lineFor = (account: string, signed: number, text: string | null) => ({
    account_number: account,
    debit_amount: signed > 0 ? roundOre(signed) : 0,
    credit_amount: signed < 0 ? roundOre(-signed) : 0,
    line_description: text,
  })
  const exact = onOld.find((l) => roundOre(Number(debitSide ? l.debit_amount : l.credit_amount)) === amount)
  if (exact) {
    return { strike: [exact.id], add: [lineFor(newAccount, itemAmount, exact.line_description ?? description)] }
  }
  const net = roundOre(onOld.reduce((s, l) => s + Number(l.debit_amount || 0) - Number(l.credit_amount || 0), 0))
  const rest = roundOre(net - itemAmount)
  if (onOld.length === 0) return null
  const add = [lineFor(newAccount, itemAmount, description)]
  if (rest !== 0) add.unshift(lineFor(oldAccount, rest, onOld[0]!.line_description))
  return { strike: onOld.map((l) => l.id), add }
}

/**
 * PATCH /api/supplier-invoices/[id]/items/[itemId]: move the line to another
 * expense account, the way a category chip works on a transaction. While the
 * invoice is unsettled and its registration verifikat is posted in an open
 * period, the verifikat is corrected inline in the same call; the item row
 * is updated first so a refused correction leaves both sides untouched.
 */
export const PATCH = withRouteContext<{ params: Promise<{ id: string; itemId: string }> }>(
  'supplier_invoice.item.account',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id, itemId } = await params
    const validated = await validateBody(request, SupplierInvoiceItemAccountSchema, { log, operation: 'supplier_invoice.item.account' })
    if (!validated.success) return validated.response
    const account = validated.data.account_number

    const { data: invoice } = await supabase
      .from('supplier_invoices')
      .select('id, status, registration_journal_entry_id')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (!invoice) return errorResponseFromCode('NOT_FOUND', log, { requestId })
    const inv = invoice as InvoiceRow
    if (!isUnsettledSupplierInvoiceStatus(inv.status)) {
      return NextResponse.json({ error: 'Fakturan är avslutad och dess rader kan inte flyttas.' }, { status: 409 })
    }

    const { data: item } = await supabase
      .from('supplier_invoice_items')
      .select('id, account_number, line_total, description')
      .eq('id', itemId)
      .eq('supplier_invoice_id', id)
      .maybeSingle()
    if (!item) return errorResponseFromCode('NOT_FOUND', log, { requestId })
    const row = item as ItemRow
    if (row.account_number === account) return NextResponse.json({ data: { changed: false } })

    await backfillStandardBASAccounts(supabase, companyId, user.id, [account])

    const { data: updated, error: updateError } = await supabase
      .from('supplier_invoice_items')
      .update({ account_number: account })
      .eq('id', itemId)
      .eq('supplier_invoice_id', id)
      .select('id')
    if (updateError || !updated?.length) {
      log.warn('supplier invoice item account update refused', { itemId, message: updateError?.message })
      return errorResponseFromCode('INTERNAL_ERROR', log, { requestId })
    }

    if (!inv.registration_journal_entry_id) return NextResponse.json({ data: { changed: true, corrected: false } })

    const revert = async () => {
      await supabase.from('supplier_invoice_items').update({ account_number: row.account_number }).eq('id', itemId)
    }

    const { data: lines, error: linesError } = await supabase
      .from('journal_entry_lines')
      .select('id, account_number, debit_amount, credit_amount, line_description')
      .eq('journal_entry_id', inv.registration_journal_entry_id)
    if (linesError) {
      await revert()
      return errorResponseFromCode('INTERNAL_ERROR', log, { requestId })
    }
    const plan = planAccountMove((lines ?? []) as LineRow[], row.account_number, account, Number(row.line_total), row.description)
    if (!plan) {
      await revert()
      return NextResponse.json({ error: 'Registreringsverifikatet har ingen rad på det gamla kontot som matchar raden. Rätta verifikatet för hand.' }, { status: 409 })
    }

    const { error } = await supabase.rpc('correct_entry_lines_inline', {
      p_company_id: companyId,
      p_entry_id: inv.registration_journal_entry_id,
      p_strike_line_ids: plan.strike,
      p_new_lines: plan.add.map((l) => ({ ...l, dimensions: {} })),
      p_user_id: user.id,
    })
    if (error) {
      await revert()
      if (error.code === 'P0001') return NextResponse.json({ error: getErrorMessage(error) }, { status: 409 })
      if (error.code === '42501') return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 })
      log.error('correct_entry_lines_inline failed for a supplier invoice item', new Error(error.message), { entryId: inv.registration_journal_entry_id })
      return errorResponseFromCode('INTERNAL_ERROR', log, { requestId })
    }
    return NextResponse.json({ data: { changed: true, corrected: true } })
  },
  { requireWrite: true },
)
