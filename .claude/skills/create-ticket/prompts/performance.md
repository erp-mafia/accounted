# Performance Prompt

## Perspective

You are scanning for performance issues in a Next.js 16 (App Router) + React 19 + Supabase application. Focus on page load speed, rendering efficiency, bundle size, data fetching patterns, and perceived performance. The app targets short, focused sessions (90 seconds): speed is a core feature.

## Checklist

### Rendering & React
- [ ] Components that don't need interactivity are Server Components (no unnecessary `'use client'`)
- [ ] Large lists use virtualization or pagination (not rendering 1000+ items)
- [ ] Expensive computations wrapped in `useMemo` where re-renders are frequent
- [ ] Callback functions stable with `useCallback` when passed as props to memoized children
- [ ] No unnecessary re-renders from unstable object/array references in props or context
- [ ] Suspense boundaries with appropriate fallbacks for async components

### Data Fetching
- [ ] Server Components fetch data on the server (not client-side `useEffect` for initial data)
- [ ] No waterfall fetches (parallel when independent)
- [ ] Pagination or cursor-based loading for large datasets
- [ ] No fetching data that's already available from a parent component
- [ ] API routes return only needed fields (not entire rows with unused columns)
- [ ] Appropriate use of `revalidatePath` / `revalidateTag` for cache invalidation

### Bundle Size
- [ ] Heavy libraries imported dynamically (`next/dynamic`) where not needed on initial load
- [ ] No duplicate dependencies (same library imported from different paths)
- [ ] Tree-shaking friendly imports (`import { X } from 'lib'` not `import * as lib`)
- [ ] Images optimized with `next/image` (not raw `<img>` tags)
- [ ] SVG icons from Lucide imported individually (not the entire icon set)

### Database & API
- [ ] Queries have appropriate indexes (see database prompt for details)
- [ ] No N+1 patterns (fetching related data in loops)
- [ ] Batch operations used where possible (bulk insert/update)
- [ ] API responses are reasonably sized (not returning megabytes of data)
- [ ] Rate limiting in place for expensive operations

### Perceived Performance
- [ ] Loading skeletons match content layout (not generic spinners)
- [ ] Optimistic UI updates for user actions (don't wait for server response to show feedback)
- [ ] Transitions between states are smooth (no jarring layout shifts)
- [ ] Critical content above the fold loads first
- [ ] Non-critical content lazy-loaded or deferred

### Caching
- [ ] Static pages/routes use appropriate caching headers
- [ ] API responses include cache headers where data doesn't change frequently
- [ ] Client-side state management avoids redundant fetches
- [ ] Supabase real-time subscriptions used only where needed (not as a polling replacement)

## Classification

- **Bug**: Memory leak, infinite re-render loop, blocking the main thread, N+1 causing timeouts.
- **Feature**: Needs pagination, needs virtualization, needs caching layer, needs optimistic updates.
- **Improvement**: Unnecessary `'use client'`, could use Server Component, missing `useMemo` on expensive computation, bundle could be split, fetch could be parallelized.
