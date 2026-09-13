// Halftone line-art illustrations shared with the marketing site
// (gnubok-website public/illustrations/). Intrinsic dimensions are declared
// up front so <img> layers get width/height and avoid layout shift. If you
// copy more pieces from the website repo, add their manifest.json entry here.
export const ILLUSTRATIONS = {
  'about-stockholm': { w: 2648, h: 1318 },
  'logo-claude': { w: 524, h: 525 },
  'logo-openai': { w: 518, h: 525 },
} as const

export type IllustrationName = keyof typeof ILLUSTRATIONS

export function illustrationSrc(name: IllustrationName): string {
  return `/illustrations/${name}.webp`
}
