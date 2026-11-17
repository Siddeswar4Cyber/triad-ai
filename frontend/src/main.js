import { api } from './api.js'
import { element as el, button, selectInput, textInput, formWith, feedback } from './dom.js'
import { pagePaths, documentUrl, workspace } from './workspace.js'

const page = document.body.dataset.page
const tokenKey = 'triad.session'
const query = new URLSearchParams(location.search)

function safeDestination(value) {
  try {
    const url = new URL(value || pagePaths.documents, location.origin)
    if (url.origin === location.origin && Object.values(pagePaths).includes(url.pathname)) {
      return url.pathname + url.search
    }
  } catch {
    // Invalid or external destinations fall back to the Hub.
  }
  return pagePaths.documents
}

function signInUrl(destination) {
  return '/?' + new URLSearchParams({ next: safeDestination(destination) })
}

function setStatus(id, text, state = '') {
  document.querySelector(id).replaceChildren(el('span', { class: 'dot ' + state, 'aria-hidden': 'true' }), text)
}

async function health() {
  const refresh = document.querySelector('#check-status')
  refresh.disabled = true
  setStatus('#api-status', 'Checking')
  setStatus('#db-status', 'Checking')
  try {
    const response = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(10000) })
    const status = await response.json()
    if (response.ok && status.mongodb === 'connected') {
      setStatus('#api-status', 'Reachable', 'good')
      setStatus('#db-status', 'Connected', 'good')
    } else if (response.status === 503 && status.mongodb === 'unavailable') {
      setStatus('#api-status', 'Reachable', 'good')
      setStatus('#db-status', 'Unavailable', 'bad')
    } else {
      throw new Error('Health check failed')
    }
  } catch {
    setStatus('#api-status', 'Unreachable', 'bad')
    setStatus('#db-status', 'Unknown')
  } finally {
    refresh.disabled = false
  }
}

function auth() {
  const mode = page
  const registering = mode === 'register'
  const destination = safeDestination(query.get('next'))
  const content = document.querySelector('#auth-content')
  const region = el('div')
  if (query.has('registered')) feedback(region, 'Account created. You can now sign in.')
  if (query.has('signed-out')) feedback(region, 'You signed out.')

  const password = el('input', { id: 'password', name: 'password', type: 'password',
    autocomplete: registering ? 'new-password' : 'current-password', minlength: 8, maxlength: 128,
    'aria-describedby': registering ? 'password-help' : null, required: true })
  const toggle = button('Show', () => {
    password.type = password.type === 'password' ? 'text' : 'password'
    const show = password.type === 'password'
    toggle.textContent = show ? 'Show' : 'Hide'
    toggle.setAttribute('aria-label', show ? 'Show password' : 'Hide password')
  }, { 'aria-label': 'Show password', 'aria-controls': 'password' })
  const divisionSlot = el('div')
  const loadDivisions = async () => {
    const submitButton = form.querySelector('button[type=submit]')
    submitButton.disabled = true
    divisionSlot.replaceChildren(el('p', { role: 'status' }, 'Loading divisions…'))
    try {
      const { divisions } = await api('/auth/divisions')
      divisionSlot.replaceChildren(selectInput('division_id', 'Division',
        [['', 'Select a division'], ...divisions.map(({ id, name }) => [id, name])], '', { required: true }))
      submitButton.disabled = false
    } catch (error) {
      divisionSlot.replaceChildren(el('p', { role: 'alert' }, error.message), button('Retry', loadDivisions))
    }
  }
  const form = formWith([
    textInput('email', 'Email address', { type: 'email', autocomplete: 'username',
      maxlength: 254, placeholder: 'you@example.com', required: true }),
    el('label', { for: 'password' }, 'Password'),
    el('div', { class: 'password-field' }, password, toggle),
    registering ? el('p', { class: 'field-help', id: 'password-help' }, 'Use 8 to 128 characters.') : null,
    registering ? divisionSlot : null,
  ], registering ? 'Create account' : 'Sign in', region, async (data) => {
    if (registering && !data.has('division_id')) throw new Error('Choose your division.')
    const result = await api('/auth/' + mode, { method: 'POST', body: Object.fromEntries(data) })
    if (registering) {
      location.replace('/?' + new URLSearchParams({ next: destination, registered: '1' }))
    } else {
      sessionStorage.setItem(tokenKey, result.token)
      location.replace(destination)
    }
  })
  content.replaceChildren(el('p', { class: 'account-description' }, registering
    ? 'Choose a division for your account.' : 'Enter your email and password to sign in.'), region, form,
  el('p', { class: 'auth-page-link' }, registering ? 'Already have an account? ' : 'Need an account? ',
    el('a', { href: (registering ? '/' : '/register.html') + '?' + new URLSearchParams({ next: destination }) },
      registering ? 'Sign in' : 'Create an account')))
  if (registering) loadDivisions()
}

async function protectedPage() {
  const token = sessionStorage.getItem(tokenKey)
  const destination = location.pathname + location.search
  if (!token) {
    location.replace(signInUrl(destination))
    return
  }

  const root = document.querySelector('#workspace-content')
  root.replaceChildren(el('p', { role: 'status' }, 'Loading…'))
  const session = { token }
  try {
    const { user } = await api('/auth/me', { session })
    session.user = user
  } catch (error) {
    if (error.status !== 401) {
      feedback(root, error.message, true)
      root.append(button('Retry', protectedPage))
    }
    return
  }

  const region = el('div')
  const signOut = button('Sign out', async () => {
    signOut.disabled = true
    try {
      await api('/auth/logout', { session, method: 'POST' })
    } catch (error) {
      if (error.status !== 401) { feedback(region, error.message, true); return }
    } finally {
      signOut.disabled = false
    }
    sessionStorage.removeItem(tokenKey)
    location.replace('/?signed-out=1')
  })
  document.querySelector('#workspace-account').replaceChildren(
    el('div', { class: 'workspace-account' },
      el('div', {}, el('strong', {}, session.user.email), el('p', {}, session.user.division)), signOut), region)
  workspace(page, root, session, query)
}

function start() {
  window.addEventListener('triad:expired', () => {
    sessionStorage.removeItem(tokenKey)
    location.replace(signInUrl(location.pathname + location.search))
  })
  if (page === 'status') {
    document.querySelector('#check-status').addEventListener('click', health)
    health()
    return
  }
  if (page === 'login' || page === 'register') {
    const oldPath = location.hash.slice(1)
    const oldDoc = /^documents\/([a-f0-9]{24})$/i.exec(oldPath)
    if (oldDoc || Object.hasOwn(pagePaths, oldPath)) {
      location.replace(oldDoc ? documentUrl(oldDoc[1]) : pagePaths[oldPath])
    } else if (sessionStorage.getItem(tokenKey)) {
      location.replace(safeDestination(query.get('next')))
    } else {
      auth()
    }
    return
  }
  window.addEventListener('pageshow', (event) => { if (event.persisted) location.reload() })
  protectedPage()
}

start()
