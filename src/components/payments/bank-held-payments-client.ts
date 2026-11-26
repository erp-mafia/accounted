import { BANK_PAYMENT_CHECK_FAILED_WARNING } from '@/lib/payments/orders/bank-held-codes'
import type { BankHeldPaymentVia, BankHeldPaymentWarning } from '@/lib/payments/orders/signed-payment'

/**
 * How long a dialog waits for the answer about the bank's payments: past it
 * the check reads as not run, so a confirm is held no longer and Kreditera
 * opens.
 */
export const BANK_PAYMENT_CHECK_TIMEOUT_MS = 2_000

/** Invoices per request: what the route takes (ID_READ_CHUNK), which a gateway takes in a URL. */
const IDS_PER_REQUEST = 100

export interface BankHeldPaymentAnswer {
  /** One per payment the bank holds, naming its order and invoice. */
  warnings: BankHeldPaymentWarning[]
  /** The check did not run (the orders could not be read, or no answer in time): said as such, never as none. */
  failed: boolean
}

/**
 * GET /api/supplier-invoices/bank-held-payments for these invoices, in slices,
 * given up after `timeoutMs`. The read runs on the server
 * (checkBankHeldPayments), so the bundles carry none of it. A check that did
 * not run is `failed`, which the dialog says in its own words, wherever it
 * failed. Never throws.
 */
export async function askAboutBankHeldPayments(
  ids: readonly string[],
  via: BankHeldPaymentVia,
  timeoutMs: number = BANK_PAYMENT_CHECK_TIMEOUT_MS,
): Promise<BankHeldPaymentAnswer> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const slices: string[][] = []
    for (let start = 0; start < ids.length; start += IDS_PER_REQUEST) slices.push(ids.slice(start, start + IDS_PER_REQUEST))
    const answers = await Promise.all(
      slices.map(async (slice): Promise<BankHeldPaymentAnswer> => {
        const params = new URLSearchParams({ ids: slice.join(','), via })
        const res = await fetch(`/api/supplier-invoices/bank-held-payments?${params}`, { signal: controller.signal })
        if (!res.ok) return { warnings: [], failed: true }
        const body = (await res.json()) as { data?: Partial<BankHeldPaymentAnswer> }
        return { warnings: body.data?.warnings ?? [], failed: body.data?.failed === true }
      }),
    )
    return {
      warnings: answers.flatMap((answer) => answer.warnings).filter((w) => w.code !== BANK_PAYMENT_CHECK_FAILED_WARNING),
      failed: answers.some((answer) => answer.failed),
    }
  } catch {
    // Said, not swallowed: no answer in time, or none at all, is `failed`, a note of its own.
    return { warnings: [], failed: true }
  } finally {
    clearTimeout(timer)
  }
}
