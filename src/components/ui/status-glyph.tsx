import { cn } from '@/lib/utils'

export type StatusTone = 'warning' | 'info' | 'ok' | 'error'

const TONE_FILL: Record<StatusTone, string> = {
  warning: 'fill-warning',
  info: 'fill-ring',
  ok: 'fill-success',
  error: 'fill-destructive',
}

/**
 * Stil v3 status glyph: a filled circle in the tone's colour with the mark
 * cut out of it (the panel colour shows through), so the state reads by
 * shape as well as colour. 14px beside a sentence, 16px beside a title. The
 * sentence beside it carries the meaning: the glyph is decorative.
 */
export function StatusGlyph({ tone, size = 14, className }: { tone: StatusTone; size?: 14 | 16; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={cn('shrink-0', className)}
    >
      <circle cx="8" cy="8" r="6.5" className={TONE_FILL[tone]} />
      {tone === 'ok' ? (
        <path d="m5.3 8.2 1.8 1.8 3.6-3.8" fill="none" className="stroke-background" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      ) : tone === 'info' ? (
        <>
          <path d="M8 7.2v3.6" className="stroke-background" strokeWidth="1.4" strokeLinecap="round" fill="none" />
          <circle cx="8" cy="5.1" r="0.8" className="fill-background" />
        </>
      ) : (
        <>
          <path d="M8 4.8v3.6" className="stroke-background" strokeWidth="1.4" strokeLinecap="round" fill="none" />
          <circle cx="8" cy="10.9" r="0.8" className="fill-background" />
        </>
      )}
    </svg>
  )
}
