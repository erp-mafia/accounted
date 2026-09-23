import Link from 'next/link'
import { cn } from '@/lib/utils'

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
  className?: string
}

/**
 * Attention is one ochre sentence, not a banner (UI-migration convention 6):
 * a single 12.5px line in the attn tone with an optional embedded action
 * link. Max one per page.
 */
export function AttnLine({ children, action, trailing, className }: AttnLineProps) {
  return (
    <p className={cn('text-[12.5px] leading-5 text-attn', className)}>
      {children}
      {action && (
        <>
          {' '}
          {action.href ? (
            <Link
              href={action.href}
              className="underline underline-offset-2 hover:opacity-80"
            >
              {action.label}
            </Link>
          ) : (
            <button
              type="button"
              onClick={action.onClick}
              className="underline underline-offset-2 hover:opacity-80"
            >
              {action.label}
            </button>
          )}
        </>
      )}
      {trailing}
    </p>
  )
}
