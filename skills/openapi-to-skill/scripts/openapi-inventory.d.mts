/** Type surface of openapi-inventory.mjs for TypeScript consumers. */

export interface OperationObjectLite {
  operationId?: string
  summary?: string
  description?: string
  tags?: string[]
  deprecated?: boolean
  parameters?: unknown[]
  requestBody?: unknown
  responses?: Record<string, unknown>
  [extension: string]: unknown
}

export interface OperationEntry {
  path: string
  method: string
  op: OperationObjectLite
  pathItem: Record<string, unknown>
  segments: string[]
  depth: number
  group: string
}

export interface Inventory {
  title: string
  version: string
  description: string
  servers: string[]
  securitySchemes: Record<string, unknown>
  operationCount: number
  groups: Array<{ name: string; operations: OperationEntry[] }>
}

export function loadSpec(specPath: string): unknown
export function resolveRef(spec: unknown, ref: string): unknown
export function condenseSchema(
  spec: unknown,
  schema: unknown,
  opts?: { depth?: number; seen?: Set<string> },
): string
export function listOperations(spec: unknown): OperationEntry[]
export function buildInventory(spec: unknown): Inventory
export function formatOpLine(entry: OperationEntry): string
export function renderOperationMd(spec: unknown, entry: OperationEntry): string
