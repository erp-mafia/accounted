import type { AgentPanelFloatRect, AgentPanelState } from '@/types'

/**
 * Pure geometry for the assistant panel (components/agent/AgentSheet).
 *
 * The panel has two modes:
 *  - docked: full-height sheet on the right edge; the page panel gives up
 *    `width + DOCK_GUTTER` of right margin (via --agent-dock-w) so content
 *    reflows beside the panel instead of being covered by it.
 *  - floating: a free window the user drags and resizes anywhere; the page
 *    keeps its full width and the user decides what the window may cover.
 *
 * All clamping lives here, testable and shared between the live drag path
 * (imperative style writes) and the persisted-preference path.
 */

export const DOCK_WIDTH_DEFAULT = 480
export const DOCK_WIDTH_MIN = 380
export const DOCK_WIDTH_MAX = 800
/** Frame gutter added on top of the panel width when reserving page margin,
 *  so panel and page float side by side with the same 10px seam as the frame. */
export const DOCK_GUTTER = 10
/** The page keeps at least this much width before the docked panel stops growing. */
export const MIN_PAGE_WIDTH = 480
/** Ceiling for the expanded (focus) width; beyond this a chat column stops
 *  gaining readability. */
export const EXPANDED_WIDTH_MAX = 1100

export const FLOAT_MIN_W = 360
export const FLOAT_MIN_H = 400
export const FLOAT_DEFAULT_W = 420
export const FLOAT_DEFAULT_H = 640
/** Gap kept between a freshly spawned floating panel and the viewport edge. */
export const FLOAT_SPAWN_MARGIN = 24
/** At least this much of the panel stays inside the viewport, so the header
 *  (the drag surface) is always reachable to drag it back. */
export const FLOAT_KEEP_ON_SCREEN = 48

/** Resolved, always-valid panel preferences (persisted shape is all-optional). */
export interface ResolvedAgentPanelPrefs {
  mode: 'docked' | 'floating'
  dockWidth: number
  float: AgentPanelFloatRect | null
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * Normalize a persisted (or absent, or garbage) agent_panel value into a
 * usable preference object. Viewport-dependent clamping happens at use time;
 * this only guards types and hard bounds.
 */
export function resolveAgentPanelPrefs(
  raw: AgentPanelState | null | undefined,
): ResolvedAgentPanelPrefs {
  const mode = raw?.mode === 'floating' ? 'floating' : 'docked'
  const dockWidth = finite(raw?.dock_width)
    ? Math.min(Math.max(raw.dock_width, DOCK_WIDTH_MIN), DOCK_WIDTH_MAX)
    : DOCK_WIDTH_DEFAULT
  const f = raw?.float
  const float =
    f && finite(f.x) && finite(f.y) && finite(f.w) && finite(f.h)
      ? { x: f.x, y: f.y, w: f.w, h: f.h }
      : null
  return { mode, dockWidth, float }
}

/** Persisted wire shape (integers: the API schema rejects fractional pixels). */
export function serializeAgentPanelPrefs(prefs: ResolvedAgentPanelPrefs): AgentPanelState {
  return {
    mode: prefs.mode,
    dock_width: Math.round(prefs.dockWidth),
    ...(prefs.float
      ? {
          float: {
            x: Math.round(prefs.float.x),
            y: Math.round(prefs.float.y),
            w: Math.round(prefs.float.w),
            h: Math.round(prefs.float.h),
          },
        }
      : {}),
  }
}

/**
 * Clamp a docked width so the page keeps MIN_PAGE_WIDTH beside the panel.
 * `navWidth` is the sidebar column (--nav-w); on viewports too small for
 * both minimums the panel floor wins (the md: margin is inert there anyway).
 */
export function clampDockWidth(px: number, viewportW: number, navWidth: number): number {
  const available = Math.max(DOCK_WIDTH_MIN, viewportW - navWidth - MIN_PAGE_WIDTH - DOCK_GUTTER)
  const max = Math.min(DOCK_WIDTH_MAX, available)
  return Math.round(Math.min(Math.max(px, DOCK_WIDTH_MIN), max))
}

/**
 * Width of the expanded (focus) panel: as wide as the viewport allows while
 * the page keeps MIN_PAGE_WIDTH, capped at EXPANDED_WIDTH_MAX. Unlike the
 * old fixed 1100px overlay, this reserves page margin like the compact dock.
 */
export function expandedDockWidth(viewportW: number, navWidth: number): number {
  const available = viewportW - navWidth - MIN_PAGE_WIDTH - DOCK_GUTTER
  return Math.round(Math.min(EXPANDED_WIDTH_MAX, Math.max(DOCK_WIDTH_DEFAULT, available)))
}

/** Keep a floating rect at legal size and reachably on screen. */
export function clampFloatRect(
  rect: AgentPanelFloatRect,
  viewportW: number,
  viewportH: number,
): AgentPanelFloatRect {
  const w = Math.round(Math.min(Math.max(rect.w, FLOAT_MIN_W), Math.max(FLOAT_MIN_W, viewportW)))
  const h = Math.round(Math.min(Math.max(rect.h, FLOAT_MIN_H), Math.max(FLOAT_MIN_H, viewportH)))
  // Horizontally the panel may hang off either side as long as
  // FLOAT_KEEP_ON_SCREEN of it stays visible; vertically the header must
  // never go above the top edge (it is the only drag surface).
  const x = Math.round(
    Math.min(Math.max(rect.x, FLOAT_KEEP_ON_SCREEN - w), viewportW - FLOAT_KEEP_ON_SCREEN),
  )
  const y = Math.round(Math.min(Math.max(rect.y, 0), Math.max(0, viewportH - FLOAT_KEEP_ON_SCREEN)))
  return { x, y, w, h }
}

/**
 * Snap a floating rect fully inside the viewport. clampFloatRect above only
 * guarantees FLOAT_KEEP_ON_SCREEN of the panel stays reachable (so a live
 * drag may deliberately hang off an edge), which means a rect persisted at
 * the edge, or on a larger monitor, legally renders as a 48px sliver on the
 * next open. This is the open/resize-time validation: whole window visible.
 * The output is always a fixpoint of clampFloatRect (w and h end up >= the
 * minimums, x and y inside the reachability bounds), so the render clamp
 * applied afterwards stays a no-op.
 */
export function containFloatRect(
  rect: AgentPanelFloatRect,
  viewportW: number,
  viewportH: number,
): AgentPanelFloatRect {
  const w = Math.round(Math.min(Math.max(rect.w, FLOAT_MIN_W), Math.max(FLOAT_MIN_W, viewportW)))
  const h = Math.round(Math.min(Math.max(rect.h, FLOAT_MIN_H), Math.max(FLOAT_MIN_H, viewportH)))
  const x = Math.round(Math.min(Math.max(rect.x, 0), Math.max(0, viewportW - w)))
  const y = Math.round(Math.min(Math.max(rect.y, 0), Math.max(0, viewportH - h)))
  return { x, y, w, h }
}

/** First-undock placement: bottom-right, mirroring where the FAB lives. */
export function defaultFloatRect(viewportW: number, viewportH: number): AgentPanelFloatRect {
  const w = Math.min(FLOAT_DEFAULT_W, Math.max(FLOAT_MIN_W, viewportW - 2 * FLOAT_SPAWN_MARGIN))
  const h = Math.min(FLOAT_DEFAULT_H, Math.max(FLOAT_MIN_H, viewportH - 2 * FLOAT_SPAWN_MARGIN))
  return clampFloatRect(
    { x: viewportW - w - FLOAT_SPAWN_MARGIN, y: viewportH - h - FLOAT_SPAWN_MARGIN, w, h },
    viewportW,
    viewportH,
  )
}

export interface ResizeEdges {
  left?: boolean
  right?: boolean
  bottom?: boolean
}

/**
 * Apply a pointer drag delta to a floating rect from the given edges.
 * A left-edge drag moves x with the width so the right edge stays anchored,
 * including when the width clamp kicks in.
 */
export function resizeFloatRect(
  base: AgentPanelFloatRect,
  dx: number,
  dy: number,
  edges: ResizeEdges,
  viewportW: number,
  viewportH: number,
): AgentPanelFloatRect {
  let w = base.w
  if (edges.right) w = base.w + dx
  if (edges.left) w = base.w - dx
  const h = edges.bottom ? base.h + dy : base.h

  const clampedW = Math.min(Math.max(w, FLOAT_MIN_W), Math.max(FLOAT_MIN_W, viewportW))
  const x = edges.left ? base.x + (base.w - clampedW) : base.x

  return clampFloatRect({ x, y: base.y, w: clampedW, h }, viewportW, viewportH)
}
