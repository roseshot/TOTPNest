/** Parse Key URI Format imports without generating any codes in the browser. */
export type EntryDraft = {
  issuer: string
  account: string
  secret: string
  algorithm: 'SHA1' | 'SHA256' | 'SHA512'
  digits: 6 | 8
  period: number
}

export function parseOtpUri(value: string): EntryDraft {
  let uri: URL
  try { uri = new URL(value.trim()) }
  catch { throw new Error("This setup link doesn't look right. Copy the full link and try again.") }
  if (uri.protocol !== 'otpauth:' || uri.hostname.toLowerCase() !== 'totp' ||
      uri.username || uri.password || uri.port || uri.hash) {
    throw new Error("This setup link isn't supported. Try a link for a verification code.")
  }
  const params = uri.searchParams
  let label: string
  try { label = decodeURIComponent(uri.pathname.replace(/^\//, '')) }
  catch { throw new Error("This setup link doesn't look right. Copy the full link and try again.") }
  const colon = label.indexOf(':')
  const issuer = (params.get('issuer') || (colon >= 0 ? label.slice(0, colon) : '')).trim()
  const account = (colon >= 0 ? label.slice(colon + 1) : label).trim()
  const algorithm = (params.get('algorithm') || 'SHA1').replace('-', '').toUpperCase()
  const digits = Number(params.get('digits') || 6)
  const period = Number(params.get('period') || 30)
  const secret = params.get('secret')
  if (!issuer && !account) throw new Error('This setup link is missing a service or account name.')
  if (!['SHA1', 'SHA256', 'SHA512'].includes(algorithm) || (digits !== 6 && digits !== 8) ||
      !Number.isInteger(period) || period < 15 || period > 120 || !secret) {
    throw new Error('This setup link is incomplete or not supported.')
  }
  return { issuer, account, secret, algorithm: algorithm as EntryDraft['algorithm'],
    digits: digits as EntryDraft['digits'], period }
}

