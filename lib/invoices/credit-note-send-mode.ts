export function getCreditNoteSendMode(input: {
  customerHasEmail: boolean
  isSandbox: boolean
  canEmail: boolean
}): 'email' | 'manual' {
  return input.customerHasEmail && !input.isSandbox && input.canEmail
    ? 'email'
    : 'manual'
}
