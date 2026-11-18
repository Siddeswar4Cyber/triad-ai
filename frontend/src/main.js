import { api } from './api.js?v=cleanup'
import { element as el, button, input, textInput, formWith, feedback } from './dom.js?v=cleanup'
import { pagePaths, documentUrl, workspace, workspaceDestination } from './workspace.js?v=metadata-ui'

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

function auth() {
  const mode = page
  const registering = mode === 'register'
  const destination = safeDestination(query.get('next'))
  const content = document.querySelector('#auth-content')
  const region = el('div')
  const registeredEmail =
    !registering && query.has('registered') ? sessionStorage.getItem('triad.registrationEmail') || '' : ''
  if (!registering) sessionStorage.removeItem('triad.registrationEmail')
  if (query.has('registered')) feedback(region, 'Account created. You can now sign in.')
  if (query.has('signed-out')) feedback(region, 'You signed out.')

  const password = el('input', {
    id: 'password',
    name: 'password',
    type: 'password',
    autocomplete: registering ? 'new-password' : 'current-password',
    minlength: 8,
    maxlength: 128,
    'aria-describedby': registering ? 'password-help' : null,
    required: true,
  })
  const toggle = button(
    'Show',
    () => {
      password.type = password.type === 'password' ? 'text' : 'password'
      const show = password.type === 'password'
      toggle.textContent = show ? 'Show' : 'Hide'
      toggle.setAttribute('aria-label', show ? 'Show password' : 'Hide password')
    },
    { 'aria-label': 'Show password', 'aria-controls': 'password' }
  )
  const confirmation = el('input', {
    id: 'confirm-password',
    type: 'password',
    autocomplete: 'new-password',
    maxlength: 128,
    required: registering,
  })
  const mismatch = el(
    'p',
    { id: 'confirm-password-error', class: 'auth-field-error', role: 'status', hidden: true },
    'Passwords must match.'
  )
  confirmation.setAttribute('aria-describedby', mismatch.id)
  function checkConfirmation() {
    const invalid = Boolean(confirmation.value && confirmation.value !== password.value)
    confirmation.setCustomValidity(invalid ? 'Passwords must match.' : '')
    confirmation.setAttribute('aria-invalid', String(invalid))
    mismatch.hidden = !invalid
  }
  if (registering) {
    confirmation.addEventListener('input', checkConfirmation)
    password.addEventListener('input', checkConfirmation)
  }

  const divisionSlot = el('div')
  const loadDivisions = async () => {
    const submitButton = form.querySelector('button[type=submit]')
    submitButton.disabled = true
    divisionSlot.replaceChildren(el('p', { role: 'status' }, 'Loading divisions…'))
    try {
      const { divisions } = await api('/auth/divisions')
      if (!divisions.length) throw new Error('No divisions are available yet.')
      divisionSlot.replaceChildren(
        el(
          'fieldset',
          { class: 'auth-division' },
          el('legend', {}, 'Division'),
          el(
            'div',
            { class: 'auth-division-options' },
            divisions.map(({ id, name }) =>
              el(
                'label',
                {},
                el('input', { name: 'division_id', type: 'radio', value: id, required: true }),
                name
              )
            )
          ),
          el('p', { class: 'field-help' }, 'Choose the division where you will manage documents.')
        )
      )
      submitButton.disabled = false
    } catch (error) {
      divisionSlot.replaceChildren(el('p', { role: 'alert' }, error.message), button('Retry', loadDivisions))
    }
  }
  const label = registering ? 'Create account' : 'Sign in'
  const form = formWith(
    [
      textInput('email', 'Email address', {
        type: 'email',
        autocomplete: 'username',
        autocapitalize: 'none',
        maxlength: 254,
        placeholder: 'you@example.com',
        required: true,
        value: registeredEmail,
      }),
      el(
        'div',
        { class: 'option-editor' },
        el('label', { for: 'password' }, 'Password'),
        el('div', { class: 'password-field' }, password, toggle),
        registering ? el('p', { class: 'field-help', id: 'password-help' }, 'Use 8 to 128 characters.') : null
      ),
      registering ? input('Confirm password', confirmation, mismatch) : null,
      registering ? divisionSlot : null,
    ],
    label,
    region,
    async (data) => {
      if (registering && !data.has('division_id')) throw new Error('Choose your division.')
      const submitButton = form.querySelector('button[type=submit]')
      submitButton.textContent = registering ? 'Creating account…' : 'Signing in…'
      try {
        const result = await api('/auth/' + mode, { method: 'POST', body: Object.fromEntries(data) })
        if (registering) {
          sessionStorage.setItem('triad.registrationEmail', data.get('email').trim())
          location.replace('/?' + new URLSearchParams({ next: destination, registered: '1' }))
        } else {
          sessionStorage.setItem(tokenKey, result.token)
          const target = result.user.role === 'admin' && !query.has('next') ? pagePaths.admin : destination
          location.replace(workspaceDestination(target, result.user))
        }
      } finally {
        submitButton.textContent = label
      }
    }
  )
  content.replaceChildren(
    el(
      'p',
      { class: 'account-description' },
      registering ? 'Choose a division for your account.' : 'Enter your email and password to sign in.'
    ),
    region,
    form,
    el(
      'p',
      { class: 'auth-page-link' },
      registering ? 'Already have an account? ' : 'Need an account? ',
      el(
        'a',
        { href: (registering ? '/' : '/register.html') + '?' + new URLSearchParams({ next: destination }) },
        registering ? 'Sign in' : 'Create an account'
      )
    )
  )
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

  const target = workspaceDestination(destination, session.user)
  if (target !== destination) {
    location.replace(target)
    return
  }

  const region = el('div')
  const signOut = button('Sign out', async () => {
    signOut.disabled = true
    try {
      await api('/auth/logout', { session, method: 'POST' })
    } catch (error) {
      if (error.status !== 401) {
        feedback(region, error.message, true)
        return
      }
    } finally {
      signOut.disabled = false
    }
    sessionStorage.removeItem(tokenKey)
    location.replace('/?signed-out=1')
  })
  document
    .querySelector('#workspace-account')
    .replaceChildren(
      el(
        'div',
        { class: 'workspace-account' },
        el('div', {}, el('strong', {}, session.user.email), el('p', {}, session.user.division)),
        signOut
      ),
      region
    )
  workspace(page, root, session, query)
}

function start() {
  window.addEventListener('triad:expired', () => {
    sessionStorage.removeItem(tokenKey)
    location.replace(signInUrl(location.pathname + location.search))
  })
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
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) location.reload()
  })
  protectedPage()
}

start()
