import Link from 'next/link'
import { Lock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isSelfHosted } from '@/lib/env/public-flags'

/**
 * Inline paywall note for a feature that is visible but not entitled.
 * The feature stays on screen (conversion surface: never hide, disable
 * with an upsell), this note explains why it's disabled and links to
 * /settings/billing. Copy mirrors CAPABILITY_BLOCKED_MESSAGE_SV.
 *
 * On a SELF-HOST the note never mentions a subscription or links to the
 * hosted Stripe billing page: the only capabilities that can be blocked
 * there are the connector ones (everything local is always on), and their
 * remedy is a connector key or the instance's own upstream credentials.
 * Copy mirrors CAPABILITY_BLOCKED_MESSAGE_SELF_HOSTED_SV.
 */
export function UpgradeNote({ children, className }: { children?: React.ReactNode; className?: string }) {
  const frame = (content: React.ReactNode) => (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-lg border border-border bg-secondary/40 px-3 py-2.5 text-sm text-muted-foreground',
        className,
      )}
    >
      <Lock className="h-4 w-4 mt-0.5 shrink-0" />
      <span>{content}</span>
    </div>
  )
  if (isSelfHosted()) {
    return frame(
      <>
        Den här funktionen kräver en connector-nyckel från Accounted (GNUBOK_CONNECTOR_KEY) eller
        instansens egna API-uppgifter för tjänsten.
      </>,
    )
  }
  return frame(
    <>
      {children ?? 'Den här funktionen kräver ett abonnemang.'}{' '}
      <Link href="/settings/billing" className="underline underline-offset-2 text-foreground">
        Uppgradera
      </Link>
    </>,
  )
}
