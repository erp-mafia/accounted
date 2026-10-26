'use client'

import { useState } from 'react'
import { useTranslations, useLocale } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useCompany } from '@/contexts/CompanyContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { RetentionNotice } from '@/components/ui/retention-notice'
import {
  SettingsDangerZone,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
} from '@/components/settings/SettingsRows'
import { useToast } from '@/components/ui/use-toast'
import { getBranding } from '@/lib/branding/service'
import { getErrorMessage as getUserErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { CompanyMigrationResetDialog } from '@/components/settings/CompanyMigrationResetDialog'
import { CompanyMigrationArchiveRow } from '@/components/settings/CompanyMigrationArchiveRow'
import {
  afterCompanyDeleteHref,
  type CompanyDeleteDoor,
} from '@/components/settings/company-deletion'

const branding = getBranding()

interface CompanyDangerZoneProps {
  /**
   * Which door opened the delete dialog, null while it is closed. The section
   * owns it because the dialog has a second door outside this zone: the locked
   * org number row (company-deletion.ts).
   */
  deleteDoor: CompanyDeleteDoor | null
  onDeleteDoorChange: (door: CompanyDeleteDoor | null) => void
}

/**
 * Danger zone for the currently-active company. Only visible to owners.
 *
 * Archive = soft delete: companies.archived_at is stamped via
 * POST /api/company/[id]/delete. All bookkeeping data is retained per
 * BFL 7 kap. 2§; the row just disappears from the user's UI.
 *
 * TODO(bankid): once users have a linked BankID identity, wrap the
 * confirm step in a BankID signature gate. Guarded behind a
 * capabilities.bankIdLinked boolean fetched from the user profile.
 */
export function CompanyDangerZone({ deleteDoor, onDeleteDoorChange }: CompanyDangerZoneProps) {
  const t = useTranslations('settings_company')
  const errorLocale = useLocale() as ErrorLocale
  const tRetention = useTranslations('retention_notice')
  const router = useRouter()
  const { toast } = useToast()
  const { company, role } = useCompany()

  const [showResetDialog, setShowResetDialog] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [isDeleting, setIsDeleting] = useState(false)

  if (!company || role !== 'owner') return null

  function closeDeleteDialog() {
    onDeleteDoorChange(null)
    setConfirmText('')
  }

  async function handleDelete() {
    if (!company || !deleteDoor) return
    if (confirmText.trim() !== company.name.trim()) return

    setIsDeleting(true)
    try {
      const res = await fetch(`/api/company/${company.id}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm_name: confirmText }),
      })

      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(getUserErrorMessage(body, { locale: errorLocale, fallback: t('danger_delete_failed_default') }))
      }

      toast({ title: t('danger_deleted_title'), description: company.name })
      // The door decides what the delete was for: on to adding the right
      // company, or settings and the delete-account action (crm#1042).
      router.push(afterCompanyDeleteHref(deleteDoor, body?.data?.nextCompanyId))
      router.refresh()
    } catch (err) {
      toast({
        title: t('danger_delete_failed_title'),
        description: err instanceof Error ? getUserErrorMessage(err) : t('danger_try_again'),
        variant: 'destructive',
      })
      setIsDeleting(false)
    }
  }

  return (
    <>
      <CompanyMigrationArchiveRow companyId={company.id} />

      {/* Both destructive actions ask for a typed confirmation first. Said
          once, behind the zone's "?": a reader who does not dare press the
          link can find that out without pressing it (issue #2214). */}
      <SettingsDangerZone label={t('danger_heading')} help={t('danger_confirm_hint')}>
        <SettingsRow label={t('reset_row_label')}>
          <SettingsRowNote className="min-w-0">{t('reset_row_note')}</SettingsRowNote>
          <SettingsRowEnd>
            <button
              type="button"
              onClick={() => setShowResetDialog(true)}
              className="text-sm font-medium text-destructive underline underline-offset-2 transition-colors duration-150 hover:text-destructive/80"
            >
              {t('reset_row_action')}
            </button>
          </SettingsRowEnd>
        </SettingsRow>
        <SettingsRow
          // The label says what deleting does; the action says "Radera".
          label={t('danger_delete_row_label')}
          borderless
          // The full BFL retention copy (incl. the backup link) lives behind
          // the "?": the visible row stays one quiet line.
          help={<RetentionNotice variant="company" className="border-0 bg-transparent p-0" />}
        >
          <SettingsRowNote className="min-w-0">{tRetention('company_title')}</SettingsRowNote>
          <SettingsRowEnd>
            <button
              type="button"
              onClick={() => onDeleteDoorChange('danger_zone')}
              className="text-sm font-medium text-destructive underline underline-offset-2 transition-colors duration-150 hover:text-destructive/80"
            >
              {t('danger_delete_row_action')}
            </button>
          </SettingsRowEnd>
        </SettingsRow>
      </SettingsDangerZone>

      <Dialog
        open={deleteDoor !== null}
        onOpenChange={(open) => {
          if (isDeleting || open) return
          closeDeleteDialog()
        }}
      >
        <DialogContent>
          <DialogHeader>
            {/* data-ph-mask: the title interpolates the company name */}
            <DialogTitle data-ph-mask="">{t('danger_dialog_title', { companyName: company.name })}</DialogTitle>
            <DialogDescription>
              {t('danger_dialog_description', { appName: branding.appName.toLowerCase() })}
            </DialogDescription>
          </DialogHeader>
          {/* Wrong-company door: say what comes after the delete, and the one
              thing to do before it. The delete leaves a bank connection
              active, and a hidden company's connection is out of the owner's
              reach: the consent can only be withdrawn beforehand. */}
          {deleteDoor === 'wrong_company' && (
            <p className="text-sm text-muted-foreground">{t('danger_dialog_wrong_company_note')}</p>
          )}
          {/* The same one thing to do first, from the Radera företag row too
              (a byrå clearing out test companies comes this way, crm#1237). */}
          {deleteDoor === 'danger_zone' && (
            <p className="text-sm text-muted-foreground">{t('danger_dialog_bank_note')}</p>
          )}
          {/* The delete ends the company's subscription (crm#1373), from
              either door: a hidden company is never charged again. */}
          <p className="text-sm text-muted-foreground">{t('danger_dialog_subscription_note')}</p>
          <div className="space-y-2">
            {/* data-ph-mask: the label interpolates the company name */}
            <Label data-ph-mask="" htmlFor="company-delete-confirm">
              {t.rich('danger_confirm_label', {
                companyName: company.name,
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </Label>
            <Input
              id="company-delete-confirm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={company.name}
              autoComplete="off"
              // ph-no-capture: the placeholder is the company name, and
              // replay masking covers values, not attributes.
              className="ph-no-capture"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeDeleteDialog} disabled={isDeleting}>
              {t('danger_cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={confirmText.trim() !== company.name.trim()}
              loading={isDeleting}
            >
              {isDeleting ? t('danger_deleting') : t('danger_button')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CompanyMigrationResetDialog
        companyId={company.id}
        companyName={company.name}
        open={showResetDialog}
        onOpenChange={setShowResetDialog}
      />
    </>
  )
}
