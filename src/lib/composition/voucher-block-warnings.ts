/**
 * The blocks' booking-time warnings for a typed verifikat (contract:
 * lib/bookkeeping/voucher-block-warnings.ts). Written out by hand and
 * imported statically by lib/bookkeeping/voucher-warnings-guard.ts: no lazy
 * registration, no lib/init, no event bus, so every door that runs the guard
 * asks every block.
 *
 * One warning today, the VAT block's: the verifikat changes the moms of a
 * period whose declaration is already filed
 * (lib/vat/voucher-filed-period-warning.ts).
 */
import type { VoucherBlockWarning } from '@/lib/bookkeeping/voucher-block-warnings'
import { filedPeriodVoucherWarning } from '@/lib/vat/voucher-filed-period-warning'

export const VOUCHER_BLOCK_WARNINGS: readonly VoucherBlockWarning[] = Object.freeze<VoucherBlockWarning[]>([
  Object.freeze<VoucherBlockWarning>({
    id: 'vat-period-already-filed',
    module: 'vat',
    warn: (supabase, companyId, input) => filedPeriodVoucherWarning(supabase, companyId, input),
  }),
])
