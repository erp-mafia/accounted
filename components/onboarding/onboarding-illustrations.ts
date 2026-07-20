// Halftone line-art illustrations shared with the marketing site
// (gnubok-website public/illustrations/). Intrinsic dimensions are needed
// up front: the floater physics computes aspect ratios before the images
// load, and static <img> layers need width/height to avoid layout shift.
// If you copy more pieces from the website repo, add their manifest.json
// entry here.
export const ILLUSTRATIONS = {
  'about-stockholm': { w: 2648, h: 1318 },
  calculator: { w: 745, h: 525 },
  cloud: { w: 601, h: 443 },
  'key-adding-machine': { w: 1650, h: 1318 },
  notebook: { w: 636, h: 525 },
  pencil: { w: 542, h: 525 },
  petals: { w: 2163, h: 1758 },
} as const

export type IllustrationName = keyof typeof ILLUSTRATIONS

export function illustrationSrc(name: IllustrationName): string {
  return `/illustrations/${name}.webp`
}
