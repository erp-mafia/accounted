import { redirect } from 'next/navigation'

/**
 * /purchases: the Inköp landing of shell v2 until 2026-09-09. The flow strip
 * it carried said less than the invoice list itself, so the address lives on
 * only for links that still point here.
 */
export default function PurchasesPage() {
  redirect('/supplier-invoices')
}
