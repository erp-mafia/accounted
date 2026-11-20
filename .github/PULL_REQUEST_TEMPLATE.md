# What and why

<!-- What does this PR change, and why? Link related issues with "Closes #123". -->

## AI assistance

<!-- Which AI tools did you use, and for what? Write "None" if you used none. Policy: "AI-Assisted Contributions" in .github/CONTRIBUTING.md. -->

## Checklist

- [ ] Title follows [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`)
- [ ] Any AI assistance is disclosed above, and I have read and understand every line of this PR
- [ ] `npm run lint`, `npm run check:types`, `npm run check:guards`, `npm test` and `npm run build` pass locally
- [ ] New or changed logic in `src/lib/` or `src/app/api/` has tests
- [ ] New or changed UI strings exist in both `src/messages/sv.json` and `src/messages/en.json`
- [ ] Migrations (if any) are new files in `supabase/migrations/`; no edits to already-shipped migrations
- [ ] Core builds with zero extensions enabled (no imports from `@/extensions/` in core code)
- [ ] I have signed the Contributor License Agreement (`CLA.md`; the CLA Assistant bot links it on a first PR)
