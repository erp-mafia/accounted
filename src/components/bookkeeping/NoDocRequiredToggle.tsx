'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { LockClosedIcon, NoSymbolIcon, SpinnerIcon } from '@/components/icons'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'

interface Props {
  entryId: string
  initialExempt: boolean
  initialReason: string | null
  canWrite: boolean
  onChange: (exempted: boolean, reason: string | null) => void
}

/**
 * Lets the bookkeeper mark a posted verifikation as not needing a separate
 * underlag (bankavgift, ränta, intern överföring etc.). Persists via
 * /api/bookkeeping/journal-entries/[id]/no-document-required.
 *
 * Switching on asks for the optional reason first and marks on Spara, the
 * order the batch paths already use (their reason field sits beside the mark
 * button). It used to mark at once and offer the reason afterwards, which
 * cannot work in the "saknar underlag" view: a marked verifikat leaves that
 * list as soon as the mark is saved, taking the reason field with it
 * (crm#1003). Switching off still saves at once: there is nothing to ask.
 *
 * The flag lives in journal_entry_no_doc_required (sidecar) so the underlying
 * verifikation stays immutable per BFL.
 */
export default function NoDocRequiredToggle({
  entryId,
  initialExempt,
  initialReason,
  canWrite,
  onChange,
}: Props) {
  const t = useTranslations('journal_list')
  const { toast } = useToast()
  const [exempt, setExempt] = useState(initialExempt)
  const [reason, setReason] = useState(initialReason ?? '')
  const [saving, setSaving] = useState(false)
  const [editingReason, setEditingReason] = useState(false)
  // Switched on, reason step open, nothing saved yet.
  const [confirming, setConfirming] = useState(false)

  // Saves the flag: POST with the reason, or DELETE. A failure toasts here and
  // returns false; callers only change their state after a success, so the
  // rendered state never runs ahead of the stored row.
  const save = async (nextExempt: boolean, nextReason: string | null): Promise<boolean> => {
    setSaving(true)
    try {
      const res = nextExempt
        ? await fetch(`/api/bookkeeping/journal-entries/${entryId}/no-document-required`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: nextReason }),
          })
        : await fetch(`/api/bookkeeping/journal-entries/${entryId}/no-document-required`, {
            method: 'DELETE',
          })

      if (!res.ok) {
        // Resolve via the parsed body plus the status: the route answers
        // thrown errors with the canonical envelope `{ error: { code,
        // message } }`, and rendering that object as the toast description
        // would crash React ("Objects are not valid as a React child").
        const body = await res.json().catch(() => null)
        toast({
          title: t('no_doc_required_save_failed'),
          description: getErrorMessage(body, { statusCode: res.status }),
          variant: 'destructive',
        })
        return false
      }
      return true
    } catch {
      toast({ title: t('no_doc_required_save_failed'), variant: 'destructive' })
      return false
    } finally {
      setSaving(false)
    }
  }

  const handleToggle = async (checked: boolean) => {
    if (checked) {
      setConfirming(true)
      return
    }
    if (!exempt) {
      // Switched back off before Spara: nothing was saved.
      setConfirming(false)
      setReason('')
      return
    }
    if (await save(false, null)) {
      setExempt(false)
      setReason('')
      setEditingReason(false)
      onChange(false, null)
    }
  }

  const handleConfirm = async () => {
    const nextReason = reason.trim() || null
    if (await save(true, nextReason)) {
      setExempt(true)
      setConfirming(false)
      setReason(nextReason ?? '')
      onChange(true, nextReason)
    }
  }

  const handleSaveReason = async () => {
    const nextReason = reason.trim() || null
    if (await save(true, nextReason)) {
      setEditingReason(false)
      setReason(nextReason ?? '')
      onChange(true, nextReason)
    }
  }

  const reasonInputId = `no-doc-reason-${entryId}`
  const suggestionsId = `no-doc-suggestions-${entryId}`
  const reasonInput = (onSubmit: () => void) => (
    <>
      <Input
        id={reasonInputId}
        autoFocus
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={t('no_doc_required_reason_placeholder')}
        list={suggestionsId}
        maxLength={200}
        className="h-8 text-xs flex-1 max-w-sm"
        disabled={saving}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onSubmit()
          }
        }}
      />
      <datalist id={suggestionsId}>
        <option value={t('no_doc_required_suggestion_bank_fee')} />
        <option value={t('no_doc_required_suggestion_interest')} />
        <option value={t('no_doc_required_suggestion_internal_transfer')} />
        <option value={t('no_doc_required_suggestion_tax_payment')} />
        <option value={t('no_doc_required_suggestion_salary')} />
        <option value={t('no_doc_required_suggestion_archived_elsewhere')} />
      </datalist>
    </>
  )

  return (
    <div className="mt-4 pt-3 border-t">
      <div className="flex items-center gap-2">
        <Switch
          id={`no-doc-${entryId}`}
          checked={exempt || confirming}
          onCheckedChange={(checked) => void handleToggle(checked)}
          disabled={!canWrite || saving}
        />
        <Label
          htmlFor={`no-doc-${entryId}`}
          className="text-sm cursor-pointer flex items-center gap-1.5"
        >
          {!canWrite && <LockClosedIcon className="h-3 w-3" />}
          {saving && <SpinnerIcon className="h-3 w-3 animate-spin" />}
          {!saving && exempt && <NoSymbolIcon className="h-3.5 w-3.5 text-muted-foreground" />}
          {t('no_doc_required_toggle')}
        </Label>
      </div>

      {confirming && !exempt && (
        <div className="mt-2 ml-10 space-y-1">
          <Label htmlFor={reasonInputId} className="text-xs text-muted-foreground">
            {t('no_doc_required_reason_add')}
          </Label>
          <div className="flex flex-wrap items-center gap-2">
            {reasonInput(() => void handleConfirm())}
            <Button onClick={() => void handleConfirm()} loading={saving}>
              {t('no_doc_required_save_reason')}
            </Button>
            <Button variant="ghost" onClick={() => void handleToggle(false)} disabled={saving}>
              {t('no_doc_required_cancel')}
            </Button>
          </div>
        </div>
      )}

      {exempt && (
        <div className="mt-2 ml-10 space-y-1">
          {editingReason ? (
            <div className="flex items-center gap-2">
              {reasonInput(() => void handleSaveReason())}
              <Button variant="outline" onClick={() => void handleSaveReason()} disabled={saving}>
                {t('no_doc_required_save_reason')}
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => canWrite && setEditingReason(true)}
              disabled={!canWrite}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors text-left"
            >
              {reason
                ? `${t('no_doc_required_reason_label')}: ${reason}`
                : t('no_doc_required_reason_add')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
