/**
 * K3 (BFNAR 2012:1) treatment of uppskjuten skatt on obeskattade reserver.
 *
 * In JURIDISK PERSON, K3 kap 29 (29.37) keeps obeskattade reserver at gross:
 * uppskjuten skatt attributable to them is NOT separately recognised, because
 * the reserves are presented including their deferred-tax component. The
 * 79.4 / 20.6 split into equity + uppskjuten skatteskuld belongs to
 * KONCERNREDOVISNING (and analytical contexts such as kontrollbalansrakning
 * and soliditet), which this product does not book.
 *
 * The engine therefore books NO 8940/2240 entry on obeskattade reserver.
 * A dispositions step that did exactly that was removed 2026-08-05 (founder
 * decision, see DECISIONS.md): it double-counted the tax portion in juridisk
 * person (result charged twice, 2240 overstated on top of gross 21xx).
 *
 * What remains here is the analytical rate, used for presentation-side
 * calculations such as justerat eget kapital in soliditet (equity portion =
 * obeskattade reserver x (1 - rate)).
 *
 * 20.6 % is the current Swedish bolagsskatt rate (since 2021).
 */
export const LATENT_TAX_DEFAULT_RATE = 0.206
