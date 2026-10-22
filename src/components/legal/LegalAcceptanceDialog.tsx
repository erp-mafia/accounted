'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { LEGAL_DOCUMENTS, type LegalDocumentKey } from '@/lib/legal/documents'

export interface LegalAcceptanceDialogProps {
  /** The documents to accept, each at its current version (lib/legal/acceptance currentAcceptanceVersions). */
  documents: Array<{ key: LegalDocumentKey; version: string }>
  /** The stored analytics choice, so an earlier yes is not asked away. */
  initialAnalytics: boolean | null
  /** The open company, or null (byrå cockpit, onboarding). */
  company: { id: string; name: string } | null
  /** Owner or admin of that company: only they see the contribution switch. */
  canDecideForCompany: boolean
}

/**
 * The acceptance prompt: the documents to agree to, the person's analytics
 * choice and, for an owner or admin, the company's content contribution, on
 * one screen. Two buttons of the same design and weight (PTS: refusing must
 * be as easy as accepting, in the same view): "Godkänn villkoren" keeps the
 * switches as set, "Godkänn allt" turns them on. Both switches start off.
 *
 * Not dismissable: the documents are what the service runs on. It never
 * locks anyone out of their books, though: the export link opens the archive
 * export, where the gate does not render (LegalAcceptanceGate).
 */
export function LegalAcceptanceDialog({ documents, initialAnalytics, company, canDecideForCompany }: LegalAcceptanceDialogProps) {
  const t = useTranslations('legal_acceptance')
  const locale = useLocale() as ErrorLocale
  const router = useRouter()
  const { toast } = useToast()
  const [analytics, setAnalytics] = useState(initialAnalytics === true)
  const [contribution, setContribution] = useState(false)
  const [busy, setBusy] = useState<'accept_all' | 'accept_documents' | null>(null)

  const showContribution = company !== null && canDecideForCompany
  const links: LegalDocumentKey[] = [...documents.map((d) => d.key), 'privacy']

  async function accept(method: 'accept_all' | 'accept_documents') {
    setBusy(method)
    const all = method === 'accept_all'
    try {
      const res = await fetch('/api/legal/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documents,
          method,
          analytics_consent: all || analytics,
          ...(company ? { company_id: company.id } : {}),
          ...(showContribution ? { content_contribution: all || contribution } : {}),
        }),
      })
      const body = await res.json().catch(() => null)
      if (res.status === 409) {
        // The documents changed while the prompt was open: read the new ones first.
        toast({ title: t('stale') })
        router.refresh()
        return
      }
      if (!res.ok) {
        toast({ title: t('failed'), description: getErrorMessage(body, { statusCode: res.status, locale }), variant: 'destructive' })
        return
      }
      // The layout re-reads the acceptance and the consent: the prompt goes,
      // and analytics starts if the person said yes.
      router.refresh()
    } catch (error) {
      toast({ title: t('failed'), description: getErrorMessage(error, { locale }), variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent
        className="max-w-lg [&>button]:hidden"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('intro')}</DialogDescription>
        </DialogHeader>

        <ul className="space-y-2 text-[13px]">
          {links.map((key) => (
            <li key={key}>
              <Link
                href={LEGAL_DOCUMENTS[key].path}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 underline underline-offset-4"
              >
                {t(`doc_${key}`)}
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>

        <div className="space-y-4 border-t border-border pt-4">
          <ChoiceRow
            id="legal-analytics"
            label={t('analytics_label')}
            help={t('analytics_help')}
            checked={analytics}
            onChange={setAnalytics}
            disabled={busy !== null}
          />
          {company && canDecideForCompany ? (
            <ChoiceRow
              id="legal-contribution"
              label={t('contribution_label')}
              help={t('contribution_help', { company: company.name })}
              checked={contribution}
              onChange={setContribution}
              disabled={busy !== null}
            />
          ) : null}
          {company ? <p className="text-[12.5px] text-muted-foreground">{t('pooling_note', { company: company.name })}</p> : null}
        </div>

        {company ? (
          <p className="text-[12.5px] text-muted-foreground">
            {t('export_note')}{' '}
            <Link href="/import#full-archive" className="underline underline-offset-4">
              {t('export_link')}
            </Link>
          </p>
        ) : null}

        <DialogFooter>
          {/* Same variant, same size, side by side: neither choice is the easy one. */}
          <Button variant="outline" onClick={() => void accept('accept_documents')} loading={busy === 'accept_documents'} disabled={busy !== null}>
            {t('accept_documents')}
          </Button>
          <Button variant="outline" onClick={() => void accept('accept_all')} loading={busy === 'accept_all'} disabled={busy !== null}>
            {t('accept_all')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ChoiceRow({
  id,
  label,
  help,
  checked,
  onChange,
  disabled,
}: {
  id: string
  label: string
  help: string
  checked: boolean
  onChange: (next: boolean) => void
  disabled: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <label htmlFor={id} className="flex flex-col gap-1 text-[13px]">
        <span>{label}</span>
        <span className="text-[12.5px] text-muted-foreground">{help}</span>
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} className="mt-1" />
    </div>
  )
}
