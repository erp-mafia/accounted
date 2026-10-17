import { getTranslations } from 'next-intl/server'
import { KeyRound, MailCheck, UserPlus, type LucideIcon } from 'lucide-react'
import { confirmFormAction } from '@/lib/auth/confirm-link'
import { ConfirmLinkForm } from './confirm-link-form'

/**
 * The click an emailed auth link waits for (lib/auth/confirm-link.ts).
 * /auth/callback held the link's one-time token and sent the browser here;
 * the button posts back to the callback, which verifies it. Mail scanners
 * fetch this page but never press the button, so the token survives them.
 * Laid out like the reset-password page the recovery flow continues to.
 */

type LinkKind = 'recovery' | 'signup' | 'invite' | 'email_change' | 'other'

/**
 * The page repeats what the mail asked for. A magic link reaches a mailbox
 * only as the BankID signup confirmation ("Bekräfta din e-postadress"): no
 * flow here mails a magic-link sign-in. So it shares the signup copy, as
 * does GoTrue's generic email type.
 */
function linkKind(type: string | null): LinkKind {
  switch (type) {
    case 'recovery':
    case 'invite':
    case 'email_change':
      return type
    case 'signup':
    case 'magiclink':
    case 'email':
      return 'signup'
    default:
      return 'other'
  }
}

export default async function ConfirmLinkPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === 'string') query.set(key, value)
  }

  const t = await getTranslations('auth_confirm')
  const copy: Record<LinkKind, { title: string; subtitle: string; button: string; Icon: LucideIcon }> = {
    recovery: {
      title: t('recovery_title'),
      subtitle: t('recovery_subtitle'),
      button: t('recovery_button'),
      Icon: KeyRound,
    },
    signup: {
      title: t('signup_title'),
      subtitle: t('signup_subtitle'),
      button: t('signup_button'),
      Icon: MailCheck,
    },
    invite: {
      title: t('invite_title'),
      subtitle: t('invite_subtitle'),
      button: t('invite_button'),
      Icon: UserPlus,
    },
    email_change: {
      title: t('email_change_title'),
      subtitle: t('email_change_subtitle'),
      button: t('email_change_button'),
      Icon: MailCheck,
    },
    other: {
      title: t('other_title'),
      subtitle: t('other_subtitle'),
      button: t('other_button'),
      Icon: MailCheck,
    },
  }
  const { title, subtitle, button, Icon } = copy[linkKind(query.get('type'))]

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center bg-frame p-4">
      <div className="w-full max-w-sm animate-slide-up">
        <div className="text-center mb-10">
          <div className="flex justify-center mb-4">
            <div className="h-14 w-14 rounded-xl bg-primary/8 flex items-center justify-center">
              <Icon className="h-7 w-7 text-primary" />
            </div>
          </div>
          <h1 className="text-2xl tracking-tight">{title}</h1>
          <p className="text-muted-foreground text-sm mt-2">{subtitle}</p>
        </div>

        <div className="rounded-lg border bg-card p-6 space-y-4">
          <ConfirmLinkForm
            action={confirmFormAction(query)}
            label={button}
            busyLabel={t('verifying')}
          />
          <p className="text-xs text-muted-foreground text-center">{t('hint')}</p>
        </div>
      </div>
    </div>
  )
}
