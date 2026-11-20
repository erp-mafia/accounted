'use client'

import { useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { AttnLine } from '@/components/ui/attn-line'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import { startPollLoop } from '@/components/bank-feed/poll-loop'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { FORM_OUT_STATES } from '@/lib/payments/orders/verification-state'
import { verificationReadiness, verificationStep } from '@/lib/payments/orders/readiness'
import { VerificationStateText } from './VerificationStateText'
import { fetchCompanyVerification, PaymentsClientError, startCompanyVerification, type CompanyVerification } from './payments-client'

/** The provider's form is filled in by hand: a quarter minute between looks while one opened here is out. */
const VERIFICATION_POLL_MS = 15_000

interface PaymentsVerificationLineProps {
  /**
   * The company's verification as GET /api/payments/availability answered it,
   * read once when the line mounts. The host renders the line only where the
   * payment at hand needs it (readiness verification_needed or
   * verification_pending).
   */
  verification: CompanyVerification
  /** The supplier invoice list's bulk bar: one short sentence beside the payment buttons. */
  compact?: boolean
  /** Every new state this line learns (a form started, the provider's answer), for a host that outlives it. */
  onChange?: (verification: CompanyVerification) => void
}

/**
 * Where a person is about to pay through the bank and the company's
 * verification stands in the way: one line, and the one step that moves it
 * (Verifiera företaget, Skapa ny länk, Förnya verifieringen), so the way to
 * the verification is where the payment is, not only under Inställningar.
 * A form that is out shows its status and no button (the form opened here
 * can be opened again); the line goes once the provider answers valid.
 */
export function PaymentsVerificationLine({ verification, compact = false, onChange }: PaymentsVerificationLineProps) {
  const t = useTranslations('bank_payments')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const [current, setCurrentState] = useState<CompanyVerification>(verification)
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])
  const setCurrent = (next: CompanyVerification) => {
    setCurrentState(next)
    onChangeRef.current?.(next)
  }
  /** The form opened from this line in this sitting, so it can be opened again. */
  const [formUrl, setFormUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // A form opened here: ask the provider until it answers, so the line
  // leaves (or says what happened) without a reload.
  const watching = formUrl !== null && FORM_OUT_STATES.has(current.state)
  useEffect(() => {
    if (!watching) return
    return startPollLoop({
      poll: () => fetchCompanyVerification({ refresh: true }),
      onResult: (next) => {
        setCurrentState(next)
        onChangeRef.current?.(next)
        return FORM_OUT_STATES.has(next.state)
      },
      intervalMs: VERIFICATION_POLL_MS,
    })
  }, [watching])

  async function start() {
    setBusy(true)
    try {
      const started = await startCompanyVerification()
      window.open(started.url, '_blank', 'noopener,noreferrer')
      setFormUrl(started.url)
      setCurrent({ ...current, state: started.state, link_expires_at: started.expires_at })
    } catch (error) {
      const body = error instanceof PaymentsClientError ? error.body : null
      toast({ title: t('verification_failed_title'), description: getErrorMessage(body, { locale }), variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const readiness = verificationReadiness(current.state)
  if (readiness !== 'verification_needed' && readiness !== 'verification_pending') return null

  const step = verificationStep(current.state, { formAtHand: formUrl !== null })
  const openForm = () => {
    if (formUrl) window.open(formUrl, '_blank', 'noopener,noreferrer')
  }

  if (readiness === 'verification_pending') {
    return (
      <p role="status" className="text-xs leading-5 text-muted-foreground">
        {compact ? t('verification_pending_short') : <VerificationStateText verification={current} />}
        {step === 'open_form' && (
          <>
            {' '}
            <button type="button" className={QUIET_LINK_CLASS} onClick={openForm}>
              {t('open_verification_form')}
            </button>
          </>
        )}
      </p>
    )
  }

  const label = step === 'renew' ? t('renew_company') : step === 'new_link' ? t('new_verification_link') : t('verify_company')
  return (
    <AttnLine action={canWrite && !busy ? { label, onClick: () => void start() } : undefined}>
      {compact ? t('verification_needed_short') : current.state === 'not_started' ? t('verify_required') : <VerificationStateText verification={current} />}
    </AttnLine>
  )
}
