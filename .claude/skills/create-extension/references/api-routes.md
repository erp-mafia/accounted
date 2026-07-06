# API Routes Reference

All extension APIs dispatch through `app/api/extensions/ext/[...path]/route.ts`.

**URL scheme:** `/api/extensions/ext/{extensionId}/{routePath}`

## Route Definition

```typescript
import type { ApiRouteDefinition, ExtensionContext } from '@/lib/extensions/types'
import { NextResponse } from 'next/server'

export const myExtApiRoutes: ApiRouteDefinition[] = [
  {
    method: 'GET',
    path: '/',
    handler: async (_req, ctx) => {
      const { data, error } = await ctx!.supabase
        .from('my_items').select('*')
        .eq('user_id', ctx!.userId).order('created_at', { ascending: false })
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ data })
    },
  },
]
```

## Path Parameters

Use `:paramName`; dispatcher extracts as `_paramName` search params:

```typescript
{
  method: 'GET',
  path: '/:id',
  handler: async (req, ctx) => {
    const id = new URL(req.url).searchParams.get('_id')
    const { data } = await ctx!.supabase
      .from('my_items').select('*').eq('id', id).eq('user_id', ctx!.userId).single()
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ data })
  },
}
// Multiple params: path: '/:id/items/:itemId' → _id, _itemId
```

## Dispatcher Flow

1. Extract `extensionId` and `routePath` from URL segments
2. Auth check (401) → match method+path (404) → AI consent check (403 for AI extensions)
3. Extract path params → create `ExtensionContext` → call handler

## Settings Route Pattern

```typescript
{ method: 'GET', path: '/settings',
  handler: async (_req, ctx) => {
    const settings = await ctx!.settings.get<MySettings>()
    return NextResponse.json({ data: settings ?? DEFAULT_SETTINGS })
  },
},
{ method: 'PUT', path: '/settings',
  handler: async (req, ctx) => {
    const body = await req.json()
    const merged = { ...(await ctx!.settings.get<MySettings>() ?? DEFAULT_SETTINGS), ...body }
    await ctx!.settings.set('settings', merged)
    return NextResponse.json({ data: merged })
  },
},
```

## Response Conventions

```typescript
NextResponse.json({ data: result })                              // Success
NextResponse.json({ error: 'Unauthorized' }, { status: 401 })   // Auth error
NextResponse.json({ error: 'Not found' }, { status: 404 })      // Not found
NextResponse.json({ error: error.message }, { status: 500 })     // Server error
```

## Frontend Calls

```typescript
const res = await fetch('/api/extensions/ext/my-extension/')
const res = await fetch(`/api/extensions/ext/my-extension/${id}`)
const res = await fetch('/api/extensions/ext/my-extension/settings', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ featureEnabled: true }),
})
```
