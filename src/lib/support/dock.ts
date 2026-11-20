'use client'

import { useSyncExternalStore } from 'react'

/**
 * The support panel docked in the corner of the app
 * (components/support/SupportDock.tsx): whether it is open, and for which
 * door.
 *
 * The AI assistant often answers with where to go, and an answer in a dialog
 * over the page cannot be read while going there. Where the layout has
 * mounted a dock and the screen has room for it beside the page, a door that
 * leads to the assistant opens the dock and not a dialog of its own, and the
 * dock stays while the user moves between pages.
 *
 * Held here and not in a context: the doors are spread over the shell, the
 * pages and menus portaled out of both, and a door outside the dashboard
 * (the sign-in pages, an error boundary) has no dock to ask. `openSupportDock`
 * answers false there, and the door opens its dialog as before.
 */
export interface SupportDockState {
  open: boolean
  /** The subject of the door that opened it, for a message sent to the staff. */
  subject?: string
}

const CLOSED: SupportDockState = { open: false }

/** Tailwind `md`: the width the dock is drawn from (it is `hidden md:grid`). */
const DOCK_MIN_WIDTH_PX = 768

let state: SupportDockState = CLOSED
let mounted = 0
const listeners = new Set<() => void>()

function set(next: SupportDockState): void {
  state = next
  for (const listener of listeners) listener()
}

function screenHasRoom(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(`(min-width: ${DOCK_MIN_WIDTH_PX}px)`).matches
}

/** Called by the dock while it is on the page. Returns its release. */
export function mountSupportDock(): () => void {
  mounted += 1
  return () => {
    mounted = Math.max(0, mounted - 1)
    if (mounted === 0) closeSupportDock()
  }
}

/**
 * Opens the dock. False when there is none on this page or the screen is too
 * narrow for one: the caller then opens its own dialog. A dock that is
 * already open stays as it is, with the conversation and the subject it has.
 */
export function openSupportDock(request: { subject?: string } = {}, hasRoom: boolean = screenHasRoom()): boolean {
  if (mounted === 0 || !hasRoom) return false
  if (!state.open) set({ open: true, subject: request.subject })
  return true
}

export function closeSupportDock(): void {
  if (state.open) set(CLOSED)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function supportDockState(): SupportDockState {
  return state
}

export function useSupportDock(): SupportDockState {
  return useSyncExternalStore(subscribe, supportDockState, () => CLOSED)
}
