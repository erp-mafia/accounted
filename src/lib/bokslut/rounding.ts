/**
 * Öre-precision rounding for bokslut and continuity logic.
 *
 * @deprecated The canonical home for these primitives is `@/lib/money`. This
 * module re-exports them for back-compat; import from `@/lib/money` in new code.
 *
 * Previously `continuity-check.ts` used 0.01 as its comparison threshold. That
 * extra slack absorbed drift from chained Math.round calls, but with all
 * rounding now centralized through `roundOre()` the half-öre `ORE_TOLERANCE`
 * (0.005) is correct and tighter: a one-öre real discrepancy must surface.
 */
export { roundOre, ORE_TOLERANCE } from '@/lib/money'
