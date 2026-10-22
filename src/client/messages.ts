import { ApiFailure } from './api'

/**
 * Keep server and browser implementation details out of messages shown to users.
 * Explicitly map known validation errors; do not print unexpected API error text.
 */
export function readableError(error: unknown): string {
  if (error instanceof ApiFailure) {
    switch (error.code) {
      case 'LOGIN_FAILED':
      case 'BAD_SHARE_PASSWORD': return "That password didn't work. Please try again."
      case 'PASSWORD_REQUIRED': return 'Enter the password you received from the sender.'
      case 'SHARE_UNAVAILABLE': return 'This link is no longer available. Ask the sender for a new one.'
      case 'LOCKED': return 'Too many unsuccessful attempts. Please try again later.'
      case 'RATE_LIMIT': return 'Too many attempts right now. Please wait and try again.'
      case 'TOO_EARLY': return 'The code is about to change. Try again in a moment.'
      case 'UNAUTHORIZED': return 'Please sign in again to continue.'
      case 'NETWORK': return "Couldn't connect. Check your connection and try again."
      case 'INTERNAL_ERROR': return "Something went wrong. Please try again."
    }

    if (error.status >= 500) return 'This page is temporarily unavailable. Please try again later.'
    if (/issuer or account is required/i.test(error.message)) {
      return 'Enter a website or app name, an account name, or both.'
    }
    if (/issuer is invalid/i.test(error.message)) return 'The website or app name is too long.'
    if (/account is invalid/i.test(error.message)) return 'The account name is too long.'
    if (/note is invalid/i.test(error.message)) return 'Your note is too long.'
    if (/Base32|TOTP secret|Invalid padding|Secret must be/i.test(error.message)) {
      return "That setup key doesn't look right. Check the key and try again."
    }
    if (/hash algorithm|TOTP period|Code length/i.test(error.message)) {
      return 'These code settings do not match what the website or app expects.'
    }
    if (/expiration must/i.test(error.message)) return 'Choose when your link should expire.'
    if (/share password must/i.test(error.message)) return 'Choose a password between 8 and 128 characters.'
    if (/Select a TOTP entry/i.test(error.message)) return 'Choose a code to share first.'
    if (error.status === 404) return "We couldn't find that item. It may have been removed."
    if (error.status === 403) return "Couldn't complete that action. Refresh the page and try again."
    if (error.status === 401) return 'Please sign in or check your password and try again.'
    if (error.status === 429) return 'Too many attempts. Please wait and try again.'
    return "Couldn't complete that action. Check the details and try again."
  }

  // Only display known, user-facing errors created locally.
  if (error instanceof Error && /^(QR image |No QR code |Could not read the QR|This setup link |Please choose )/.test(error.message)) {
    return error.message
  }
  return "Something went wrong. Please try again."
}
