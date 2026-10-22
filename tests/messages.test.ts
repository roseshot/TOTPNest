import { describe, expect, it } from 'vitest'
import { ApiFailure } from '../src/client/api'
import { readableError } from '../src/client/messages'

describe('clear error messages', () => {
  it('explains invalid passwords without exposing server details', () => {
    expect(readableError(new ApiFailure('LOGIN_FAILED', 401, 'LOGIN_FAILED')))
      .toBe("That password didn't work. Please try again.")
    expect(readableError(new ApiFailure('BAD_SHARE_PASSWORD', 401, 'BAD_SHARE_PASSWORD')))
      .toBe("That password didn't work. Please try again.")
  })
  it('explains rate limits, missing links, and outages', () => {
    expect(readableError(new ApiFailure('LOCKED', 429, 'LOCKED'))).toContain('try again later')
    expect(readableError(new ApiFailure('SHARE_UNAVAILABLE', 404, 'SHARE_UNAVAILABLE')))
      .toBe('This link is no longer available. Ask the sender for a new one.')
    expect(readableError(new ApiFailure('Service temporarily unavailable', 503, 'INTERNAL_ERROR')))
      .toBe('Something went wrong. Please try again.')
  })
  it('replaces technical server errors with helpful guidance', () => {
    expect(readableError(new ApiFailure('TOTP secret must use valid Base32 encoding', 400)))
      .toContain('setup key')
    expect(readableError(new ApiFailure('Issuer or account is required', 400)))
      .toContain('website or app name')
    expect(readableError(new ApiFailure('D1 request failed at replica', 400)))
      .toBe("Couldn't complete that action. Check the details and try again.")
    expect(readableError(new ApiFailure('DB unavailable, SQL failed', 503)))
      .not.toContain('SQL')
  })
  it('does not show unexpected browser error internals', () => {
    expect(readableError(new TypeError('Cannot read property of undefined')))
      .toBe('Something went wrong. Please try again.')
  })
  it('keeps local import validation messages actionable', () => {
    expect(readableError(new Error('Please choose a clearer picture')))
      .toBe('Please choose a clearer picture')
  })
})
