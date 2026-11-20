import type { CSSProperties } from 'react'

/**
 * The look of a chart's hover tooltip: a floating layer like every other
 * (the popover surface, the float shadow, the 10px radius), in both themes.
 * Recharts' own default is a white box with a grey hover band, which reads
 * as a hole in dark mode and hides its own label there.
 * Spread into <Tooltip {...CHART_TOOLTIP_PROPS} />.
 */
const contentStyle: CSSProperties = {
  background: 'hsl(var(--popover))',
  border: 'none',
  borderRadius: 10,
  boxShadow: 'var(--sh-pop)',
  color: 'hsl(var(--popover-foreground))',
  fontSize: 12,
  padding: '8px 10px',
}

export const CHART_TOOLTIP_PROPS = {
  contentStyle,
  labelStyle: { color: 'hsl(var(--popover-foreground))', fontWeight: 500 } satisfies CSSProperties,
  itemStyle: { padding: 0 } satisfies CSSProperties,
  // The hover band is the row hover wash, never an opaque grey.
  cursor: { fill: 'hsl(var(--secondary))' },
}
