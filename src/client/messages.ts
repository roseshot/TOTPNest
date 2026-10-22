import { ApiFailure } from './api'

/** Keep internal server terminology out of the visitor-facing interface. */
export function readableError(error: unknown): string {
  if (error instanceof ApiFailure) {
    switch (error.code) {
      case 'LOGIN_FAILED':
      case 'BAD_SHARE_PASSWORD': return "That password didn't work. Please try again."
      case 'PASSWORD_REQUIRED': return 'Enter the password you received with this code.'
      case 'SHARE_UNAVAILABLE': return 'This shared code is no longer available.'
      case 'LOCKED': return 'Too many unsuccessful attempts. Please try again later.'
      case 'RATE_LIMIT': return 'Too many attempts right now. Please wait and try again.'
      case 'TOO_EARLY': return "The next code isn't ready yet."
      case 'UNAUTHORIZED': return 'Please sign in to continue.'
      case 'NETWORK': return "Couldn't connect. Check your connection and try again."
      case 'INTERNAL_ERROR': return "Something went wrong. Please try again."
    }
    if (error.status >= 500) return 'This page is temporarily unavailable. Please try again later.'
    if (/Base32|TOTP secret/i.test(error.message)) return "That setup key doesn't look right. Please check it."
    if (/TOTP entry/i.test(error.message)) return "We couldn't find that saved code."
    if (/hash algorithm|TOTP period|Code length/i.test(error.message)) return 'Those code settings are not supported.'
  }
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.'
}
