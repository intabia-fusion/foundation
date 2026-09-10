import { uncompress } from 'snappyjs'

export async function withRetry<T> (
  fn: () => Promise<T>,
  ignoreAttemptCheck?: (err: any) => boolean,
  shouldAbort?: (err: any) => boolean
): Promise<T> {
  const maxRetries = 3
  let lastError: any

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err: any) {
      // Deterministic rejections (e.g. plan/seat limit) must not be retried — retrying spams
      // the server and never succeeds.
      if (shouldAbort?.(err) === true) {
        throw err
      }
      if (ignoreAttemptCheck?.(err) === true) {
        // Do not decrement attempt
        attempt--
      } else {
        lastError = err
      }
      if (attempt === maxRetries - 1) {
        throw lastError
      }
      await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 100))
    }
  }
  throw lastError
}

function rpcJSONReceiver (key: string, value: any): any {
  if (typeof value === 'object' && value !== null) {
    if (value.dataType === 'TotalArray') {
      return Object.assign(value.value, { total: value.total, lookupMap: value.lookupMap })
    }
  }
  return value
}

export async function extractJson<T> (response: Response): Promise<any> {
  const encoding = response.headers.get('content-encoding')
  if (encoding === 'snappy') {
    const buffer = await response.arrayBuffer()
    const decompressed = uncompress(buffer)
    const decoder = new TextDecoder()
    const jsonString = decoder.decode(decompressed)
    return JSON.parse(jsonString, rpcJSONReceiver) as T
  }
  const jsonString = await response.text()
  return JSON.parse(jsonString, rpcJSONReceiver) as T
}
