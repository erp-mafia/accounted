# Accounted

Swedish accounting SaaS: double-entry bookkeeping under Bokföringslagen for sole traders and limited companies, sold directly and (from 2026) resold white-label by accounting firms under their own brand.

## Language

### White label

**Brand**:
The host-resolved white-label identity: one row per partner domain carrying app name, logo, palette, font, and email sender identity. Owned by a byrå team; a request's Host header resolves to at most one brand, and no match means the default Accounted appearance.
_Avoid_: Tenant (already means company-level multi-tenancy here), theme, skin

**Byrå team**:
A team that represents an accounting firm: named, multi-member, invitable, the anchor for brand ownership, client companies, and billing.
_Avoid_: Agency, firm team

**Personal team**:
The silent auto-created team every user gets (`ensure_user_team()`); an implementation detail of company ownership, never a byrå.

**Partner**:
Prose word for the commercial relationship: a byrå with an agreement and usually a brand. Not an entity in the schema.

**Canonical domain**:
app.accounted.se (and legacy app.gnubok.se): the domains carrying the default Accounted brand, external OAuth flows, and cron entry points.

**Home domain**:
The one domain a company is opened and worked in: its byrå's brand domain if the company's team has a brand, else the canonical domain. Everywhere else the UI shows a signpost to the home domain, never the company. A navigation rule, not a security boundary: access is still governed solely by company membership and RLS.

**Signpost**:
The screen shown when a logged-in user's company lives on a different host ("Kalles Bygg AB hanteras via app.siffra.se"), with a link there. Never a silent redirect: sessions are per domain, so the user must log in again on the home domain.

**Umbrella subdomain**:
A brand domain hosted under our own zone (siffra.accounted.se): the starter shape, zero partner DNS work. A custom domain (app.siffra.se) is the upgrade; the brand model treats both as the same single hostname.

**Invoice branding**:
The per-company logo and colors printed on that company's customer invoices. Unrelated to a byrå brand; never shorten to "branding".
_Avoid_: Branding (unqualified)

**Brand color**:
The single partner-supplied color a brand is themed from: primary buttons, focus rings, links, and active nav take it directly; the chrome (frame and sidebar) is derived from it unless the partner explicitly overrides the chrome color. Semantic colors (success, warning, destructive) never follow it.

**Cockpit**:
The byrå dashboard: the read-first client overview for byrå staff, aggregating status across all client companies. Acting on a client happens inside the client after a switch (or via the agent path); the cockpit itself never writes to client books.
_Avoid_: Byrå portal, partner dashboard
