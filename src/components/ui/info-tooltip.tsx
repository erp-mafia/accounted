'use client'

import * as React from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { Info, HelpCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { POPOVER_SURFACE_CLASS, RADIX_POPOVER_MOTION_CLASS } from '@/components/ui/popover-surface'

const TooltipProvider = TooltipPrimitive.Provider

const Tooltip = TooltipPrimitive.Root

const TooltipTrigger = TooltipPrimitive.Trigger

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  // Portal the content to document.body so the tooltip is never clipped by an
  // ancestor with overflow (e.g. a scrollable DialogContent: the send-invoice
  // and journal-review dialogs use overflow-y-auto, which otherwise crops it).
  <TooltipPrimitive.Portal>
    {/* data-ph-unmask: tooltip help text is static i18n chrome in session
        replays; content carrying user data adds data-ph-mask at the call site. */}
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      data-ph-unmask=""
      className={cn(
        'z-50 overflow-hidden px-3 py-2 text-sm',
        POPOVER_SURFACE_CLASS,
        RADIX_POPOVER_MOTION_CLASS,
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

interface InfoTooltipProps {
  content: React.ReactNode
  children?: React.ReactNode
  className?: string
  iconClassName?: string
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  variant?: 'info' | 'help'
  maxWidth?: string
}

/**
 * InfoTooltip - En återanvändbar tooltip-komponent för kontextuell hjälp
 *
 * Användning:
 * <InfoTooltip content="Förklaring här">
 *   <span>Text att förklara</span>
 * </InfoTooltip>
 *
 * Eller som fristående info-ikon:
 * <InfoTooltip content="Förklaring här" />
 */
function InfoTooltip({
  content,
  children,
  className,
  iconClassName,
  side = 'top',
  align = 'center',
  variant = 'info',
  maxWidth = '280px',
}: InfoTooltipProps) {
  const Icon = variant === 'help' ? HelpCircle : Info

  return (
      <Tooltip>
        <TooltipTrigger asChild>
          {children ? (
            // tabIndex is what makes this branch reachable at all. Radix opens a
            // tooltip on focus as well as hover, but TooltipTrigger with asChild
            // only forwards props: it never adds tabIndex, and a bare <span>
            // cannot take focus, so the focus handler never fired and everything
            // behind a labelled tooltip was mouse-only. WCAG 2.1 asks for
            // keyboard access to content shown on hover, and .claude/rules/design
            // asks for it too.
            //
            // Not a <button>: six of the nine call sites sit inside a
            // <label htmlFor>, where a button would swallow the click that
            // focuses the field. And no role="button" either, since there is
            // nothing to activate. Focus IS the interaction, and Radix already
            // wires aria-describedby to the content while it is open.
            <span
              tabIndex={0}
              className={cn(
                'inline-flex items-center gap-1.5 cursor-help rounded-sm',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                className,
              )}
            >
              {children}
              <Icon
                className={cn(
                  'h-3.5 w-3.5 text-muted-foreground/70 hover:text-muted-foreground transition-colors flex-shrink-0',
                  iconClassName
                )}
              />
            </span>
          ) : (
            <button
              type="button"
              className={cn(
                'inline-flex items-center justify-center rounded-full p-0.5 text-muted-foreground/70 hover:text-muted-foreground hover:bg-secondary/60 transition-colors cursor-help',
                className
              )}
            >
              <Icon className={cn('h-4 w-4', iconClassName)} />
              <span className="sr-only">Mer information</span>
            </button>
          )}
        </TooltipTrigger>
        <TooltipContent
          side={side}
          align={align}
          className="max-w-[var(--tooltip-max-width)]"
          style={{ '--tooltip-max-width': maxWidth } as React.CSSProperties}
        >
          <div className="text-sm leading-relaxed">{content}</div>
        </TooltipContent>
      </Tooltip>
  )
}

interface InfoTextProps {
  term: string
  explanation: string
  className?: string
  termClassName?: string
}

/**
 * InfoText - Kombination av primär text med fackterm i parentes
 *
 * Användning:
 * <InfoText term="Enkla avdrag" explanation="schablonavdrag" />
 * Visar: "Enkla avdrag (schablonavdrag)"
 */
function InfoText({ term, explanation, className, termClassName }: InfoTextProps) {
  return (
    <span className={className}>
      {term}
      <span className={cn('text-muted-foreground ml-1', termClassName)}>
        ({explanation})
      </span>
    </span>
  )
}

interface HelpLinkProps {
  href: string
  children: React.ReactNode
  className?: string
  external?: boolean
}

/**
 * HelpLink - Länk till mer information (t.ex. Skatteverket)
 */
function HelpLink({ href, children, className, external = true }: HelpLinkProps) {
  return (
    <a
      href={href}
      className={cn(
        'inline-flex items-center gap-1 text-primary hover:text-primary/80 underline-offset-4 hover:underline transition-colors text-sm',
        className
      )}
      {...(external && { target: '_blank', rel: 'noopener noreferrer' })}
    >
      {children}
    </a>
  )
}

export {
  InfoTooltip,
  InfoText,
  HelpLink,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
}
