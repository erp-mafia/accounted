# Example branding extension

Copy this folder to start a whitelabel fork:

```bash
cp -r extensions/general/_example-branding extensions/general/your-brand
```

Then:

1. Edit `your-brand/manifest.json`: set `id`, `exportName`, `entryPoint`, name, description.
2. Edit `your-brand/index.ts`: uncomment and set the branding values you want to override.
3. Drop your assets in `your-brand/assets/` (logo.svg, favicon.ico, og.png, etc.). Wire up an extension API route to serve them, or set the asset paths in `index.ts` to external CDN URLs.
4. Enable the extension in `extensions.config.json`:
   ```json
   { "id": "your-brand", "enabled": true }
   ```
5. Run `npm run setup:extensions && npm run dev`.

See `WHITELABEL.md` at the repo root for the full fork checklist (env vars, sync workflow, what NOT to change).

## Why a separate extension instead of just env vars?

Both work. Env vars are simpler for scalar overrides (app name, support email). An extension lets you bundle assets (logos, icons) and override values that don't fit cleanly into env vars. You can use both: extension overrides win over env vars.
