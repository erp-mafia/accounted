'use client'

import { useLocale, useTranslations } from 'next-intl'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import type { BridgeLine, ReconciliationAccount, ReconciliationStatus } from '@/lib/reconciliation/schemas'

/**
 * Shell v2 summary of one account's reconciliation (concept reconflow, step
 * 2): the outside against the ledger on one line with the difference beside
 * them, then the rows that explain the difference, ending with what is still
 * unexplained. One table in place of four tiles and a list that carried the
 * same numbers twice.
 *
 * The bridge lines are shown with the signs the service gives them (the
 * same list v1 rendered under the tiles), in the Differens column because
 * that is what they explain.
 */

const MAIN_EXTERNAL: ReadonlySet<string> = new Set(['bank_transactions', 'external_balance', 'specification'])
const MAIN_LEDGER: ReadonlySet<string> = new Set(['ledger_balance'])
const LEDGER_DETAIL: ReadonlySet<string> = new Set(['opening_balance', 'movement'])

const NUM = 'whitespace-nowrap py-1.5 pl-4 text-right tabular-nums'

export function ReconciliationSummary({
  status,
  kind,
  specificationLabel,
}: {
  status: ReconciliationStatus
  kind: ReconciliationAccount['kind']
  specificationLabel: string | null
}) {
  const t = useTranslations('reconciliation')
  const locale = useLocale()
  const currency = status.currency
  const money = (n: number | null | undefined) => (n == null ? t('tile_unknown') : formatCurrency(n, currency))
  const label = (line: BridgeLine) => (locale === 'en' ? line.label_en : line.label_sv)

  const external = status.bridge.find((l) => MAIN_EXTERNAL.has(l.key))?.amount ?? status.external_balance
  const ledger = status.bridge.find((l) => MAIN_LEDGER.has(l.key))?.amount ?? status.ledger_balance
  const ledgerDetail = status.bridge.filter((l) => LEDGER_DETAIL.has(l.key))
  const explanations = status.bridge.filter(
    (l) => !MAIN_EXTERNAL.has(l.key) && !MAIN_LEDGER.has(l.key) && !LEDGER_DETAIL.has(l.key),
  )
  const unexplained = status.unexplained_difference
  const settled = unexplained != null && Math.abs(unexplained) < 0.005

  const externalHead =
    kind === 'bank'
      ? t('v2_col_external_bank')
      : kind === 'skattekonto'
        ? t('v2_col_external_skv')
        : (specificationLabel ?? t('v2_col_external_manual'))
  const mainLabel =
    kind === 'bank'
      ? t('v2_row_movement')
      : kind === 'skattekonto'
        ? t('v2_row_balance')
        : t('v2_row_balance_at', { date: formatDate(status.as_of.slice(0, 10)) })

  return (
    <div className="max-w-[760px] overflow-x-auto stagger-enter">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="text-[11px] font-medium uppercase tracking-[0.07em] text-muted-foreground">
            <th className="w-full py-1.5 text-left font-medium" aria-hidden="true"></th>
            <th className={cn(NUM, 'font-medium')}>{externalHead}</th>
            <th className={cn(NUM, 'font-medium')}>{t('v2_col_ledger', { account: status.account_number })}</th>
            <th className={cn(NUM, 'font-medium')}>{t('v2_col_diff')}</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-t border-border">
            <td className="py-1.5">{mainLabel}</td>
            <td className={NUM} data-ph-mask>
              {money(external)}
            </td>
            <td className={NUM} data-ph-mask>
              {money(ledger)}
            </td>
            <td className={NUM} data-ph-mask>
              {money(status.difference)}
            </td>
          </tr>
          {ledgerDetail.map((line) => (
            <tr key={line.key} className="text-muted-foreground">
              <td className="py-1 pl-4">{label(line)}</td>
              <td className={NUM} />
              <td className={NUM} data-ph-mask>
                {formatCurrency(line.amount, currency)}
              </td>
              <td className={NUM} />
            </tr>
          ))}
          {explanations.map((line) => (
            <tr key={line.key} className="text-muted-foreground">
              <td className="py-1 pl-4">
                {label(line)}
                {line.count != null && line.count > 0 && (
                  <span className="ml-1.5 tabular-nums text-muted-foreground/70" data-ph-mask>
                    ({line.count})
                  </span>
                )}
              </td>
              <td className={NUM} />
              <td className={NUM} />
              <td className={NUM} data-ph-mask>
                {formatCurrency(line.amount, currency)}
              </td>
            </tr>
          ))}
          <tr className="border-t border-border font-medium">
            <td className="py-1.5">{t('v2_row_unexplained')}</td>
            <td className={NUM} />
            <td className={NUM} />
            <td
              className={cn(NUM, unexplained == null ? 'text-muted-foreground' : settled ? 'text-success' : 'text-warning')}
              data-ph-mask
            >
              {money(unexplained)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}
