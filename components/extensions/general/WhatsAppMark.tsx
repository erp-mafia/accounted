/**
 * WhatsApp brand mark.
 *
 * Inline SVG rather than a bundled asset: it scales, needs no network
 * request, and survives the CSP. The green (#25D366) is WhatsApp's own and
 * is deliberately the one place in settings where a brand colour appears:
 * this marks a third-party channel, so it is identity, not chrome (see
 * .claude/rules/design.md on colour belonging to actors).
 *
 * Decorative by default. Pass a `title` when the mark carries meaning that
 * the surrounding text does not already state.
 */

interface WhatsAppMarkProps {
  /** Edge length in px of the rounded tile. */
  size?: number
  /** Accessible name. Omit when adjacent text already says "WhatsApp". */
  title?: string
  className?: string
}

export function WhatsAppMark({ size = 28, title, className }: WhatsAppMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={className}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      <rect width="48" height="48" rx="10" fill="#25D366" />
      <path
        fill="#FFFFFF"
        d="M32.9 26.8c-.5-.3-3-1.5-3.4-1.6-.5-.2-.8-.3-1.1.2-.3.5-1.3 1.6-1.6 2-.3.3-.6.4-1.1.1-.5-.3-2.1-.8-4-2.5-1.5-1.3-2.5-3-2.8-3.5-.3-.5 0-.8.2-1 .2-.2.5-.6.8-.9.2-.3.3-.5.5-.8.2-.3.1-.6 0-.9-.1-.3-1.1-2.7-1.5-3.7-.4-1-.8-.8-1.1-.9h-1c-.3 0-.9.1-1.3.6-.5.5-1.7 1.7-1.7 4.2 0 2.4 1.8 4.8 2 5.1.2.3 3.5 5.4 8.6 7.6 1.2.5 2.1.8 2.9 1.1 1.2.4 2.3.3 3.2.2 1-.1 3-1.2 3.4-2.4.4-1.2.4-2.2.3-2.4-.1-.2-.5-.3-1-.6z"
      />
      <path
        fill="#FFFFFF"
        d="M24.1 8h-.1c-8.8 0-16 7.2-16 16 0 2.8.7 5.6 2.1 8L8 40l8.2-2.1c2.3 1.3 5 1.9 7.8 1.9h.1c8.8 0 16-7.2 16-16s-7.1-15.8-16-15.8zm9.4 25.2c-2.5 2.5-5.9 3.9-9.4 3.9-2.4 0-4.7-.6-6.7-1.9l-.5-.3-5 1.3 1.3-4.9-.3-.5c-1.4-2.2-2.1-4.7-2.1-7.3 0-7.4 6-13.4 13.4-13.4 3.6 0 6.9 1.4 9.4 3.9 2.5 2.5 3.9 5.9 3.9 9.5.1 3.6-1.4 6.9-3.9 9.4z"
      />
    </svg>
  )
}
