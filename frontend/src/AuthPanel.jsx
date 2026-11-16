import { useEffect, useRef, useState } from 'react'
import UploadPanel from './UploadPanel.jsx'

async function authRequest(path, { method = 'GET', body, token, signal } = {}) {
  const headers = {}
  if (body) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`

  let response
  try {
    response = await fetch(`/api/auth${path}`, {
      method, headers, body: body && JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000),
    })
  } catch (error) {
    if (error.name === 'AbortError') throw error
    throw new Error('The request could not reach the server. Try again.')
  }
  if (response.status === 204) return null

  const data = await response.json().catch(() => null)
  if (!response.ok || !data) {
    const error = new Error(data?.error || 'The authentication service could not respond.')
    error.status = response.status
    throw error
  }
  return data
}

export default function AuthPanel() {
  const [mode, setMode] = useState('login')
  const [email, setEmail] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [divisions, setDivisions] = useState([])
  const [divisionState, setDivisionState] = useState('loading')
  const [attempt, setAttempt] = useState(0)
  const [session, setSession] = useState(null)
  const [feedback, setFeedback] = useState(null)
  const [busy, setBusy] = useState(false)
  const heading = useRef(null)
  const registering = mode === 'register'

  useEffect(() => {
    if (!registering) return
    const controller = new AbortController()
    setDivisionState('loading')
    authRequest('/divisions', { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return
        setDivisions(data.divisions)
        setDivisionState(data.divisions.length ? 'ready' : 'failed')
      })
      .catch(() => {
        if (!controller.signal.aborted) setDivisionState('failed')
      })
    return () => controller.abort()
  }, [registering, attempt])

  function focusHeading() {
    requestAnimationFrame(() => heading.current?.focus())
  }

  function switchMode(nextMode, notice = null) {
    setMode(nextMode)
    setShowPassword(false)
    setFeedback(notice)
    if (nextMode === 'register') setDivisionState('loading')
    focusHeading()
  }

  async function submit(event) {
    event.preventDefault()
    const body = Object.fromEntries(new FormData(event.currentTarget))
    setBusy(true)
    setFeedback(null)
    try {
      const data = await authRequest(registering ? '/register' : '/login', { method: 'POST', body })
      if (registering) {
        switchMode('login', { text: 'Account created. You can now sign in.' })
      } else {
        setSession(data)
        setShowPassword(false)
        focusHeading()
      }
    } catch (error) {
      setFeedback({ text: error.message, error: true })
    } finally {
      setBusy(false)
    }
  }

  async function signOut() {
    setBusy(true)
    setFeedback(null)
    try {
      await authRequest('/logout', { method: 'POST', token: session.token })
      setSession(null)
      switchMode('login', { text: 'You signed out.' })
    } catch (error) {
      if (error.status === 401) {
        setSession(null)
        switchMode('login', { text: 'Your session ended. Sign in to continue.' })
      } else {
        setFeedback({ text: error.message, error: true })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <section id="account" className="account-panel" aria-labelledby="auth-heading" tabIndex={-1}>
      <div className="account-content">
        {!session && (
          <div className="auth-modes" role="group" aria-label="Account action">
            <button type="button" aria-pressed={!registering} disabled={busy} onClick={() => switchMode('login')}>Sign in</button>
            <button type="button" aria-pressed={registering} disabled={busy} onClick={() => switchMode('register')}>Create account</button>
          </div>
        )}
        <h2 id="auth-heading" ref={heading} tabIndex={-1}>
          {session ? 'Your account' : registering ? 'Create your account' : 'Welcome back'}
        </h2>
        <p className="account-description">
          {session ? 'You are signed in to TRIAD AI.' : registering ? 'Choose a division for your account.' : 'Enter your email and password to sign in.'}
        </p>

        {feedback && <p className={`feedback ${feedback.error ? 'error' : 'success'}`} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}

        {session ? (
          <>
            <dl className="account-details">
              <div><dt>Email</dt><dd>{session.user.email}</dd></div>
              <div><dt>Division</dt><dd>{session.user.division}</dd></div>
            </dl>
            <UploadPanel session={session} />
            <button className="primary-button" type="button" disabled={busy} onClick={signOut}>
              {busy ? 'Signing out…' : 'Sign out'}
            </button>
          </>
        ) : (
          <form key={mode} onSubmit={submit} aria-busy={busy}>
            <fieldset disabled={busy}>
              <label htmlFor="email">Email address</label>
              <input id="email" name="email" type="email" autoComplete="username" placeholder="you@example.com"
                maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} required />
              <label htmlFor="password">Password</label>
              <div className="password-field">
                <input id="password" name="password" type={showPassword ? 'text' : 'password'}
                  autoComplete={registering ? 'new-password' : 'current-password'} minLength={8} maxLength={128}
                  aria-describedby={registering ? 'password-help' : undefined} required />
                <button className="quiet-button" type="button" aria-controls="password"
                  aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(!showPassword)}>
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
              {registering && <p className="field-help" id="password-help">Use 8 to 128 characters.</p>}
              {registering && (
                <>
                  <label htmlFor="division">Division</label>
                  <select id="division" name="division_id" defaultValue="" disabled={divisionState !== 'ready'} required>
                    <option value="" disabled>{divisionState === 'loading' ? 'Loading divisions…' : 'Select a division'}</option>
                    {divisions.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
                  </select>
                  {divisionState === 'failed' && (
                    <div className="feedback error">
                      <span role="alert">Divisions could not be loaded.</span>{' '}
                      <button className="quiet-button" type="button" onClick={() => {
                        setDivisionState('loading')
                        setAttempt((value) => value + 1)
                      }}>Retry</button>
                    </div>
                  )}
                </>
              )}
            </fieldset>
            <button className="primary-button" type="submit" disabled={busy || (registering && divisionState !== 'ready')}>
              {busy ? (registering ? 'Creating account…' : 'Signing in…') : registering ? 'Create account' : 'Sign in'}
            </button>
          </form>
        )}
      </div>
    </section>
  )
}
