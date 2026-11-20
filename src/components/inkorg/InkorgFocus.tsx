'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { AnimatePresence, motion, useReducedMotion, type Variants } from 'motion/react'
import { ArrowLeftIcon, ChevronLeftIcon, ChevronRightIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { focusPosition, neighbour, swipeStep } from '@/lib/inkorg/focus'
import { cn } from '@/lib/utils'
import { FADE, SPRING } from './motion'

/** How the next stage arrives: from the right going forward, from the left going back; `completed` when the last one finished. */
export interface FocusMotion {
  direction: 1 | -1 | 0
  completed: boolean
}

type Custom = FocusMotion & { reduced: boolean }

// The shared springs (./motion): critically damped, so a stage settles without
// passing its place and an interrupted one starts from where it is on screen.
// A finished one leaves a little slower, carrying its "Klart". Reduced motion
// gets a short cross-fade instead.
const SPRING_DONE = { ...SPRING, duration: 0.45 } as const

const VARIANTS: Variants = {
  enter: (c: Custom) =>
    c.reduced || c.direction === 0 ? { opacity: 0, x: 0 } : { opacity: 0, x: c.direction > 0 ? 48 : -48 },
  center: (c: Custom) => ({ opacity: 1, x: 0, transition: c.reduced ? FADE : SPRING }),
  exit: (c: Custom) =>
    c.reduced
      ? { opacity: 0, transition: FADE }
      : c.completed
        ? // A finished one leaves to the left, carrying its "Klart".
          { opacity: 0, x: -96, transition: SPRING_DONE }
        : { opacity: 0, x: c.direction < 0 ? 64 : -64, transition: SPRING },
}

/**
 * Whether content has scrolled under the sticky bar: a sentinel just above
 * it has left the viewport. Only then does the bar show its scroll edge.
 */
function useScrolledUnder(): [(el: HTMLDivElement | null) => void, boolean] {
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null)
  const [under, setUnder] = useState(false)
  useEffect(() => {
    if (!sentinel || typeof IntersectionObserver === 'undefined') return
    // The bar sticks 48px down, under the page's top bar.
    const observer = new IntersectionObserver(([entry]) => setUnder(!entry!.isIntersecting), { rootMargin: '-48px 0px 0px 0px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [sentinel])
  return [setSentinel, under]
}

function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(false)
  useEffect(() => {
    const query = window.matchMedia('(pointer: coarse)')
    const update = () => setCoarse(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return coarse
}

/**
 * The content area as one item at a time: back to the view, "N av M", the
 * previous and next buttons (J and K, Esc back: the page owns the keys),
 * and the stage. On a touch screen the stage follows the finger; it resists
 * at the first and the last item, and the flick's momentum decides whether
 * it moves on. The view's own stage renders the one in focus: a document
 * (FocusStage) or a purchase without underlag (MissingFocusStage).
 */
export function InkorgFocus({
  ids,
  focusId,
  motionState,
  viewLabel,
  onStep,
  onBack,
  renderStage,
}: {
  /** The queue, in order. */
  ids: readonly string[]
  focusId: string
  motionState: FocusMotion
  viewLabel: string
  onStep: (step: 1 | -1) => void
  onBack: () => void
  /** The stage for the one in focus. */
  renderStage: (id: string) => ReactNode
}) {
  const t = useTranslations('inkorg')
  const reduced = useReducedMotion() ?? false
  const coarse = useCoarsePointer()
  const stageRef = useRef<HTMLDivElement | null>(null)
  const inQueue = ids.includes(focusId)
  const position = focusPosition(ids, focusId)
  const canPrevious = neighbour(ids, focusId, -1) !== null
  const canNext = neighbour(ids, focusId, 1) !== null
  const custom: Custom = { ...motionState, reduced }
  const [sentinelRef, scrolledUnder] = useScrolledUnder()

  return (
    <div>
      <div ref={sentinelRef} aria-hidden="true" />
      {/* Translucent chrome over the content that scrolls under it, with a soft
          edge instead of a hairline, and only while something is under it.
          Reduced transparency makes it solid. */}
      <div
        className={cn(
          'sticky top-12 z-10 -mx-2 mb-6 flex h-12 items-center gap-2 px-2 transition-colors duration-150',
          scrolledUnder &&
            'bg-background/75 backdrop-blur-xl backdrop-saturate-150 reduced-transparency:bg-background reduced-transparency:backdrop-blur-none',
        )}
      >
        {scrolledUnder && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-full h-4 bg-background/60 backdrop-blur-md reduced-transparency:hidden"
            style={{ maskImage: 'linear-gradient(to bottom, black, transparent)', WebkitMaskImage: 'linear-gradient(to bottom, black, transparent)' }}
          />
        )}
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeftIcon aria-hidden="true" className="h-3.5 w-3.5" />
          {viewLabel}
        </Button>
        {position && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {t('position', { index: position.index, total: position.total })}
          </span>
        )}
        <span className="flex-1" />
        <span className="hidden text-xs text-muted-foreground lg:inline">{t('keys_hint')}</span>
        <Button variant="ghost" size="icon" aria-label={t('previous')} disabled={!canPrevious} onClick={() => onStep(-1)}>
          <ChevronLeftIcon className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" aria-label={t('next')} disabled={!canNext} onClick={() => onStep(1)}>
          <ChevronRightIcon className="h-4 w-4" />
        </Button>
      </div>

      <div className="relative overflow-x-clip">
        <AnimatePresence mode="popLayout" custom={custom}>
          {inQueue && (
            <motion.div
              key={focusId}
              custom={custom}
              variants={VARIANTS}
              initial="enter"
              animate="center"
              exit="exit"
              drag={coarse && !reduced ? 'x' : false}
              dragDirectionLock
              dragConstraints={{ left: 0, right: 0 }}
              // Follows the finger toward a neighbour, resists where there is none.
              dragElastic={{ left: canNext ? 0.9 : 0.15, right: canPrevious ? 0.9 : 0.15 }}
              dragTransition={{ bounceStiffness: 400, bounceDamping: 40 }}
              onDragEnd={(_, info) => {
                const step = swipeStep({
                  offset: info.offset.x,
                  velocity: info.velocity.x,
                  width: stageRef.current?.getBoundingClientRect().width ?? 0,
                  canPrevious,
                  canNext,
                })
                if (step !== 0) onStep(step)
              }}
              style={{ touchAction: 'pan-y' }}
            >
              {/* Measured for the swipe (AnimatePresence owns the motion element's ref). Only a
                  mounting stage sets it: the one still leaving must not clear it when it goes. */}
              <div
                ref={(el) => {
                  if (el) stageRef.current = el
                }}
              >
                {renderStage(focusId)}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
