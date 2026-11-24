/**
 * Booking a Bankgirot deposit split without a person, as ingest asks for it
 * (contract: lib/transactions/deposit-split-booking.ts). Written out by hand
 * and imported statically by ingest alone: no lazy registration, no lib/init,
 * no event bus. The answer lives with the invoice blocks.
 */
import type { DepositSplitBooking } from '@/lib/transactions/deposit-split-booking'
import { depositSplitBooking } from '@/lib/invoices/customer-payment-auto-book'

export const DEPOSIT_SPLIT_BOOKING: DepositSplitBooking = depositSplitBooking
