'use client'

import { useTranslations } from 'next-intl'
import { BankMark } from '@/components/banks/BankMark'
import { pickPaymentAccount } from './payment-account-choice'
import type { PayableAccount } from './payments-client'

/**
 * The account a bank payment leaves from, as the payment dialogs show it:
 * the bank's mark, a choice only when there are several payable accounts,
 * and the IBAN. Shared by Betala via banken for supplier invoices and the
 * payment in to the skattekonto, so both pick an account the same way.
 */

/** The account paid from last time, per browser: the one the person most likely wants again. */
const ACCOUNT_MEMORY_KEY = 'accounted.bank_payments.account'

export function rememberedPaymentAccount(): string | null {
  try {
    return window.localStorage.getItem(ACCOUNT_MEMORY_KEY)
  } catch {
    return null
  }
}

export function rememberPaymentAccount(id: string) {
  try {
    window.localStorage.setItem(ACCOUNT_MEMORY_KEY, id)
  } catch {
    // Private windows and blocked storage: the default is the first payable account.
  }
}

/**
 * The account a dialog opens on: the dialog's preferred account while it can
 * pay (a salary run: the one its verifikat credits), else the one paid from
 * last time while it can still pay, else the first payable one
 * (pickPaymentAccount).
 */
export function defaultPaymentAccount(payable: PayableAccount[], preferred: string | null = null): PayableAccount | undefined {
  return pickPaymentAccount(payable, { preferred, remembered: rememberedPaymentAccount() })
}

export function PaymentAccountPicker({
  accounts,
  accountId,
  onChange,
}: {
  /** The payable accounts only. */
  accounts: PayableAccount[]
  accountId: string
  onChange: (id: string) => void
}) {
  const t = useTranslations('bank_payments')
  const account = accounts.find((a) => a.id === accountId) ?? null
  const accountText = account ? `${account.ledger_account} ${account.name ?? ''}`.trim() : ''
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground">{t('account_from')}</span>
      <BankMark bankName={account?.bank_name} />
      {accounts.length > 1 ? (
        <select
          aria-label={t('account_label')}
          className="h-8 rounded-lg px-2 text-[13px] bg-control shadow-raised"
          value={accountId}
          onChange={(e) => onChange(e.target.value)}
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {`${a.ledger_account} ${a.name ?? ''}`.trim()}
            </option>
          ))}
        </select>
      ) : (
        <span className="font-medium">{accountText}</span>
      )}
      {account?.iban && <span className="text-muted-foreground tabular-nums">{account.iban}</span>}
    </div>
  )
}
