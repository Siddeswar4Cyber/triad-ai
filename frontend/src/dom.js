export function element(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue
    if (name.startsWith('on')) node.addEventListener(name.slice(2), value)
    else if (name === 'checked') node.checked = value
    else node.setAttribute(name, value === true ? '' : value)
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined) node.append(child)
  }
  return node
}

export function button(text, action, attrs = {}) {
  return element('button', { type: action ? 'button' : 'submit', class: action ? 'quiet-button' : 'primary-button',
    onclick: action, ...attrs }, text)
}

export function input(label, control, ...help) {
  return element('div', { class: 'option-editor' }, element('label', { for: control.id }, label), control, ...help)
}

export function textInput(id, label, attrs = {}) {
  return input(label, element('input', { id, name: id, ...attrs }))
}

export function selectInput(id, label, choices, selected = '', attrs = {}) {
  const control = element('select', { id, name: id, ...attrs }, choices.map(([value, text]) =>
    element('option', { value }, text)))
  control.value = selected
  return input(label, control)
}

export function details(entries) {
  return element('dl', { class: 'account-details' }, entries.map(([key, value]) =>
    element('div', {}, element('dt', {}, key), element('dd', {}, String(value)))))
}

export function feedback(region, text, error = false) {
  if (!text) { region.replaceChildren(); return }
  region.replaceChildren( element('p', { class: 'feedback ' + (error ? 'error' : 'success'),
    role: error ? 'alert' : 'status' }, text))
}

export async function submit(form, region, action) {
  const data = new FormData(form)
  const fieldset = form.querySelector('fieldset')
  const actionButton = form.querySelector('button[type=submit]')
  fieldset.disabled = true
  actionButton.disabled = true
  form.setAttribute('aria-busy', 'true')
  feedback(region, '')
  try {
    await action(data)
  } catch (error) {
    feedback(region, error.message, true)
  } finally {
    fieldset.disabled = false
    actionButton.disabled = false
    form.removeAttribute('aria-busy')
  }
}

export function formWith(fields, label, region, action) {
  const form = element('form', { class: 'workspace-form' }, element('fieldset', {}, fields), button(label))
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    submit(form, region, action)
  })
  return form
}
