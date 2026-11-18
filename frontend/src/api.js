export async function api(path, { session, method = 'GET', body, binary = false, signal } = {}) {
  const multipart = body instanceof FormData
  const headers = {}
  if (session) headers.Authorization = 'Bearer ' + session.token
  if (body !== undefined && !multipart) headers['Content-Type'] = 'application/json'

  const timeout = AbortSignal.timeout(binary || multipart ? 30000 : 15000)
  let response
  try {
    response = await fetch('/api' + path, {
      method,
      headers,
      cache: 'no-store',
      body: multipart || body === undefined ? body : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
  } catch {
    throw new Error('Could not reach the server. Try again.')
  }
  if (response.status === 204) return null
  if (response.status === 401 && session && path !== '/auth/logout') {
    window.dispatchEvent(new Event('triad:expired'))
  }
  if (binary && response.ok) return binary === 'response' ? response : response.blob()
  const result = await response.json().catch(() => null)
  if (!response.ok || !result) {
    const error = new Error(result?.error || 'The service could not complete the request.')
    error.status = response.status
    throw error
  }
  return result
}
