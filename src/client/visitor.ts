/**
 * Estimate unique browsers with one random identifier per shared link.
 * Local storage keys use a hash of the link path: never persist the bearer
 * share ID itself or a secret-containing URL in browser storage.
 *
 * Clearing or blocking site storage makes subsequent visits count as new UV.
 * No IP address, fingerprint, account, or other identifying data is collected.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function visitorIdForShare(shareEndpoint: string): Promise<string> {
  const freshId = () => crypto.randomUUID()
  let key: string
  try {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(shareEndpoint))
    const digest = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
    key = 'totpnest:visitor:' + digest
  } catch {
    // Without hashing, do not persist the bearer share ID in a storage key.
    return freshId()
  }

  try {
    const saved = window.localStorage.getItem(key)
    if (saved && UUID_V4.test(saved)) return saved
  } catch { return freshId() }

  const id = freshId()
  try { window.localStorage.setItem(key, id) }
  catch { /* Site storage is blocked; the code remains accessible. */ }
  return id
}
