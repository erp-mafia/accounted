'use client'

import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { ChevronDownIcon, XMarkIcon, type Icon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { AGENT_FAB_CLEARANCE_CLASS } from '@/components/ui/fab-clearance'
import DocumentViewerPane from '@/components/bookkeeping/DocumentViewerPane'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { formatOrgNumberDisplay } from '@/lib/invariants/org-number'
import { embeddedVoucherLabel, getLinkedJournalEntryIds } from '@/lib/transactions/is-booked'
import { TransactionPartsSection } from '@/components/transactions/TransactionPartsSection'
import type { TransactionWithInvoice } from '@/components/transactions/transaction-types'
import type { TransactionUnderlag } from '@/lib/transactions/underlag-read'
import type { BatchAllocationPrefill } from '@/lib/transactions/parts-read'
import type { GiroCounterparty } from '@/lib/transactions/giro-counterparty'
import { bankRowTitle } from '@/lib/transactions/row-title'
import { useGiroText } from './use-giro-text'

async function fetchUnderlag(url: string): Promise<TransactionUnderlag> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} ${res.status}`)
  return ((await res.json()) as { data: TransactionUnderlag }).data
}

/**
 * Transaction drawer (concept .drawer): a fixed panel on the right
 * that opens when a row is clicked, instead of the row folding out in the
 * table. The category chip, the row's actions and the details the foldout
 * used to hold, in one place that does not move the list.
 */

export interface DrawerAction {
  key: string
  label: string
  icon: Icon
  onSelect: () => void
  destructive?: boolean
}

interface TransactionDrawerProps {
  transaction: TransactionWithInvoice
  accountLabel: string | null
  accountLogo?: string | null
  categoryLabel: string | null
  /** Why the category chip says what it says, when it is a recommendation. */
  proposalWhy?: string | null
  /** The chip is the booking the person set in the review: its why stands alone, it is no recommendation. */
  proposalOwn?: boolean
  primaryLabel: string
  onPrimary: (anchor: HTMLElement) => void
  onOpenCategory: (anchor: HTMLElement) => void
  actions: DrawerAction[]
  methodLabel: string | null
  originalName: string | null
  skvCounterpartDate?: string
  isPreMigration: boolean
  /** Whose giro number a row that names nobody shows (lib/transactions/giro-counterparty, crm#1204). */
  giroCounterparty?: GiroCounterparty | null
  /** Kept for callers; the drawer reads the underlag route, which covers both doors. */
  attachedDocumentId?: string | null
  /** Anything the foldout showed that has no slot here (extraction status). */
  extra?: ReactNode
  /** Open the batch allocation prefilled from the row's Bankgirot split; absent when the row cannot be split-matched. */
  onMatchParts?: (allocations: BatchAllocationPrefill[]) => void
  processing: boolean
  onClose: () => void
}

export function TransactionDrawer({
  transaction,
  accountLabel,
  accountLogo = null,
  categoryLabel,
  proposalWhy,
  proposalOwn = false,
  primaryLabel,
  onPrimary,
  onOpenCategory,
  actions,
  methodLabel,
  originalName,
  skvCounterpartDate,
  isPreMigration,
  giroCounterparty = null,
  extra,
  onMatchParts,
  processing,
  onClose,
}: TransactionDrawerProps) {
  const t = useTranslations('tx_inbox_card')
  const giroText = useGiroText()
  const isIncome = transaction.amount > 0
  // Pointer plus junction anchors: a row split over several verifikat has
  // journal_entry_id NULL but is booked (crm#48).
  const linkedEntryIds = getLinkedJournalEntryIds(transaction)
  const booked = linkedEntryIds.length > 0
  const voucherLinks = (transaction.transaction_voucher_links ?? []).filter(
    (link) => (link.role ?? 'bank_line') === 'bank_line',
  )
  const attach = actions.find((a) => a.key === 'attach')
  // The underlag from either door: pinned to the row, or matched in the
  // inbox. The receipt is what makes the booking decidable, so it sits
  // above the details rather than as one line among them.
  const { data: underlag } = useSWR<TransactionUnderlag>(
    `/api/transactions/${transaction.id}/underlag`,
    fetchUnderlag,
  )
  const facts = underlag?.facts ?? null
  const kindLabel = (kind: string | null) =>
    kind === 'receipt' ? t('kind_receipt') : kind === 'supplier_invoice' ? t('kind_supplier_invoice') : kind

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  if (typeof document === 'undefined') return null

  // The bank's text, with the name it sent put first when the text is only digits (crm#1399).
  const title = bankRowTitle(transaction)

  // What the bank's enrichment added (Open Payments): the counterparty's
  // organisationsnummer, the amount a foreign purchase was made in with the
  // rate (the bank's own on a SEK account, else the amounts' ratio: there
  // exchange_rate is the Riksbanken SEK rate), and the balance after.
  const orgNumber = transaction.counterparty_org_number ? formatOrgNumberDisplay(transaction.counterparty_org_number) : null
  const instructed =
    transaction.instructed_amount != null && transaction.instructed_currency && transaction.instructed_currency !== transaction.currency
      ? { amount: transaction.instructed_amount, currency: transaction.instructed_currency }
      : null
  const instructedRate = instructed
    ? transaction.currency === 'SEK' && transaction.exchange_rate != null && transaction.exchange_rate > 0
      ? transaction.exchange_rate
      : instructed.amount !== 0
        ? Math.abs(transaction.amount / instructed.amount)
        : null
    : null
  const rateText = instructedRate != null ? new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 4 }).format(instructedRate) : null
  const balanceAfter = transaction.balance_after != null ? formatCurrency(transaction.balance_after, transaction.currency) : null
  // The counterparty's IBAN, as the bank sent it: often the only thing a
  // foreign payment names its payee by (PH 196). Groups of four, as printed.
  const counterpartyIban = transaction.counterparty_iban
    ? transaction.counterparty_iban.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim()
    : null

  const fact = (label: string, value: ReactNode) =>
    value == null || value === '' ? null : (
      <div className="contents">
        <dt className="text-muted-foreground">{label}</dt>
        <dd className="min-w-0 break-words" data-ph-mask>
          {value}
        </dd>
      </div>
    )

  return createPortal(
    <aside
      role="dialog"
      aria-label={title}
      className="fixed bottom-[calc(var(--bottom-nav-h)+0.625rem)] right-2.5 top-2.5 z-40 flex w-[min(400px,calc(100vw-20px))] flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-drawer animate-fade-in"
    >
      <div className="flex items-start gap-3 border-b-hairline px-5 pb-3 pt-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium" data-ph-mask title={title}>
            {title}
          </p>
          <p className={cn('mt-0.5 text-xl tabular-nums tracking-tight', isIncome && 'text-success')} data-ph-mask>
            {isIncome ? '+' : ''}
            {formatCurrency(transaction.amount, transaction.currency)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            <span className="tabular-nums">{formatDate(transaction.date)}</span>
            {accountLabel ? <span data-ph-mask> · {accountLabel}</span> : null}
            {' · '}
            {booked ? t('drawer_state_booked') : t('drawer_state_unbooked')}
          </p>
        </div>
        <Button variant="ghost" size="icon" className="-mr-2 -mt-1 shrink-0 text-muted-foreground" onClick={onClose} aria-label={t('drawer_close')}>
          <XMarkIcon className="h-4 w-4" />
        </Button>
      </div>

      {/* The panel reaches the corner the assistant button floats in, so its
          scroll body clears the button the same way the page does. */}
      <div className={cn('min-h-0 flex-1 overflow-y-auto', AGENT_FAB_CLEARANCE_CLASS)}>
        {!booked && (
          <div className="border-b-hairline px-5 py-3">
            <p className="mb-1.5 text-xs font-semibold text-muted-foreground">{t('drawer_category')}</p>
            <button
              type="button"
              className={cn(
                'field-surface inline-flex max-w-full items-center gap-1.5 rounded-md px-3 py-1 text-[13px] transition-shadow duration-150',
                !categoryLabel && 'text-muted-foreground',
              )}
              onClick={(e) => onOpenCategory(e.currentTarget)}
              disabled={processing}
            >
              <span className="truncate">{categoryLabel ?? t('category_pick')}</span>
              <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 opacity-60" />
            </button>
            {categoryLabel && proposalWhy && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                {proposalOwn ? proposalWhy : t('drawer_rec', { why: proposalWhy })}
              </p>
            )}
          </div>
        )}

        <div className="border-b-hairline px-5 py-3">
          <p className="mb-1.5 text-xs font-semibold text-muted-foreground">{t('drawer_actions')}</p>
          <div className="flex flex-col items-start gap-1.5">
            <Button onClick={(e) => onPrimary(e.currentTarget)} disabled={processing}>
              {primaryLabel}
            </Button>
            <div className="flex flex-col items-start gap-1 pt-1">
              {actions.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  className={cn(QUIET_LINK_CLASS, 'inline-flex items-center gap-2 no-underline', a.destructive && 'hover:text-destructive')}
                  onClick={a.onSelect}
                  disabled={processing}
                >
                  <a.icon className="h-3.5 w-3.5" aria-hidden />
                  {a.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="border-b-hairline px-5 py-3">
          <p className="mb-1.5 flex items-center justify-between text-xs font-semibold text-muted-foreground">
            <span>{t('underlag_heading')}</span>
            {underlag?.source && (
              <span className="font-normal normal-case tracking-normal">{t(`underlag_source_${underlag.source}`)}</span>
            )}
          </p>
          {underlag?.document ? (
            <>
              <DocumentViewerPane
                documentId={underlag.document.id}
                mime={underlag.document.mime_type}
                fileName={underlag.document.file_name}
                className="h-56 overflow-hidden rounded-md bg-control shadow-raised"
              />
              {facts && (
                <dl className="mt-2 grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-xs">
                  {facts.supplier && (
                    <>
                      <dt className="text-muted-foreground">{t('underlag_supplier')}</dt>
                      <dd data-ph-mask>{facts.supplier}</dd>
                    </>
                  )}
                  {facts.date && (
                    <>
                      <dt className="text-muted-foreground">{t('underlag_date')}</dt>
                      <dd className="tabular-nums">{formatDate(facts.date)}</dd>
                    </>
                  )}
                  {facts.total != null && (
                    <>
                      <dt className="text-muted-foreground">{t('underlag_total')}</dt>
                      <dd className="tabular-nums" data-ph-mask>{formatCurrency(facts.total, facts.currency ?? 'SEK')}</dd>
                    </>
                  )}
                  {facts.vat_amount != null && (
                    <>
                      <dt className="text-muted-foreground">{t('underlag_vat')}</dt>
                      <dd className="tabular-nums" data-ph-mask>{formatCurrency(facts.vat_amount, facts.currency ?? 'SEK')}</dd>
                    </>
                  )}
                  {facts.kind && (
                    <>
                      <dt className="text-muted-foreground">{t('underlag_kind')}</dt>
                      <dd>{kindLabel(facts.kind)}</dd>
                    </>
                  )}
                </dl>
              )}
            </>
          ) : (
            <div className="text-xs">
              <p className={underlag ? 'text-warning' : 'text-muted-foreground'}>{underlag ? t('underlag_missing_line') : '…'}</p>
              {underlag && !booked && attach && (
                <button type="button" className={cn(QUIET_LINK_CLASS, 'mt-1.5')} onClick={attach.onSelect} disabled={processing}>
                  {t('underlag_attach')}
                </button>
              )}
            </div>
          )}
        </div>

        {/* The Bankgirot split, whichever door brought it: Open Payments'
            enrichment or a BG Max deposit file on a row from any feed
            (crm#1170). Shown when the list counted parts on the row, and
            fetched when the row came without the count; the section renders
            nothing for a row without parts. */}
        {(transaction.parts_count == null || (transaction.parts_count[0]?.count ?? 0) > 0) && (
          <TransactionPartsSection
            transactionId={transaction.id}
            onMatch={!booked ? onMatchParts : undefined}
            processing={processing}
          />
        )}

        {/* Only when there is a fact to show: a heading over nothing reads as
            something missing. */}
        {(accountLabel || originalName || transaction.original_description || giroCounterparty || counterpartyIban || methodLabel || booked || skvCounterpartDate || isPreMigration || extra || orgNumber || instructed || balanceAfter || (transaction.currency !== 'SEK' && transaction.amount_sek != null)) && (
        <div className="px-5 py-3">
          <p className="mb-1.5 text-xs font-semibold text-muted-foreground">{t('drawer_details')}</p>
          <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 text-xs">
            {fact(
              t('drawer_account'),
              accountLabel ? (
                <span className="inline-flex items-center gap-1.5">
                  {accountLogo && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={accountLogo} alt="" className="h-4 w-4 rounded-sm object-contain" />
                  )}
                  {accountLabel}
                </span>
              ) : null,
            )}
            {fact(t('drawer_bank_text'), originalName ?? transaction.original_description ?? null)}
            {fact(t('drawer_counterparty'), giroCounterparty ? giroText.sentence(giroCounterparty) : null)}
            {fact(t('drawer_counterparty_iban'), counterpartyIban ? <span className="tabular-nums">{counterpartyIban}</span> : null)}
            {fact(t('drawer_method'), methodLabel)}
            {transaction.currency !== 'SEK' && transaction.amount_sek != null
              ? fact(t('drawer_amount_fx'), <span className="tabular-nums">{formatCurrency(transaction.amount_sek)}</span>)
              : null}
            {fact(t('drawer_org_number'), orgNumber)}
            {instructed
              ? fact(
                  t('drawer_instructed_amount'),
                  <span className="tabular-nums">
                    {formatCurrency(instructed.amount, instructed.currency)}
                    {rateText ? ` · ${t('drawer_instructed_rate', { rate: rateText })}` : ''}
                  </span>,
                )
              : null}
            {fact(t('drawer_balance_after'), balanceAfter ? <span className="tabular-nums">{balanceAfter}</span> : null)}
            {booked
              ? fact(
                  t('drawer_voucher'),
                  <span className="inline-flex flex-wrap gap-2">
                    {linkedEntryIds.map((entryId, index) => {
                      const link = voucherLinks.find((l) => l.journal_entry_id === entryId)
                      return (
                        <Link key={entryId} href={`/bookkeeping/${entryId}`} className={QUIET_LINK_CLASS}>
                          {(link ? embeddedVoucherLabel(link) : null) ??
                            (index === 0 ? t('drawer_open_voucher') : `+${index}`)}
                        </Link>
                      )
                    })}
                  </span>,
                )
              : null}
            {skvCounterpartDate ? fact(t('skv_counterpart_label'), t('skv_counterpart_body', { date: skvCounterpartDate })) : null}
          </dl>
          {isPreMigration && <p className="mt-3 text-xs text-muted-foreground">{t('pre_migration_foldout')}</p>}
          {extra ? <div className="mt-3">{extra}</div> : null}
        </div>
        )}
      </div>
    </aside>,
    document.body,
  )
}
