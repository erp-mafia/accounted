'use client'

import { useId, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ChevronRightIcon } from '@/components/icons'
import { cn } from '@/lib/utils'

/**
 * The Inkorg's motion, in one place. Springs are critically damped (bounce
 * 0, design.md: no overshoot), so a thing settles without passing its place
 * and an interrupted one starts from where it is on screen. Reduced motion
 * gets a short cross-fade instead of any movement.
 */
export const SPRING = { type: 'spring', bounce: 0, duration: 0.35 } as const
export const FADE = { duration: 0.15 } as const

/**
 * A fold: the label as a button, the content opening under it and closing
 * back the same way it came. Controlled (open, onToggle) or on its own
 * (defaultOpen). The content mounts only while open, so what it reads is
 * read when someone looks.
 */
export function Fold({
  label,
  open: controlled,
  onToggle,
  defaultOpen = false,
  className,
  buttonClassName,
  children,
}: {
  label: ReactNode
  open?: boolean
  onToggle?: (open: boolean) => void
  defaultOpen?: boolean
  className?: string
  buttonClassName?: string
  children: ReactNode
}) {
  const reduced = useReducedMotion() ?? false
  const [own, setOwn] = useState(defaultOpen)
  const open = controlled ?? own
  const contentId = useId()

  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => {
          if (controlled === undefined) setOwn(!open)
          onToggle?.(!open)
        }}
        className={cn(
          'flex w-full cursor-pointer items-center gap-2 py-3 text-left text-[13px] font-medium transition-colors duration-150 active:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          buttonClassName,
        )}
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150', open && 'rotate-90')}
        />
        {label}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="fold"
            id={contentId}
            initial={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduced ? { opacity: 1, transition: FADE } : { height: 'auto', opacity: 1, transition: SPRING }}
            exit={reduced ? { opacity: 0, transition: FADE } : { height: 0, opacity: 0, transition: SPRING }}
            style={{ overflow: 'hidden' }}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
