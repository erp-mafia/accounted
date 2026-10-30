'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { AttnLine } from '@/components/ui/attn-line'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { HelpPopover } from '@/components/ui/help-popover'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { roundOre } from '@/lib/money'
import { formatCurrency } from '@/lib/utils'
import type { DispositionsProposal } from '@/lib/bokslut/types'
import type { DeferredTaxSnapshot } from '@/lib/bokslut/tax-provision/deferred-tax-service'
import { manualDifferencesOf, ManualDifferencesEditor, manualDraft, type ManualDraft } from './ManualDifferencesEditor'

/**
 * The K3 uppskjuten skatt of the year (BFNAR 2012:1 kap. 29): the temporary
 * differences it is computed from, the judgement whether the year's tax loss
 * is recognised (29.29), and differences entered by hand. Saving answers the
 * recalculated dispositions; the posting is the "Uppskjuten skatt" card.
 */
export function DeferredTaxCard({
  periodId,
  snapshot,
  onSaved,
}: {
  periodId: string
  snapshot: DeferredTaxSnapshot
  onSaved: (proposal: DispositionsProposal) => void
}) {
  const t = useTranslations('deferred_tax')
  const [lossRecognised, setLossRecognised] = useState(snapshot.assessment.loss_recognised)
  const [lossReason, setLossReason] = useState(snapshot.assessment.loss_reason ?? '')
  const [manual, setManual] = useState<ManualDraft[]>(() => snapshot.assessment.manual_items.map(manualDraft))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const kindLabel = {
    loss_carryforward: t('kind_loss_carryforward'),
    building: t('kind_building'),
    manual: t('kind_manual'),
  }

  const save = async () => {
    setError(null)
    const items = manualDifferencesOf(manual)
    if (!items) {
      setError(t('error_input'))
      return
    }
    if (lossRecognised && !lossReason.trim()) {
      setError(t('error_input'))
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`/api/bookkeeping/fiscal-periods/${periodId}/deferred-tax`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          loss_recognised: lossRecognised,
          loss_reason: lossRecognised ? lossReason.trim() : null,
          manual_items: items,
        }),
      })
      const body = await res.json()
      if (!res.ok) {
        setError(getErrorMessage(body?.error) || t('save_failed'))
        return
      }
      onSaved(body.data as DispositionsProposal)
    } catch (err) {
      setError(getErrorMessage(err) || t('save_failed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle className="text-base">{t('title')}</CardTitle>
          <HelpPopover>{t('hint')}</HelpPopover>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {snapshot.needsInputs && (
          <AttnLine>
            {t('needs_inputs', { opening: formatCurrency(snapshot.opening), change: formatCurrency(snapshot.change) })}
          </AttnLine>
        )}
        {snapshot.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('none')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('th_item')}</TableHead>
                <TableHead className="text-right">{t('th_difference')}</TableHead>
                <TableHead className="text-right">{t('th_deferred_tax')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {snapshot.items.map((item, index) => (
                <TableRow key={`${item.kind}-${index}`}>
                  <TableCell>{item.kind === 'manual' ? item.label : kindLabel[item.kind]}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(item.temporary_difference)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(item.deferred_tax)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <p className="text-[12.5px] tabular-nums text-muted-foreground">
          {t('summary', {
            opening: formatCurrency(snapshot.opening),
            closing: formatCurrency(snapshot.closing),
            change: formatCurrency(snapshot.change),
            rate: roundOre(snapshot.rate * 100),
          })}
        </p>

        {snapshot.closingDeficit > 0 && (
          <div className="space-y-2">
            <p className="text-sm tabular-nums">{t('deficit', { amount: formatCurrency(snapshot.closingDeficit) })}</p>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={lossRecognised} onCheckedChange={(checked) => setLossRecognised(checked === true)} />
              {t('loss_recognised')}
              <HelpPopover>{t('loss_help')}</HelpPopover>
            </label>
            {lossRecognised && (
              <div className="space-y-1.5">
                <Label htmlFor="deferred-tax-loss-reason">{t('loss_reason')}</Label>
                <Textarea
                  id="deferred-tax-loss-reason"
                  value={lossReason}
                  onChange={(e) => setLossReason(e.target.value)}
                  rows={2}
                />
              </div>
            )}
          </div>
        )}

        <ManualDifferencesEditor rows={manual} onChange={setManual} idPrefix="dt" />

        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end">
          <Button type="button" size="sm" onClick={() => void save()} loading={saving}>
            {t('save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
