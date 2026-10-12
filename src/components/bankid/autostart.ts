/** The BankID app on this device, with no return URL (the page keeps polling). */
export function bankIdAutostartHref(token: string): string {
  return `bankid:///?autostarttoken=${encodeURIComponent(token)}&redirect=null`
}
