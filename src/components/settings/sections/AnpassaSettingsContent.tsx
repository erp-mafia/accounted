'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import { SettingsLoadError } from '@/components/settings/SettingsLoadError'
import {
  SettingsGroup,
  SettingsInput,
  SettingsRow,
  SettingsSectionHeader,
} from '@/components/settings/SettingsRows'
import { useCompany } from '@/contexts/CompanyContext'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import type { AvailabilityStatus } from '@/lib/modules/capabilities'
import { cn } from '@/lib/utils'

/** One package as the Anpassa page shows it, resolved on the server. */
export interface AnpassaPackage {
  id: string
  switchable: boolean
  availability: AvailabilityStatus
  /** Switched off by the company or its profile (off or winding down). */
  switchedOff: boolean
  /** What keeps a switched-off package winding down (obligation codes). */
  openObligations: string[]
  /** Why switching it on would be refused (a PACKAGE_* code), or null. */
  switchOnBlocked: string | null
}

interface AnpassaSettingsContentProps {
  profileNameSv: string
  profileName: string
  /** Null when the capabilities could not be read. */
  packages: AnpassaPackage[] | null
  /** The package to open the page at (?package=<id>, from the Inkorg); null or unknown opens it at the top. */
  focusPackageId?: string | null
}

type OffPreview = { state: 'loading' } | { state: 'ready'; obligations: string[] } | { state: 'failed' }

/**
 * Företag → Anpassa: which parts of Accounted the company uses. Bokföring is
 * always on; every other package has a switch. Switching off first shows
 * what is still open and will keep the package winding down (the dry run of
 * POST /api/packages/:id); both directions stage the switch and approve it
 * through the commit door every staged operation has, so the decision gets
 * its receipt and its dated line in behandlingshistorik. Owners and admins
 * switch; everyone else sees the same statuses read-only.
 */
export function AnpassaSettingsContent({ profileNameSv, profileName, packages, focusPackageId = null }: AnpassaSettingsContentProps) {
  const t = useTranslations('settings_anpassa')
  const locale = useLocale() as ErrorLocale
  const router = useRouter()
  const { toast } = useToast()
  const { role } = useCompany()
  const canSwitch = role === 'owner' || role === 'admin'
  const [busy, setBusy] = useState<string | null>(null)
  const [offTarget, setOffTarget] = useState<AnpassaPackage | null>(null)
  const [offPreview, setOffPreview] = useState<OffPreview>({ state: 'loading' })

  // The asked-for package's row: scrolled to, with the keyboard on its switch. A ref
  // callback, so it runs once, when the row exists.
  const focusRow = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    node.scrollIntoView({ block: 'nearest' })
    node.querySelector<HTMLElement>('[role="switch"]')?.focus({ preventScroll: true })
  }, [])

  if (!packages) return <SettingsLoadError onRetry={() => router.refresh()} />

  const nameOf = (id: string) => t(`packages.${id}.name`)
  const list = (codes: string[]) =>
    new Intl.ListFormat(locale, { type: 'conjunction' }).format(codes.map((code) => t(`obligations.${code}`)))

  async function switchPackage(pkg: AnpassaPackage, enabled: boolean): Promise<void> {
    const name = nameOf(pkg.id)
    setBusy(pkg.id)
    try {
      const staged = await fetch(`/api/packages/${pkg.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      const stagedBody = await staged.json().catch(() => null)
      if (!staged.ok) {
        toast({
          title: t('switch_failed', { name }),
          description: getErrorMessage(stagedBody, { statusCode: staged.status, locale }),
          variant: 'destructive',
        })
        return
      }
      const operationId = stagedBody?.data?.pending_operation_id as string
      const committed = await fetch(`/api/pending-operations/${operationId}/commit`, { method: 'POST' })
      const committedBody = await committed.json().catch(() => null)
      if (!committed.ok) {
        const reason = getErrorMessage(committedBody, { statusCode: committed.status, locale })
        toast({
          title: t('switch_failed', { name }),
          description: committed.status === 403 ? `${reason} ${t('waiting_for_admin')}` : reason,
          variant: 'destructive',
        })
        return
      }
      const result = committedBody?.data as { winding_down?: boolean } | undefined
      if (enabled) toast({ title: t('switched_on', { name }) })
      else if (result?.winding_down) toast({ title: t('winding_down_toast', { name }), description: t('winding_down_toast_description', { name }) })
      else toast({ title: t('switched_off', { name }) })
      // The menu, the agent's tools and this page read the new switch.
      router.refresh()
    } catch (error) {
      toast({ title: t('switch_failed', { name }), description: getErrorMessage(error, { locale }), variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  async function openOffDialog(pkg: AnpassaPackage) {
    setOffTarget(pkg)
    setOffPreview({ state: 'loading' })
    try {
      const res = await fetch(`/api/packages/${pkg.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false, dry_run: true }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        setOffPreview({ state: 'failed' })
        return
      }
      const obligations = Array.isArray(body?.data?.open_obligations) ? (body.data.open_obligations as string[]) : []
      setOffPreview({ state: 'ready', obligations })
    } catch {
      setOffPreview({ state: 'failed' })
    }
  }

  const alwaysOn = packages.filter((p) => !p.switchable)
  const switchable = packages.filter((p) => p.switchable)
  const offName = offTarget ? nameOf(offTarget.id) : ''

  return (
    <div>
      <SettingsSectionHeader title={t('title')} intro={t('intro')} />

      <SettingsGroup>
        <SettingsRow label={t('profile_label')} help={t('profile_help')}>
          <SettingsInput value={locale === 'en' ? profileName : profileNameSv} disabled readOnly aria-label={t('profile_label')} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup label={t('always_on_group')}>
        {alwaysOn.map((pkg) => (
          <SettingsRow key={pkg.id} label={<PackageLabel name={nameOf(pkg.id)} note={t(`packages.${pkg.id}.description`)} />}>
            <Switch checked disabled aria-label={t('always_on')} />
          </SettingsRow>
        ))}
      </SettingsGroup>

      <SettingsGroup label={t('packages_group')} help={canSwitch ? t('packages_help_admin') : t('packages_help_member')}>
        {switchable.map((pkg) => {
          const name = nameOf(pkg.id)
          const blocked = pkg.switchedOff && pkg.switchOnBlocked !== null
          const note =
            pkg.availability === 'winding_down' && pkg.openObligations.length > 0
              ? t('winding_down_note', { obligations: list(pkg.openObligations) })
              : blocked
                ? t(`blocked_${pkg.switchOnBlocked}`)
                : t(`packages.${pkg.id}.description`)
          const focused = pkg.id === focusPackageId
          const row = (
            <SettingsRow
              key={pkg.id}
              label={<PackageLabel name={name} note={note} />}
              // The asked-for package stands out on a quiet band; its text stays in line with the others.
              className={cn(focused && '-mx-3 rounded-lg border-transparent bg-secondary/50 px-3')}
            >
              {pkg.availability === 'winding_down' ? <Badge variant="warning">{t('winding_down_badge')}</Badge> : null}
              {pkg.availability === 'not_in_plan' ? <Badge variant="outline">{t('not_in_plan_badge')}</Badge> : null}
              {pkg.availability === 'not_in_country' ? <Badge variant="outline">{t('not_in_country_badge')}</Badge> : null}
              <Switch
                checked={!pkg.switchedOff}
                disabled={!canSwitch || busy !== null || blocked || pkg.availability === 'not_in_country'}
                aria-label={t('switch_aria', { name })}
                onCheckedChange={(next) => {
                  if (next) void switchPackage(pkg, true)
                  else void openOffDialog(pkg)
                }}
              />
            </SettingsRow>
          )
          return focused ? (
            <div key={pkg.id} ref={focusRow}>
              {row}
            </div>
          ) : (
            row
          )
        })}
      </SettingsGroup>

      <ConfirmDialog
        open={offTarget !== null}
        onOpenChange={(open) => {
          if (!open) setOffTarget(null)
        }}
        title={t('off_dialog_title', { name: offName })}
        confirmLabel={t('off_dialog_confirm', { name: offName })}
        onConfirm={async () => {
          if (offTarget) await switchPackage(offTarget, false)
        }}
        description={
          offPreview.state === 'ready' && offPreview.obligations.length > 0
            ? t('off_dialog_winding', { name: offName })
            : offPreview.state === 'loading'
              ? t('off_dialog_loading', { name: offName })
              : t('off_dialog_clean', { name: offName })
        }
      >
        {offPreview.state === 'loading' ? (
          <div className="space-y-2" aria-hidden>
            <Skeleton className="h-4 w-3/4 rounded-sm" />
            <Skeleton className="h-4 w-1/2 rounded-sm" />
          </div>
        ) : offPreview.state === 'ready' && offPreview.obligations.length > 0 ? (
          <div className="space-y-3 text-[13px]">
            <ul className="list-disc space-y-1 pl-4">
              {offPreview.obligations.map((code) => (
                <li key={code}>{t(`obligations.${code}`)}</li>
              ))}
            </ul>
            <p className="text-muted-foreground">{t('off_dialog_after', { name: offName })}</p>
          </div>
        ) : null}
      </ConfirmDialog>
    </div>
  )
}

/** A package's name with one muted line under it: what it contains, or what keeps it winding down. */
function PackageLabel({ name, note }: { name: string; note: string }) {
  return (
    <span className="flex flex-col gap-1">
      <span>{name}</span>
      <span className="text-xs text-muted-foreground">{note}</span>
    </span>
  )
}
