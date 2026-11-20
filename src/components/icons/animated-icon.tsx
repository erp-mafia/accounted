'use client'

import {
  useEffect,
  useImperativeHandle,
  useRef,
  type ComponentType,
  type HTMLAttributes,
  type Ref,
  type RefAttributes,
} from 'react'
import { useReducedMotion } from 'motion/react'
import { iconBoxProps, type IconPaint } from './icon-class'

/** Plays or resets an icon's animation from outside (the package's own handle). */
export interface IconHandle {
  startAnimation: () => void
  stopAnimation: () => void
}

/** An icon component as @heroicons-animated/react ships it. */
export type SourceIcon = ComponentType<HTMLAttributes<HTMLDivElement> & { size?: number } & RefAttributes<IconHandle>>

export interface IconProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'>, IconPaint {
  /** Take over the animation: the icon then no longer plays on hover by itself. */
  ref?: Ref<IconHandle>
}

// The element whose hover plays the icon: the nearest link, button or menu
// row, so a nav item or a button animates its icon from anywhere on it.
// Outside those the icon plays when the pointer is on the icon itself.
const TRIGGER = 'a,button,[role="button"],[role="menuitem"],[role="tab"],[role="option"],[data-icon-trigger]'

/**
 * The one adapter between the package and the app. The package wraps its
 * svg in a div sized by a pixel prop; here a span carries the caller's
 * className instead (so `h-4 w-4` sizes the glyph like it did on lucide),
 * the hover comes from the surrounding control, and nothing moves under
 * prefers-reduced-motion.
 */
export function AnimatedIcon({
  source: Source,
  className,
  style,
  strokeWidth,
  fill,
  ref,
  ...props
}: IconProps & { source: SourceIcon }) {
  const box = useRef<HTMLSpanElement>(null)
  const inner = useRef<IconHandle>(null)
  const reduceMotion = useReducedMotion() === true
  const controlled = ref != null

  useImperativeHandle(
    ref,
    () => ({
      startAnimation: () => {
        if (!reduceMotion) inner.current?.startAnimation()
      },
      stopAnimation: () => inner.current?.stopAnimation(),
    }),
    [reduceMotion],
  )

  useEffect(() => {
    const el = box.current
    if (!el || reduceMotion || controlled) return
    const trigger = el.closest<HTMLElement>(TRIGGER) ?? el
    const start = () => inner.current?.startAnimation()
    const stop = () => inner.current?.stopAnimation()
    trigger.addEventListener('mouseenter', start)
    trigger.addEventListener('mouseleave', stop)
    return () => {
      trigger.removeEventListener('mouseenter', start)
      trigger.removeEventListener('mouseleave', stop)
    }
  }, [reduceMotion, controlled])

  return (
    <span
      ref={box}
      data-icon=""
      aria-hidden={props['aria-label'] ? undefined : true}
      {...iconBoxProps(className, style, { strokeWidth, fill })}
      {...props}
    >
      {/* Passing a ref puts the package in controlled mode, so its own div-hover never fires. */}
      <Source ref={inner} size={24} className="contents" />
    </span>
  )
}
