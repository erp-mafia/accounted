// Strata renders for the start cards (public/startkort/*.webp). Generated
// deterministically by strata-engine in the CRM workspace (studio/strata):
//
//   node stratify.mjs <source> linen-clear --bg <ground> [flags] --name <out>
//
// Per-file source + flags, so any card can be regenerated or re-grounded:
//   venice.webp    imports/venice-canal-painting/04-commons-giovanni-antonio-canal...jpg  --bg #3A2118
//   sthlm.webp     imports/stockholm-gamla-stan-riddarholmen-waterfront-skyline/05-web...jpg  --bg #16303B
//   geese.webp     imports/byt-hero/02-commons-canadiangeeseflyinginvformation-jpg.jpg  --bg #2E3C58
//   stopwatch.webp imports/konsult-hero/04-flickr-stopwatch.jpg  (night-clear)  --bg #322416
//   ledger.webp    imports/ledger/01-commons-pittsboro-merchant-business-ledger-dpla-.jpg  --bg #1F2B20 --tone 0.35
//   abacus.webp    imports/abacus/04-commons-abacus-of-state-department-store-jpg.jpg (right unit crop)  --bg #1B2136 --tone 0.5
//
// The ground color is baked into the render (the gaps between bars carry it),
// so the card background and scrims below must stay in the same hue: change
// them together or the image edge shows a seam. Intrinsic dimensions declared
// up front so the <img> gets width/height and avoids layout shift.

export const START_CARDS = {
  venice: {
    src: '/startkort/venice.webp',
    w: 2400,
    h: 1466,
    ground: '#3A2118',
    groundRgb: '58, 33, 24',
    objectPosition: 'center 42%',
  },
  sthlm: {
    src: '/startkort/sthlm.webp',
    w: 2400,
    h: 1500,
    ground: '#16303B',
    groundRgb: '22, 48, 59',
    objectPosition: 'center 32%',
  },
  geese: {
    src: '/startkort/geese.webp',
    w: 2400,
    h: 1600,
    ground: '#2E3C58',
    groundRgb: '46, 60, 88',
    objectPosition: '0 26%',
  },
  stopwatch: {
    src: '/startkort/stopwatch.webp',
    w: 2400,
    h: 1800,
    ground: '#322416',
    groundRgb: '50, 36, 22',
    objectPosition: 'center 30%',
  },
  ledger: {
    src: '/startkort/ledger.webp',
    w: 2400,
    h: 3602,
    ground: '#1F2B20',
    groundRgb: '31, 43, 32',
    objectPosition: 'center 30%',
  },
  abacus: {
    src: '/startkort/abacus.webp',
    w: 2400,
    h: 2176,
    ground: '#1B2136',
    groundRgb: '27, 33, 54',
    objectPosition: 'center 35%',
  },
} as const

export type StartCardName = keyof typeof START_CARDS
