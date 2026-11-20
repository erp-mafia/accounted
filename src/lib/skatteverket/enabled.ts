/**
 * Whether this installation runs the Skatteverket integration at all.
 *
 * The HTTP dispatcher refuses every Skatteverket route when it is off
 * (app/api/extensions/ext/[...path]/route.ts, EXTENSION_FEATURE_FLAGS);
 * crons, the MCP tools and the direct service calls bypass that dispatcher
 * and ask here. Server-side only: no NEXT_PUBLIC_ prefix, so a flip on
 * Vercel takes effect without a rebuild.
 */
export function isSkatteverketEnabled(): boolean {
  return process.env.SKATTEVERKET_ENABLED === 'true'
}
