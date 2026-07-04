'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Loader2, CircleSlash, Lock } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'

interface Props {
  entryId: string
  initialExempt: boolean
  initialReason: string | null
  canWrite: boolean
  onChange: (exempted: boolean, reason: string | null) => void
}

/**
 * Lets the bookkeeper mark a posted verifikation as not needing a separate
 * underlag (bankavgift, ränta, intern överföring etc.). Toggling persists via
 * /api/bookkeeping/journal-entries/[id]/no-document-required.
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

  const persistExempt = async (
    nextExempt: boolean,
    nextReason: string | null,
    previousReason: string,
  ) => {
    setSaving(true)
    try {
      const res = nextExempt
        ? await fetch(`/api/bookkeeping/journal-entries/${entryId}/no-document-required`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: nextReason ?? null }),
          })
        : await fetch(`/api/bookkeeping/journal-entries/${entryId}/no-document-required`, {
            method: 'DELETE',
          })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        toast({
          title: t('no_doc_required_save_failed'),
          description: body.error,
          variant: 'destructive',
        })
        // Roll back UI state on failure: both the toggle AND the reason so
        // the rendered state matches the DB row we failed to mutate.
        setExempt(!nextExempt)
        setReason(previousReason)
        return
      }

      onChange(nextExempt, nextExempt ? nextReason : null)
    } catch {
      toast({ title: t('no_doc_required_save_failed'), variant: 'destructive' })
      setExempt(!nextExempt)
      setReason(previousReason)
    } finally {
      setSaving(false)
    }
  }

  const handleToggle = (checked: boolean) => {
    const previousReason = reason
    setExempt(checked)
    if (!checked) {
      setReason('')
      setEditingReason(false)
    }
    persistExempt(checked, checked ? (reason.trim() || null) : null, previousReason)
  }

  const handleSaveReason = () => {
    setEditingReason(false)
    persistExempt(true, reason.trim() || null, reason)
  }

  return (
    <div className="mt-4 pt-3 border-t">
      <div className="flex items-center gap-2">
        <Switch
          id={`no-doc-${entryId}`}
          checked={exempt}
          onCheckedChange={handleToggle}
          disabled={!canWrite || saving}
        />
        <Label
          htmlFor={`no-doc-${entryId}`}
          className="text-sm cursor-pointer flex items-center gap-1.5"
        >
          {!canWrite && <Lock className="h-3 w-3" />}
          {saving && <Loader2 className="h-3 w-3 animate-spin" />}
          {!saving && exempt && <CircleSlash className="h-3.5 w-3.5 text-muted-foreground" />}
          {t('no_doc_required_toggle')}
        </Label>
      </div>

      {exempt && (
        <div className="mt-2 ml-10 space-y-1">
          {editingReason ? (
            <div className="flex items-center gap-2">
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t('no_doc_required_reason_placeholder')}
                list={`no-doc-suggestions-${entryId}`}
                maxLength={200}
                className="h-8 text-xs flex-1 max-w-sm"
                disabled={saving}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleSaveReason()
                  }
                }}
              />
              <datalist id={`no-doc-suggestions-${entryId}`}>
                <option value={t('no_doc_required_suggestion_bank_fee')} />
                <option value={t('no_doc_required_suggestion_interest')} />
                <option value={t('no_doc_required_suggestion_internal_transfer')} />
                <option value={t('no_doc_required_suggestion_tax_payment')} />
                <option value={t('no_doc_required_suggestion_salary')} />
              </datalist>
              <Button size="sm" variant="outline" className="h-8" onClick={handleSaveReason} disabled={saving}>
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
