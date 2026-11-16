import Link from 'next/link'
import { cn } from '@/lib/utils'
import { StatusGlyph, type StatusTone } from '@/components/ui/status-glyph'

interface AttnLineProps {
  children: React.ReactNode
  /** Optional inline action at the end of the sentence. */
  action?: { label: string; href?: string; onClick?: () => void }
  /**
   * Optional quiet controls rendered inside the sentence after the action
   * (e.g. the notice line's "+N till" expander and dismiss). Style them
   * muted; the ochre tone belongs to the sentence and its action alone.
   */
  trailing?: React.ReactNode
  /** warning (default) or info: which glyph leads the sentence. */
  tone?: Extract<StatusTone, 'warning' | 'info'>
  className?: string
}

/**
 * Attention is one sentence, not a banner (UI-migration convention 6, Stil
 * v3): the amber status glyph with its cut-out mark, then a single 13px line
 * in the body ink with an optional embedded action link. Max one per page.
 * tone "info" (the blue glyph) is for a helpful fact, never a warning.
 */
export function AttnLine({ children, action, trailing, tone = 'warning', className }: AttnLineProps) {
  const actionClass =
    'font-medium text-strong underline decoration-foreground/25 underline-offset-[3px] transition-colors duration-150 hover:decoration-foreground/60'
  return (
    <div className={cn('flex items-start gap-2 text-[13px] leading-5 text-foreground/80', className)}>
      <StatusGlyph tone={tone} className="mt-[3px]" />
      <div className="min-w-0">
        {children}
        {action && (
          // A link or button does nothing on paper: the sentence prints, its action does not.
          <span className="print:hidden">
            {' '}
            {action.href ? (
              <Link href={action.href} className={actionClass}>
                {action.label}
              </Link>
            ) : (
              <button type="button" onClick={action.onClick} className={actionClass}>
                {action.label}
              </button>
            )}
          </span>
        )}
        {trailing}
      </div>
    </div>
  )
}
