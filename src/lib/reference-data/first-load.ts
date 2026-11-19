/**
 * Whether a reference-data key is still on its FIRST load: a fetch is in
 * flight and there is nothing to show yet.
 *
 * SWR's own `isLoading` cannot answer that for a seeded key. The dashboard
 * layout hands the fiscal periods, cash accounts and company settings to SWR
 * as `fallback` (lib/reference-data/seed.ts), and SWR revalidates a fallback
 * on mount: until that request returns it reports `isLoading: true` although
 * `data` already holds the seed ("it is in the isLoading state if and only if
 * there is no cached data; this bypasses fallback data", swr 2.4). Every
 * consumer that gates on the flag (FyPicker's onReady, the verifikat list's
 * period hydration, the VAT view's skeleton) therefore waited for a browser
 * read of rows it was already holding, behind the session-token fetch that
 * read needs: two round trips in front of the page's first real request.
 *
 * `undefined` is "no data"; a seeded `null` (a company with no settings row)
 * and an empty list are answers.
 */
export function isFirstLoadPending(isLoading: boolean, data: unknown): boolean {
  return isLoading && data === undefined
}
