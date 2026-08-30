import Link from 'next/link'
import { headers } from 'next/headers'
import { MailCheck, MailWarning, Mails } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/server'
import { resolveLandingDestination } from '@/lib/company/landing-server'

/**
 * Landing page for email-change confirmation clicks (/auth/callback redirects
 * here for type=email_change). Swedish-only like the other (auth) surfaces:
 * the reader may not even have a session, so user-preference locale does not
 * apply.
 *
 * Secure email change requires a click in BOTH mails (new address + current
 * address), and this page is the only feedback the user gets after each
 * click, so it must say exactly what remains.
 */

type EmailChangeStatus = 'partial' | 'done' | 'failed'

const CONTENT: Record<
  EmailChangeStatus,
  { heading: string; body: string; cta: string; href: string }
> = {
  partial: {
    heading: 'Ett klick kvar',
    body: 'Din bekräftelse är registrerad. Av säkerhetsskäl skickades två mail, ett till din nya adress och ett till din nuvarande. Öppna det andra mailet och klicka på länken där för att slutföra bytet.',
    cta: 'Gå till startsidan',
    href: '/',
  },
  done: {
    heading: 'E-postadressen är ändrad',
    body: 'Klart! Din nya e-postadress gäller nu när du loggar in med e-post. Loggar du in med Google fortsätter det att fungera som vanligt.',
    cta: 'Gå till startsidan',
    href: '/',
  },
  failed: {
    heading: 'Länken är ogiltig eller har gått ut',
    body: 'Bekräftelselänken kunde inte användas. Begär bytet igen under Inställningar: Konto, så skickas två nya bekräftelsemail direkt.',
    cta: 'Gå till kontoinställningar',
    href: '/settings/account',
  },
}

function isEmailChangeStatus(value: string | undefined): value is EmailChangeStatus {
  return value === 'partial' || value === 'done' || value === 'failed'
}

export default async function EmailChangeStatusPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>
}) {
  const { status } = await searchParams
  const resolved: EmailChangeStatus = isEmailChangeStatus(status) ? status : 'failed'
  const content = CONTENT[resolved]

  // On completion the CTA goes where the callback would have sent the user
  // before this page existed (WL-14: byrå staff on their home domain land in
  // the cockpit, everyone else on the dashboard). Any failure degrades to '/'.
  let href = content.href
  if (resolved === 'done') {
    try {
      const supabase = await createClient()
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (user) {
        const headerStore = await headers()
        const host =
          headerStore.get('x-forwarded-host') ?? headerStore.get('host') ?? ''
        href = await resolveLandingDestination(supabase, user.id, host)
      }
    } catch {
      href = content.href
    }
  }
  const Icon =
    resolved === 'done' ? MailCheck : resolved === 'partial' ? Mails : MailWarning

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm animate-slide-up text-center">
        <div className="flex justify-center mb-4">
          <div className="h-14 w-14 rounded-lg bg-secondary flex items-center justify-center">
            <Icon className="h-7 w-7 text-primary" />
          </div>
        </div>
        <h1 className="font-display text-3xl tracking-tight">{content.heading}</h1>
        <p className="text-muted-foreground text-sm mt-2">{content.body}</p>
        <Button asChild className="mt-8 h-11 px-6">
          <Link href={href}>{content.cta}</Link>
        </Button>
      </div>
    </div>
  )
}
