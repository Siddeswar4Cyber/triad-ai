export async function api(session, path, { method = 'GET', body, signal, binary = false } = {}) {
  const headers = { Authorization: `Bearer ${session.token}` }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const response = await fetch('/api' + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
  })
  if (binary && response.ok) return response.blob()
  const result = await response.json().catch(() => null)
  if (!response.ok || !result) throw new Error(result?.error || 'The service could not complete the request.')
  return result
}
