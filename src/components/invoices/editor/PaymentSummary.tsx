'use client'

import { Fragment, type ReactNode } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { BuildingLibraryIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import type { PaymentReason, SummaryPart } from '@/lib/invoices/editor/payment-summary'

interface PaymentSummaryProps {
  parts: SummaryPart[]
  /** Nothing the customer can pay to prints, and nothing is stored either. */
  missingDetails: boolean
  reason: PaymentReason | null
  terms: string[]
  /** Owner/admin with write access: may add payment details and texts. */
  canEditCompany: boolean
  /** The inline "Lägg till betalningsuppgifter" form, while it is open. */
  addForm: ReactNode | null
  onAddDetails: () => void
  /**
   * A foreign-currency invoice with nothing to pay to: the accounts that can
   * carry it once chosen, with what each prints. Replaces the inline form,
   * which saves SEK details only (crm#1273). Null for a SEK invoice.
   */
  foreignChoice: {
    currency: string
    options: Array<{ id: string; label: string; printed: string }>
    busy: boolean
  } | null
  onChooseAccount: (cashAccountId: string) => void
  onOpenPanel: () => void
}

/**
 * The Betalning section folded to one line: where the customer pays and
 * which QR code prints, at most one muted reason line, and the terms line.
 * "Ändra" opens the "Betalning och utseende" panel. With no payment details
 * at all the line is the inline way to add them (owner/admin), so a
 * faktura is never sent with nothing to pay to.
 */
export function PaymentSummary({
  parts,
  missingDetails,
  reason,
  terms,
  canEditCompany,
  addForm,
  onAddDetails,
  foreignChoice,
  onChooseAccount,
  onOpenPanel,
}: PaymentSummaryProps) {
  const t = useTranslations('invoice_editor_pay')

  if (missingDetails && foreignChoice) {
    const { currency, options, busy } = foreignChoice
    return (
      <div className="flex items-start gap-3 text-[13px]">
        <BuildingLibraryIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1 leading-5">
          <p className="text-muted-foreground">
            {t(options.length > 0 ? 'foreign_missing' : 'foreign_missing_no_iban', { currency })}
          </p>
          {options.length > 0 ? (
            <div className="mt-1 flex flex-col items-start gap-1">
              {options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  disabled={busy}
                  onClick={() => onChooseAccount(option.id)}
                  className="text-left text-foreground underline underline-offset-2 hover:text-muted-foreground disabled:opacity-50"
                  data-ph-mask=""
                >
                  {t(canEditCompany ? 'foreign_use_account' : 'foreign_use_account_here', {
                    account: option.label,
                    printed: option.printed,
                    currency,
                  })}
                </button>
              ))}
            </div>
          ) : canEditCompany ? (
            <Link href="/settings/invoicing" className="text-foreground underline underline-offset-2 hover:text-muted-foreground">
              {t('foreign_open_settings')}
            </Link>
          ) : (
            <p className="text-muted-foreground">{t('ask_admin')}</p>
          )}
        </div>
      </div>
    )
  }

  if (missingDetails) {
    if (addForm) return <>{addForm}</>
    // Muted: the page's one ochre sentence is the status line, which says the same.
    return (
      <div className="flex items-start gap-3 text-[13px]">
        <BuildingLibraryIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <p className="leading-5 text-muted-foreground">
          {t('missing')}{' '}
          {canEditCompany ? (
            <button
              type="button"
              onClick={onAddDetails}
              className="text-foreground underline underline-offset-2 hover:text-muted-foreground"
            >
              {t('add_details')}
            </button>
          ) : (
            t('ask_admin')
          )}
        </p>
      </div>
    )
  }

  // Parts are joined with " · "; the other ways to pay ride on the first with a comma.
  // Each of the app's own phrases keeps to one line, so the line wraps
  // between them and never inside "QR-kod" or an account number; the bank
  // name (free text the company typed) and the list of others may wrap.
  const pieces: Array<{ sep: string; text: string; keep: boolean }> = []
  for (const part of parts) {
    if (part.kind === 'text') pieces.push({ sep: ' · ', text: part.text, keep: false })
    else if (part.kind === 'key') pieces.push({ sep: ' · ', text: t(part.key, part.values ?? {}), keep: true })
    else if (pieces.length > 0) {
      pieces.push({ sep: ', ', text: part.methods.map((m) => t(`name_${m}`)).join(', '), keep: false })
    }
  }

  const reasonAction =
    reason?.action === 'add_account' || reason?.action === 'fix_account'
      ? canEditCompany
        ? {
            label: t(reason.action === 'add_account' ? 'action_add_account' : 'action_fix_account'),
            href: '/settings/invoicing',
          }
        : null
      : reason?.action === 'open_panel'
        ? { label: t('action_change'), onClick: onOpenPanel }
        : null

  return (
    <div className="text-[13px]">
      <div className="flex items-start gap-3">
        <BuildingLibraryIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="leading-5" data-ph-mask="">
            {pieces.length > 0
              ? pieces.map((piece, i) => (
                  <Fragment key={i}>
                    {i > 0 && piece.sep}
                    <span className={piece.keep ? 'whitespace-nowrap' : undefined}>{piece.text}</span>
                  </Fragment>
                ))
              : t('nothing_printed')}
          </p>
          {reason && (
            <p className="mt-1 text-[12.5px] leading-5 text-muted-foreground">
              {t(reason.key)}
              {reasonAction && (
                <>
                  {' '}
                  {reasonAction.href ? (
                    <Link href={reasonAction.href} className="underline underline-offset-2 hover:text-foreground">
                      {reasonAction.label}
                    </Link>
                  ) : (
                    <button
                      type="button"
                      onClick={reasonAction.onClick}
                      className="underline underline-offset-2 hover:text-foreground"
                    >
                      {reasonAction.label}
                    </button>
                  )}
                </>
              )}
            </p>
          )}
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onOpenPanel} className="-mt-1 shrink-0">
          {t('change')}
        </Button>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
        {terms.length > 0 ? (
          <p className="min-w-0 truncate text-muted-foreground">{t('terms', { texts: terms.join(' · ') })}</p>
        ) : (
          <p className="text-muted-foreground">{t('terms_none')}</p>
        )}
        {canEditCompany ? (
          <button type="button" className={`${QUIET_LINK_CLASS} shrink-0`} onClick={onOpenPanel}>
            {terms.length > 0 ? t('change') : t('terms_add')}
          </button>
        ) : null}
      </div>
    </div>
  )
}
