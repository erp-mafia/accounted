# Workspace & UI Reference

## Workspace Components

Each extension can have a workspace page at `/e/{sector}/{slug}`.

**1. Create component:**
```typescript
// components/extensions/general/MyExtensionWorkspace.tsx
'use client'
import type { WorkspaceComponentProps } from '@/lib/extensions/workspace-registry'

export default function MyExtensionWorkspace({ userId }: WorkspaceComponentProps) {
  return <div className="space-y-6">{/* Extension UI */}</div>
}
```

**2. Set in manifest:** `"workspace": "@/components/extensions/general/MyExtensionWorkspace"`

**3. Regenerate:** `npm run setup:extensions`

Render chain: `/e/general/my-extension` → auth check → definition exists check → `ExtensionWorkspaceShell` (breadcrumb+header) → your component.

Set `"workspace": null` for extensions without a dedicated page (event-only, service-only, etc.).

## Settings Panels

Declare in extension object:
```typescript
settingsPanel: { label: 'My Extension', path: '/settings/extensions/my-extension' },
```

Register panel in `src/lib/extensions/settings-panel-registry.tsx`:
```typescript
case 'my-extension':
  return dynamic(() => import('@/components/extensions/general/my-extension/MyExtSettings'))
```

Settings component fetches/saves via extension API routes (`GET/PUT /settings`).

## Sidebar

The sidebar lists an enabled extension only when its manifest has both a `workspace` and `definition.quickAction.href`. `sidebarItems` is declared on the `Extension` type, but no core code reads it.

## Extension Enablement

All compiled extensions are active for all users. To check if an extension is compiled in:

```typescript
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'

const isAvailable = ENABLED_EXTENSION_IDS.has('my-extension')
```

## Hooks

```typescript
const { data, save, remove, getByKey } = useExtensionData('general', 'my-extension')
```
