import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { MarkOpeningBalanceSchema } from '@/lib/api/schemas'

ensureInitialized()

/**
 * Re-tag a posted manual/import voucher on a bank account as an opening balance
 * (source_type='opening_balance') so bank reconciliation stops counting it as a
 * phantom difference. Delegates to the mark_entry_as_opening_balance RPC, which
 * enforces owner/admin role, the manual/import precondition, a bank-line check,
 * and the period lock. We only translate its errors to Swedish here.
 */
export const POST = withRouteContext(
  'reconciliation.bank.mark_opening_balance',
  async (request, { supabase, companyId }) => {
    const validation = await validateBody(request, MarkOpeningBalanceSchema)
    if (!validation.success) return validation.response
    const { journal_entry_id } = validation.data

    const { data, error } = await supabase.rpc('mark_entry_as_opening_balance', {
      p_company_id: companyId,
      p_entry_id: journal_entry_id,
    })

    if (error) {
      const raw = error.message || ''
      let message = 'Kunde inte markera verifikationen som ingående balans.'
      if (/owners and admins/i.test(raw)) {
        message = 'Endast ägare och administratörer kan markera en ingående balans.'
      } else if (/not found/i.test(raw)) {
        message = 'Verifikationen kunde inte hittas.'
      } else if (/manual\/import/i.test(raw)) {
        message = 'Bara manuellt eller importerat bokförda verifikationer kan markeras som ingående balans.'
      } else if (/posted entries/i.test(raw)) {
        message = 'Bara bokförda verifikationer kan markeras som ingående balans.'
      } else if (/bank\/cash account/i.test(raw)) {
        message = 'Verifikationen saknar rad på ett bankkonto (19xx) och kan inte vara en ingående balans.'
      } else if (/closed fiscal period/i.test(raw)) {
        message = 'Perioden är stängd. Öppna perioden innan du ändrar verifikationen.'
      } else if (/locked fiscal period/i.test(raw)) {
        message = 'Perioden är låst. Lås upp perioden innan du ändrar verifikationen.'
      }
      return NextResponse.json({ error: message }, { status: 400 })
    }

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)
