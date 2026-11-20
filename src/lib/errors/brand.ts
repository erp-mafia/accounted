/**
 * Error classes that `instanceof` recognises in every copy of their module.
 *
 * A production server holds more than one copy of a module, one per bundler
 * layer (lib/global-singleton.ts). lib/init loads from the instrumentation
 * hook, so what it registers (the Peppol transports, the payments provider,
 * extension services) runs in the instrumentation copy and throws that copy's
 * error class, while the route that called it catches with its own copy. A
 * prototype check then answers false, and a typed refusal falls through as an
 * unknown error (crm#1282: every payment provider refusal read as
 * UNEXPECTED_ERROR).
 *
 * A branded class marks each instance with a process-wide symbol (Symbol.for,
 * non-enumerable, so it never rides along into a logged or returned payload)
 * and answers `instanceof` by the mark:
 *
 *   const BRAND = 'accounted.peppol.transportError'
 *
 *   export class PeppolTransportError extends Error {
 *     constructor(message: string) {
 *       super(message)
 *       brandError(this, BRAND)
 *     }
 *
 *     static [Symbol.hasInstance](value: unknown): value is PeppolTransportError {
 *       return isBrandedInstance(this, PeppolTransportError, BRAND, value)
 *     }
 *   }
 *
 * Brand an error class when an instance can be thrown by code lib/init
 * registers and be checked with `instanceof` by code that reached it through a
 * registry. A subclass of a branded class brands itself too (its own brand and
 * its own `static [Symbol.hasInstance]`); one that does not is answered by the
 * ordinary prototype check, never by its parent's brand.
 */

/** Mark `error` as carrying `brand`; the mark is invisible to JSON and Object.keys. */
export function brandError(error: Error, brand: string): void {
  Object.defineProperty(error, Symbol.for(brand), { value: true, enumerable: false })
}

/** Whether `value` carries `brand`, whichever module copy made it. */
export function hasErrorBrand(value: unknown, brand: string): boolean {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[Symbol.for(brand)] === true
}

type ErrorClass = abstract new (...args: never[]) => Error

/**
 * The body of a branded class's `static [Symbol.hasInstance]`: `asked` is the
 * `this` of the call (the class on the right of `instanceof`), `owner` the
 * class that declares `brand`. Asked of the owner, the brand answers. Asked of
 * a subclass that inherited the method without declaring a brand of its own,
 * the prototype chain answers, so such a subclass never claims every error of
 * its parent.
 */
export function isBrandedInstance(asked: ErrorClass, owner: ErrorClass, brand: string, value: unknown): boolean {
  if (asked !== owner) return Function.prototype[Symbol.hasInstance].call(asked, value)
  return hasErrorBrand(value, brand)
}
