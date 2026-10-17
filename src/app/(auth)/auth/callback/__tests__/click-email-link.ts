import { NextRequest } from 'next/server'
import { CONFIRM_LINK_COOKIE, confirmFormAction } from '@/lib/auth/confirm-link'
import { GET, POST } from '../route'

/**
 * What a person does with an emailed link: open it (GET, which only holds the
 * token and redirects to /auth/confirm) and press the button there (a POST to
 * the action that page renders, carrying the held-token cookie). Headers in
 * `init` ride on both requests, the way the browser sends its own cookies and
 * the proxy its forwarded host on each.
 */
export async function clickEmailLink(
  url: string | URL,
  init: { headers?: Record<string, string> } = {},
) {
  const opened = await GET(new NextRequest(url, init))
  const location = opened.headers.get('location')
  if (!location) throw new Error(`opening ${url} did not redirect`)
  const confirmPage = new URL(location)
  const held = opened.cookies.get(CONFIRM_LINK_COOKIE)?.value
  const cookie = [init.headers?.cookie, held && `${CONFIRM_LINK_COOKIE}=${held}`]
    .filter(Boolean)
    .join('; ')
  return POST(
    new NextRequest(new URL(confirmFormAction(confirmPage.searchParams), confirmPage), {
      method: 'POST',
      headers: { ...init.headers, ...(cookie ? { cookie } : {}) },
    }),
  )
}
