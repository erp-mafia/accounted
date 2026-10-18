/**
 * The Inkorg's frame under the top bar, shared by the page and its loading
 * silhouette so the one never jumps when the other lands.
 *
 * From md the work area takes back MainContainer's padding (the pt-4 the
 * top bar's margin leaves, px-6, pb-8) and fills the panel's height: the
 * viewport less the panel's 10px margins and its border (22px) and the 48px
 * top bar. The rail is its own column with a hairline to the content that
 * runs from the top bar to the bottom of the panel, and stays put while the
 * content scrolls. On a phone the rail is a strip above the list.
 */
export const WORK_AREA_CLASS =
  'flex flex-col gap-6 md:-mx-6 md:-mb-8 md:-mt-4 md:grid md:min-h-[calc(100vh-70px)] md:grid-cols-[13rem_minmax(0,1fr)] md:gap-0 lg:grid-cols-[15rem_minmax(0,1fr)]'

export const RAIL_COLUMN_CLASS =
  'md:sticky md:top-12 md:h-[calc(100vh-70px)] md:overflow-y-auto md:border-r md:border-border md:px-3 md:py-4'

export const CONTENT_COLUMN_CLASS = 'min-w-0 md:px-6 md:pb-8 md:pt-4'
