import type { NextResponse } from 'next/server'

export const PRIVATE_NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' } as const

export function privateNoStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}
