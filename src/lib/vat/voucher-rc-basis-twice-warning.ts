/**
 * The VAT block's booking-time warning for typed lines that declare one
 * reverse-charge purchase twice in the momsdeklaration (contract:
 * lib/bookkeeping/voucher-block-warnings.ts): a 45xx/4598 basis pair beside a
 * line on an account that reports ruta 20-24 itself, so rutor 20-24 carry the
 * purchase twice while ruta 30-32 carries its moms once. The rule is
 * rcBasisCountedTwice (lib/reports/rc-basis-gaps.ts), read with the
 * declaration's own account resolution.
 *
 * The producers never book this shape; typed lines can, and a rättelse is
 * typed lines: the confirm-before-posting guard asks every typed door, and
 * gnubok_correct_entry and the v1 rättelse, which stage or post without that
 * guard, show the same warning beside their preview.
 *
 * A warning, never a refusal: the person may know better (a basis that
 * belongs to an earlier purchase, booked here on purpose). A verifikat
 * without a 4598 line costs no query, and an ingående balans is not asked.
 * Throws when the read fails; the guard never lets that stop a booking.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { VoucherBlockWarningInput } from '@/lib/bookkeeping/voucher-block-warnings'
import type { VoucherWarning } from '@/lib/bookkeeping/voucher-plausibility'
import { RC_BASIS_OFFSET_ACCOUNT } from '@/lib/bookkeeping/vat-entries'
import { rcBasisCountedTwice, type RcBasisCountedTwice } from '@/lib/reports/rc-basis-gaps'
import { fetchDynamicVatAccounts } from '@/lib/reports/vat-revenue-accounts'
import { formatAmount } from '@/lib/utils'

const kr = (amount: number) => `${formatAmount(amount)} kr`

/** The warning for what rcBasisCountedTwice found; `rattelse` when the lines replace a posted verifikat. */
export function rcBasisTwiceWarning(found: RcBasisCountedTwice, rattelse: boolean): VoucherWarning {
  // The cost booked on a BAS basis account itself (4531) has no other account to name.
  const own = found.ownRutaAccounts.length > 0 ? found.ownRutaAccounts : found.basisAccounts
  const several = own.length > 1
  const accountSv = `${several ? 'kontona' : 'konto'} ${own.join(', ')}`
  const accountEn = `${several ? 'accounts' : 'account'} ${own.join(', ')}`
  const reported = kr(found.reportedBasisAmount)
  const expected = kr(found.expectedBasisAmount)
  return {
    code: 'REVERSE_CHARGE_BASIS_TWICE',
    message_sv:
      `${rattelse ? 'Rättelsen' : 'Verifikationen'} skulle räkna samma inköp två gånger i momsdeklarationen: ` +
      `${accountSv} redovisar själv underlaget i ruta 20-24, och ett basbeloppspar mot 4598 redovisar det en gång till. ` +
      `Ruta 20-24 får ${reported}, men den fiktiva momsen är beräknad på ${expected}. ` +
      'Ta bort basbeloppsparet, eller bokför kostnaden på ett konto utan egen momsruta.',
    message_en:
      `The ${rattelse ? 'correction' : 'voucher'} would count the purchase twice in the momsdeklaration: ` +
      `${accountEn} ${several ? 'report' : 'reports'} ruta 20-24 itself, and a basis pair against 4598 declares it again. ` +
      `Rutor 20-24 get ${reported} while the fiktiv moms is computed on ${expected}. ` +
      'Remove the basis pair, or book the cost on an account without a ruta of its own.',
    details: {
      own_ruta_accounts: found.ownRutaAccounts,
      basis_accounts: found.basisAccounts,
      reported_basis: found.reportedBasisAmount,
      expected_basis: found.expectedBasisAmount,
    },
  }
}

export async function rcBasisTwiceVoucherWarning(
  supabase: SupabaseClient,
  companyId: string,
  input: Pick<VoucherBlockWarningInput, 'lines' | 'replaces' | 'opening_balance'>,
): Promise<VoucherWarning | null> {
  if (input.opening_balance) return null
  if (!input.lines.some((line) => line.account_number === RC_BASIS_OFFSET_ACCOUNT)) return null
  const found = rcBasisCountedTwice(input.lines, await fetchDynamicVatAccounts(supabase, companyId))
  return found ? rcBasisTwiceWarning(found, !!input.replaces) : null
}
