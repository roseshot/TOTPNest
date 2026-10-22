import { describe, expect, it } from 'vitest'
import { parseOtpUri } from '../src/client/otp-uri'

describe('otpauth import parsing', () => {
  it('parses an encoded account and advanced parameters', () => {
    expect(parseOtpUri(
      'otpauth://totp/Example:alex%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example&algorithm=SHA-256&digits=8&period=60'
    )).toEqual({
      issuer: 'Example', account: 'alex@example.com', secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA256', digits: 8, period: 60
    })
  })

  it('offers plain-language guidance for malformed setup links', () => {
    expect(() => parseOtpUri('not a link')).toThrow('Copy the full link and try again.')
    expect(() => parseOtpUri('')).toThrow('Copy the full link and try again.')
  })
  it('rejects HOTP and invalid or empty TOTP settings', () => {
    expect(() => parseOtpUri('otpauth://hotp/User?secret=JBSWY3DPEHPK3PXP')).toThrow()
    expect(() => parseOtpUri('otpauth://totp/User?secret=JBSWY3DPEHPK3PXP&period=0')).toThrow()
    expect(() => parseOtpUri('otpauth://totp/User?secret=')).toThrow()
    expect(() => parseOtpUri('otpauth://totp/?secret=JBSWY3DPEHPK3PXP')).toThrow()
  })
})

