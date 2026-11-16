'use client'

import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatRowAmount } from '@/lib/utils'

export interface PreviewVoucherLine {
  account_number: string
  debit: number
  credit: number
  description: string | null
}

/** A dialog's translator; its namespace carries th_account, th_debit, th_credit, cancel, preview and confirm. */
type DialogT = (key: 'th_account' | 'th_debit' | 'th_credit' | 'cancel' | 'preview' | 'confirm') => string

/** The lines of a voucher shown before it is posted (confirm up front). */
export function VoucherLinesTable({ lines, t }: { lines: readonly PreviewVoucherLine[]; t: DialogT }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('th_account')}</TableHead>
          <TableHead className="text-right">{t('th_debit')}</TableHead>
          <TableHead className="text-right">{t('th_credit')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {lines.map((line, index) => (
          <TableRow key={`${line.account_number}-${index}`}>
            <TableCell className="tabular-nums">{line.account_number}</TableCell>
            <TableCell className="text-right tabular-nums">{line.debit ? formatRowAmount(line.debit) : ''}</TableCell>
            <TableCell className="text-right tabular-nums">{line.credit ? formatRowAmount(line.credit) : ''}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/** A voucher dialog's error line. */
export function VoucherDialogError({ error }: { error: string | null }) {
  if (!error) return null
  return <div className="bg-destructive/8 rounded-lg p-3 text-sm text-destructive">{error}</div>
}

/**
 * The footer every voucher dialog shares (confirm up front): the voucher is
 * previewed first, and only a shown preview can be posted.
 */
export function VoucherDialogFooter({
  previewed,
  busy,
  onCancel,
  onRun,
  t,
}: {
  previewed: boolean
  busy: boolean
  onCancel: () => void
  /** dryRun true: preview; false: post. */
  onRun: (dryRun: boolean) => void
  t: DialogT
}) {
  return (
    <DialogFooter>
      <Button variant="outline" onClick={onCancel} disabled={busy}>
        {t('cancel')}
      </Button>
      <Button onClick={() => onRun(!previewed)} loading={busy}>
        {previewed ? t('confirm') : t('preview')}
      </Button>
    </DialogFooter>
  )
}
