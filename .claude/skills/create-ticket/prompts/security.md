# Security Prompt

## Perspective

You are scanning for security vulnerabilities and hardening opportunities in a Next.js 16 + Supabase application. Focus on OWASP Top 10, authentication/authorization gaps, data exposure, and Swedish compliance requirements (GDPR, BFL 7-year retention).

## Checklist

### Authentication & Authorization
- [ ] All API routes check `supabase.auth.getUser()` and return 401 if missing
- [ ] MFA enforcement where required (`NEXT_PUBLIC_REQUIRE_MFA`)
- [ ] API key routes validate via `validate_and_increment_api_key` RPC
- [ ] No auth bypass in middleware exclusion patterns

### Row Level Security
- [ ] All tables have RLS enabled
- [ ] Policies use `auth.uid() = user_id` (not broader conditions)
- [ ] API routes apply defense-in-depth `user_id` filtering alongside RLS
- [ ] Service role client usage is justified and scoped

### Input Validation
- [ ] All API route bodies validated via `validateBody()` with Zod schemas
- [ ] Dynamic route params validated (UUID format, type checks)
- [ ] No raw user input in SQL queries (parameterized only)
- [ ] File upload types and sizes validated

### Data Exposure
- [ ] API responses don't leak sensitive fields (passwords, tokens, internal IDs)
- [ ] Error responses don't expose stack traces or internal details
- [ ] Supabase `.select()` calls specify columns (not `select('*')` with sensitive data)
- [ ] Logs don't contain PII or secrets

### Injection & XSS
- [ ] No `dangerouslySetInnerHTML` without sanitization
- [ ] No string interpolation in SQL (use parameterized queries)
- [ ] No `eval()`, `Function()`, or dynamic code execution
- [ ] URL parameters are validated before use

### CSRF & Headers
- [ ] State-changing operations use POST/PUT/DELETE (not GET)
- [ ] CORS configured appropriately
- [ ] Security headers set (CSP, X-Frame-Options, etc.)

### Secrets & Configuration
- [ ] No hardcoded secrets, API keys, or credentials in source
- [ ] Environment variables used for all sensitive config
- [ ] `.env` files in `.gitignore`
- [ ] OAuth secrets properly encrypted (AES-256-GCM)

### Compliance (Swedish Law)
- [ ] 7-year document retention enforced (cannot delete posted entries)
- [ ] Period lock enforcement (cannot write to locked periods)
- [ ] Audit trail integrity (voucher numbers sequential, entries immutable)

## Classification

- **Bug**: Active vulnerability: missing auth check, SQL injection vector, data leak, RLS gap, exposed secret.
- **Feature**: New security capability needed: audit logging, rate limiting on a new endpoint, CSP policy addition.
- **Improvement**: Hardening: adding input validation to an endpoint that works but accepts too broadly, tightening a SELECT to specific columns, adding rate limiting.
