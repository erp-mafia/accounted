# Manifest Format Reference

Every extension has a `manifest.json` in `extensions/<sector>/<name>/`.

## Complete Schema

```json
{
  "id": "my-extension",
  "sector": "general",
  "exportName": "myExtensionExtension",
  "entryPoint": "@/extensions/general/my-extension",
  "workspace": "@/components/extensions/general/MyExtensionWorkspace",
  "requiredEnvVars": ["MY_API_KEY"],
  "optionalEnvVars": [],
  "npmDependencies": ["some-package"],
  "definition": {
    "name": "My Extension",
    "category": "operations",
    "icon": "Box",
    "dataPattern": "core",
    "description": "Short marketplace card text",
    "longDescription": "Longer detail page text.",
    "readsCoreTables": ["invoices", "transactions"],
    "hasOwnData": true,
    "quickAction": { "label": "Do Thing", "description": "Short desc", "icon": "Zap", "href": "/path" },
    "subscriptionNotice": "Requires external subscription to X"
  }
}
```

## Top-Level Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Kebab-case ID, must match directory name |
| `sector` | string | `"general"` (future: `"restaurant"`, `"construction"`, etc.) |
| `exportName` | string | camelCase export name: `toCamelCase(id) + "Extension"` |
| `entryPoint` | string | Path alias: `"@/extensions/{sector}/{id}"` |
| `workspace` | string \| null | Workspace component path, or `null` |
| `requiredEnvVars` | string[] | Required env vars (empty `[]` if none) |
| `optionalEnvVars` | string[] | Optional env vars (empty `[]` if none) |
| `npmDependencies` | string[] | Package deps for documentation (empty `[]` if none) |

## Definition Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Display name |
| `category` | Yes | `"import"` / `"operations"` / `"reports"` / `"accounting"` |
| `icon` | Yes | Lucide icon name (e.g., `"Camera"`, `"Sparkles"`, `"Bell"`): falls back to `"Puzzle"` |
| `dataPattern` | Yes | `"core"` (reads core tables) / `"manual"` (own data) / `"both"` |
| `description` | Yes | Short marketplace card text |
| `longDescription` | Yes | Longer detail page text |
| `readsCoreTables` | No | Which core tables it reads |
| `hasOwnData` | No | Whether it stores extension-specific data |
| `quickAction` | No | Dashboard quick action: `{ label, description, icon, href?, event?, order? }` |
| `subscriptionNotice` | No | Warning shown when enabling |

## Naming Convention

`my-extension` → `myExtension` → `myExtensionExtension` (export) → `@/extensions/general/my-extension` (entry point)
