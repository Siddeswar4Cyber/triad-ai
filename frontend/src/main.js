import { api } from './api.js'
import { element as el, button, selectInput, textInput, formWith, feedback } from './dom.js'
import { workspace } from './workspace.js'

const panel = document.querySelector('#account')
const content = document.querySelector('#account-content')
const intro = document.querySelector('#workspace-intro')
const refresh = document.querySelector('#check-status')
let session
let cleanup
let email = ''

function setStatus(id, text, state = '') {
  document.querySelector(id).replaceChildren(el('span', { class: 'dot ' + state, 'aria-hidden': 'true' }), text)
}

async function health() {
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

function auth(mode = 'login', notice, focus = false) {
  cleanup?.()
  cleanup = null
  panel.classList.remove('signed-in')
  intro.textContent = 'Sign in to your division workspace.'
  const registering = mode === 'register'
  const heading = el('h2', { id: 'auth-heading', tabindex: -1 }, registering ? 'Create your account' : 'Welcome back')
  const region = el('div')
  feedback(region, notice)
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
    textInput('email', 'Email address', { type: 'email', value: email, autocomplete: 'username',
      maxlength: 254, placeholder: 'you@example.com', required: true,
      oninput: (event) => { email = event.target.value } }),
    el('label', { for: 'password' }, 'Password'),
    el('div', { class: 'password-field' }, password, toggle),
    registering ? el('p', { class: 'field-help', id: 'password-help' }, 'Use 8 to 128 characters.') : null,
    registering ? divisionSlot : null,
  ], registering ? 'Create account' : 'Sign in', region, async (data) => {
    const result = await api('/auth/' + mode, { method: 'POST', body: Object.fromEntries(data) })
    if (registering) auth('login', 'Account created. You can now sign in.', true)
    else { session = result; signedIn() }
  })
  content.replaceChildren(el('div', { class: 'auth-modes', role: 'group', 'aria-label': 'Account action' },
    button('Sign in', () => { if (!form.hasAttribute('aria-busy') && registering) auth('login', '', true) }, { 'aria-pressed': String(!registering) }),
    button('Create account', () => { if (!form.hasAttribute('aria-busy') && !registering) auth('register', '', true) }, { 'aria-pressed': String(registering) })),
  heading, el('p', { class: 'account-description' }, registering
    ? 'Choose a division for your account.' : 'Enter your email and password to sign in.'), region, form)
  if (registering) loadDivisions()
  if (focus) heading.focus()
}

function signedIn() {
  panel.classList.add('signed-in')
  intro.textContent = 'Manage documents in your division workspace.'
  const heading = el('h2', { id: 'auth-heading', tabindex: -1 }, 'Your workspace')
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
    session = null
    auth('login', 'You signed out.', true)
  })
  const account = el('div', { class: 'workspace-account' },
    el('div', {}, el('strong', {}, session.user.email), el('p', {}, session.user.division)), signOut)
  const outlet = el('div')
  content.replaceChildren(heading, el('p', { class: 'account-description' }, 'You are signed in to TRIAD AI.'), region, account, outlet)
  cleanup = workspace(outlet, session)
  heading.focus()
}

refresh.addEventListener('click', health)
health()
auth()
