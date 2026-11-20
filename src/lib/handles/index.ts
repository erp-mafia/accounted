/**
 * Typed handles (`je_<32 hex>`): the public id format that names the kind of
 * record an id belongs to. registry.ts holds the contract (prefixes are
 * permanent), format.ts the handle <-> UUID conversion, fields.ts and path.ts
 * the request normalisation the v1 wrapper and the MCP dispatcher run.
 */
export {
  HANDLE_RESOURCES,
  handleResource,
  isHandleType,
  resourceForPrefix,
  typeForPathSegment,
  type HandlePrefix,
  type HandleResource,
  type HandleType,
} from './registry'
export { handlePattern, parseHandle, toHandle, type ParsedHandle } from './format'
export {
  mismatchFor,
  normalizeHandleFields,
  normalizeQueryValue,
  resolveIdValue,
  typeForField,
  type FieldTypeOverrides,
  type HandleMismatch,
  type NormalizeResult,
} from './fields'
export { normalizeHandlePath, pathParamTypes } from './path'
