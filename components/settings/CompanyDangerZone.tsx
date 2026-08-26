'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
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
import { Loader2 } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { getBranding } from '@/lib/branding/service'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { CompanyMigrationResetDialog } from '@/components/settings/CompanyMigrationResetDialog'
import { CompanyMigrationArchiveRow } from '@/components/settings/CompanyMigrationArchiveRow'

const branding = getBranding()

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
export function CompanyDangerZone() {
  const t = useTranslations('settings_company')
  const tRetention = useTranslations('retention_notice')
  const router = useRouter()
  const { toast } = useToast()
  const { company, role } = useCompany()

  const [showDialog, setShowDialog] = useState(false)
  const [showResetDialog, setShowResetDialog] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [isDeleting, setIsDeleting] = useState(false)

  if (!company || role !== 'owner') return null

  async function handleDelete() {
    if (!company) return
    if (confirmText.trim() !== company.name.trim()) return

    setIsDeleting(true)
    try {
      const res = await fetch(`/api/company/${company.id}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm_name: confirmText }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || t('danger_delete_failed_default'))
      }

      toast({ title: t('danger_deleted_title'), description: company.name })
      // Stay inside settings. If the user had another company, the dashboard
      // layout will resolve it and /settings/account still renders as
      // normal. If this was their last company, the layout falls into the
      // no-company shell rooted at /settings/account.
      router.push('/settings/account')
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

      <SettingsDangerZone label={t('danger_heading')}>
        <SettingsRow label={t('reset_row_label')}>
          <SettingsRowNote>{t('reset_row_note')}</SettingsRowNote>
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
          label={t('danger_button')}
          borderless
          // The full BFL retention copy (incl. the backup link) lives behind
          // the "?": the visible row stays one quiet line.
          help={<RetentionNotice variant="company" className="border-0 bg-transparent p-0" />}
        >
          <SettingsRowNote>{tRetention('company_title')}</SettingsRowNote>
          <SettingsRowEnd>
            <button
              type="button"
              onClick={() => setShowDialog(true)}
              className="text-sm font-medium text-destructive underline underline-offset-2 transition-colors duration-150 hover:text-destructive/80"
            >
              {t('danger_button')}
            </button>
          </SettingsRowEnd>
        </SettingsRow>
      </SettingsDangerZone>

      <Dialog
        open={showDialog}
        onOpenChange={(open) => {
          if (isDeleting) return
          setShowDialog(open)
          if (!open) setConfirmText('')
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
            <Button
              variant="outline"
              onClick={() => {
                setShowDialog(false)
                setConfirmText('')
              }}
              disabled={isDeleting}
            >
              {t('danger_cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={confirmText.trim() !== company.name.trim() || isDeleting}
            >
              {isDeleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('danger_deleting')}
                </>
              ) : (
                t('danger_button')
              )}
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
