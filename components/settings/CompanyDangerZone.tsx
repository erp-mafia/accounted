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
import { Loader2 } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { getBranding } from '@/lib/branding/service'

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
  const router = useRouter()
  const { toast } = useToast()
  const { company, role } = useCompany()

  const [showDialog, setShowDialog] = useState(false)
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
        description: err instanceof Error ? err.message : t('danger_try_again'),
        variant: 'destructive',
      })
      setIsDeleting(false)
    }
  }

  return (
    <>
      <section className="space-y-4 border-t border-border pt-8">
        <h2 className="text-sm font-medium uppercase tracking-wider text-destructive">
          {t('danger_heading')}
        </h2>

        <RetentionNotice variant="company" />

        <div className="flex justify-end">
          <Button
            variant="destructive"
            className="w-full sm:w-auto"
            onClick={() => setShowDialog(true)}
          >
            {t('danger_button')}
          </Button>
        </div>
      </section>

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
            <DialogTitle>{t('danger_dialog_title', { companyName: company.name })}</DialogTitle>
            <DialogDescription>
              {t('danger_dialog_description', { appName: branding.appName.toLowerCase() })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="company-delete-confirm">
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
    </>
  )
}
