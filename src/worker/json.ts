/** Read a small JSON object without buffering an unbounded request body. */
export class JsonBodyError extends Error {
  constructor(public readonly status: 400 | 413, message: string) {
    super(message)
  }
}

export async function readJsonObject(request: Request, maxBytes = 8192): Promise<Record<string, unknown>> {
  const declaredLength = request.headers.get('Content-Length')
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    throw new JsonBodyError(413, 'Request body is too large')
  }
  const reader = request.body?.getReader()
  if (!reader) throw new JsonBodyError(400, 'Invalid JSON')

  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) throw new JsonBodyError(413, 'Request body is too large')
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }

  const data = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.byteLength
  }

  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data))
  } catch {
    throw new JsonBodyError(400, 'Invalid JSON')
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new JsonBodyError(400, 'Invalid request payload')
  }
  return payload as Record<string, unknown>
}

