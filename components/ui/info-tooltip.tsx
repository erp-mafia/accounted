'use client'

import * as React from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { Info, HelpCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

const TooltipProvider = TooltipPrimitive.Provider

const Tooltip = TooltipPrimitive.Root

const TooltipTrigger = TooltipPrimitive.Trigger

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  // Portal the content to document.body so the tooltip is never clipped by an
  // ancestor with overflow (e.g. a scrollable DialogContent — the send-invoice
  // and journal-review dialogs use overflow-y-auto, which otherwise crops it).
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 overflow-hidden rounded-lg border border-border/60 bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
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
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          {children ? (
            <span className={cn('inline-flex items-center gap-1.5 cursor-help', className)}>
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
                'inline-flex items-center justify-center rounded-full p-0.5 text-muted-foreground/70 hover:text-muted-foreground hover:bg-muted/50 transition-colors cursor-help',
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
    </TooltipProvider>
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
