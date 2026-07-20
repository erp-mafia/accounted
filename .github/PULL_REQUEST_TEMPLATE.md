# What and why

<!-- What does this PR change, and why? Link related issues with "Closes #123". -->

## Checklist

- [ ] Title follows [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`)
- [ ] `npm run lint`, `npm test`, and `npm run build` pass locally
- [ ] New or changed logic in `lib/` or `app/api/` has tests
- [ ] New or changed UI strings exist in both `messages/sv.json` and `messages/en.json`
- [ ] Migrations (if any) are new files in `supabase/migrations/`; no edits to already-shipped migrations
- [ ] Core builds with zero extensions enabled (no imports from `@/extensions/` in core code)
- [ ] Commits are signed off (`git commit -s`, see [DCO](../DCO))
