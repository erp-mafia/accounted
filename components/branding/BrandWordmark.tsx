import { cn } from '@/lib/utils'
import { getBranding } from '@/lib/branding/service'

interface BrandWordmarkProps {
  /**
   * Visual size. `'hero'` is for landing/auth/onboarding hero slots (~the
   * same vertical weight as the old 240px logo image). `'inline'` matches
   * the old 30px image used in top-left nav contexts.
   */
  size?: 'hero' | 'inline'
  /**
   * Force lowercase rendering. Defaults to true to match the existing
   * font-display + `.toLowerCase()` pattern used elsewhere in the app.
   */
  lowercase?: boolean
  className?: string
}

/**
 * Text-only wordmark used in place of the legacy logo image on auth /
 * onboarding / sandbox / invite surfaces. Renders the active brand's
 * `appName` in Hedvig Letters Serif at weight 700: the display font is
 * single-weight on Google Fonts so 700 ends up synthetically bolded, but
 * that matches the requested aesthetic.
 */
export function BrandWordmark({
  size = 'hero',
  lowercase = true,
  className,
}: BrandWordmarkProps) {
  const branding = getBranding()
  const name = lowercase ? branding.appName.toLowerCase() : branding.appName
  return (
    <span
      className={cn(
        'font-display tracking-tight inline-block',
        size === 'hero' ? 'text-5xl md:text-6xl' : 'text-base',
        className,
      )}
      style={{ fontWeight: 700 }}
    >
      {name}
    </span>
  )
}
