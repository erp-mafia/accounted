/**
 * The blocks' booking-time warnings for a typed verifikat (contract:
 * lib/bookkeeping/voucher-block-warnings.ts). Written out by hand and
 * imported statically by lib/bookkeeping/voucher-warnings-guard.ts: no lazy
 * registration, no lib/init, no event bus, so every door that runs the guard
 * asks every block.
 *
 * Three warnings today. The VAT block's two: the verifikat changes the moms
 * of a period whose declaration is already filed
 * (lib/vat/voucher-filed-period-warning.ts), and it declares one
 * reverse-charge purchase twice in rutor 20-24
 * (lib/vat/voucher-rc-basis-twice-warning.ts). The invoicing block's: the
 * verifikat settles kundfordringar or leverantörsskulder by exactly what an
 * open invoice has left to pay (lib/invoices/voucher-open-invoice-warning.ts).
 */
import type { VoucherBlockWarning } from '@/lib/bookkeeping/voucher-block-warnings'
import { openInvoiceVoucherWarning } from '@/lib/invoices/voucher-open-invoice-warning'
import { filedPeriodVoucherWarning } from '@/lib/vat/voucher-filed-period-warning'
import { rcBasisTwiceVoucherWarning } from '@/lib/vat/voucher-rc-basis-twice-warning'

export const VOUCHER_BLOCK_WARNINGS: readonly VoucherBlockWarning[] = Object.freeze<VoucherBlockWarning[]>([
  Object.freeze<VoucherBlockWarning>({
    id: 'vat-period-already-filed',
    module: 'vat',
    warn: (supabase, companyId, input) => filedPeriodVoucherWarning(supabase, companyId, input),
  }),
  Object.freeze<VoucherBlockWarning>({
    id: 'open-invoice-covers-posting',
    module: 'invoicing',
    warn: (supabase, companyId, input) => openInvoiceVoucherWarning(supabase, companyId, input),
  }),
  Object.freeze<VoucherBlockWarning>({
    id: 'reverse-charge-basis-twice',
    module: 'vat',
    warn: (supabase, companyId, input) => rcBasisTwiceVoucherWarning(supabase, companyId, input),
  }),
])
