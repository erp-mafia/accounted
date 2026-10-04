import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { SkattekontoBankEnteredSchema } from '@/lib/api/schemas'

const errorResponse = (code: string, message: string, messageEn: string, status: number) =>
  NextResponse.json({ error: { code, message, message_en: messageEn } }, { status })

type TaxPaymentRow = {
  id: string
  status: 'booked' | 'upcoming'
  belopp_skatteverket: number | string
  bank_entered_at: string | null
}

/**
 * Mark selected upcoming Skattekonto debits as entered at the bank, or clear
 * that mark. This is display-only: no money, booking or Skatteverket status is
 * changed. It survives a later sync booking the debit because that does not
 * prove that the separate bank transfer was executed.
 */
export const POST = withRouteContext(
  'skattekonto.tax_payment.bank_entered',
  async (request, { supabase, companyId, log }) => {
    const validation = await validateBody(request, SkattekontoBankEnteredSchema, {
      log,
      operation: 'skattekonto.tax_payment.bank_entered',
    })
    if (!validation.success) return validation.response

    const ids = [...new Set(validation.data.transaction_ids)]
    const { entered } = validation.data
    const { data: rows, error: rowsError } = await supabase
      .from('skattekonto_transactions')
      .select('id, status, belopp_skatteverket, bank_entered_at')
      .eq('company_id', companyId)
      .in('id', ids)

    if (rowsError) throw rowsError
    if (!rows || rows.length !== ids.length) {
      return errorResponse(
        'TRANSACTION_NOT_FOUND',
        'En eller flera valda skattekontohändelser finns inte längre.',
        'One or more selected tax account events no longer exist.',
        404,
      )
    }

    const selected = rows as TaxPaymentRow[]
    if (
      entered &&
      selected.some((row) => row.status !== 'upcoming' || Number(row.belopp_skatteverket) >= 0)
    ) {
      return errorResponse(
        'TRANSACTION_NOT_PAYABLE',
        'Endast kommande debiteringar kan markeras som inlagda i banken.',
        'Only upcoming tax account debits can be marked as entered at the bank.',
        400,
      )
    }

    // Idempotent: keep the first timestamp when a client retries after a lost
    // response. Clearing deliberately touches every selected row.
    const idsToUpdate = entered
      ? selected.filter((row) => !row.bank_entered_at).map((row) => row.id)
      : ids
    if (idsToUpdate.length === 0) {
      return NextResponse.json({ data: { rows: selected } })
    }

    const bankEnteredAt = entered ? new Date().toISOString() : null
    let update = supabase
      .from('skattekonto_transactions')
      .update({ bank_entered_at: bankEnteredAt })
      .eq('company_id', companyId)
      .in('id', idsToUpdate)
    if (entered) {
      update = update
        .eq('status', 'upcoming')
        .lt('belopp_skatteverket', 0)
        .is('bank_entered_at', null)
    }
    const { data: updated, error: updateError } = await update
      .select('id, status, belopp_skatteverket, bank_entered_at')

    if (updateError) throw updateError
    if (!updated || updated.length !== idsToUpdate.length) {
      return errorResponse(
        'TRANSACTION_NOT_PAYABLE',
        'En skattekontohändelse ändrades under tiden. Ladda om och försök igen.',
        'A tax account event changed in the meantime. Reload and try again.',
        409,
      )
    }

    const updatedById = new Map((updated as TaxPaymentRow[]).map((row) => [row.id, row]))
    return NextResponse.json({
      data: {
        rows: selected.map((row) => updatedById.get(row.id) ?? row),
      },
    })
  },
  { requireWrite: true },
)
