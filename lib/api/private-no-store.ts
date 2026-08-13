import type { NextResponse } from 'next/server'

export function privateNoStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}
