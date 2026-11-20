/**
 * Handle <-> UUID, the format itself (see ./registry.ts for what a handle
 * is and why). Pure functions, no I/O.
 */
import { isUuid } from '@/lib/invariants/uuid'
import { handleResource, resourceForPrefix, type HandleType } from './registry'

/**
 * Anything shaped like a handle: lowercase letters, an underscore, 32
 * lowercase hex. Shape only; parseHandle() also requires a known prefix.
 */
const HANDLE_SHAPE_RE = /^([a-z]{1,8})_([0-9a-f]{32})$/

/** A parsed handle: its type and the UUID it spells. */
export interface ParsedHandle {
  type: HandleType
  prefix: string
  uuid: string
}

/** The UUID as 32 lowercase hex: the part of a handle after the prefix. */
function uuidToHex(uuid: string): string {
  return uuid.replace(/-/g, '').toLowerCase()
}

/** 32 hex back to the canonical lowercase 8-4-4-4-12 UUID. */
function hexToUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * The handle of a row: `<prefix>_<uuid as 32 lowercase hex>`. Null when the
 * value is not a UUID, so a caller can never stamp a handle on an id that is
 * not one.
 */
export function toHandle(type: HandleType, uuid: unknown): string | null {
  if (!isUuid(uuid)) return null
  return `${handleResource(type).prefix}_${uuidToHex(uuid)}`
}

/**
 * The type and UUID a handle names, or null when the value is not a handle
 * of a known prefix (a plain UUID, a handle-shaped string with an unknown
 * prefix, anything else).
 */
export function parseHandle(value: unknown): ParsedHandle | null {
  if (typeof value !== 'string') return null
  const match = HANDLE_SHAPE_RE.exec(value)
  if (!match) return null
  const resource = resourceForPrefix(match[1]!)
  if (!resource) return null
  return { type: resource.type as HandleType, prefix: resource.prefix, uuid: hexToUuid(match[2]!) }
}

/** The JSON Schema pattern a type's handles match, for the published spec. */
export function handlePattern(type: HandleType): string {
  return `^${handleResource(type).prefix}_[0-9a-f]{32}$`
}
