import { api } from './api.js'
import { element as el, button, textInput, selectInput, formWith, feedback } from './dom.js'

function checkbox(name, label, checked) {
  return el('label', { class: 'check-label' }, el('input', { name, type: 'checkbox', checked }), ' ' + label)
}

export async function settings(session, root, signal) {
  const region = el('div')
  const actions = el('div', { class: 'action-row' }, el('p', { role: 'status' }, 'Loading fields…'))
  const editor = el('div')
  root.append(region, actions, editor)

  async function load() {
    const { fields } = await api('/metadata-fields?all=1', { session, signal })
    actions.replaceChildren(...fields.map((field) => button(field.label + (field.active ? '' : ' (retired)'), () =>
      edit(field, true))), button('Add field', () => edit({ key: '', label: '', type: 'text', active: true,
      required: false, options: [] }, false)))
  }

  function edit(field, existing) {
    feedback(region, '')
    const choices = el('div')
    const type = selectInput('field-type', 'Type', [['text', 'Text'], ['select', 'Select']],
      field.type, { disabled: existing })
    const typeControl = type.querySelector('select')
    function addChoice(option = {}) {
      const row = el('div', { class: 'option-editor', 'data-option': option.id || '' })
      const id = 'choice-' + crypto.randomUUID()
      row.append(textInput(id, 'Choice label', { value: option.label || '', required: true, maxlength: 80 }),
        checkbox('choice-active', 'Active choice', option.active ?? true))
      if (!option.id) row.append(button('Remove new choice', () => row.remove()))
      choices.insertBefore(row, add)
    }
    const add = button('Add choice', () => addChoice())
    choices.append(add)
    field.options.forEach(addChoice)
    function updateType() {
      choices.hidden = typeControl.value !== 'select'
      for (const control of choices.querySelectorAll('input')) control.disabled = choices.hidden
    }
    typeControl.addEventListener('change', updateType)
    updateType()

    editor.replaceChildren(formWith([
      textInput('field-key', 'Field key', { value: field.key, required: true, readonly: existing, pattern: '[a-z][a-z0-9_]{0,39}' }),
      textInput('field-label', 'Label', { value: field.label, required: true, maxlength: 80 }),
      type, checkbox('required', 'Required on upload', field.required), checkbox('active', 'Active', field.active),
      choices,
    ], 'Save field', region, async (data) => {
      const options = typeControl.value === 'select' ? [...choices.querySelectorAll('[data-option]')].map((row) => ({
        id: row.dataset.option || undefined, label: row.querySelector('input[type=text], input:not([type])').value,
        active: row.querySelector('input[type=checkbox]').checked,
      })) : []
      await api('/metadata-fields' + (existing ? '/' + field.key : ''), {
        session, method: existing ? 'PATCH' : 'POST', body: {
          key: data.get('field-key'), label: data.get('field-label'), type: typeControl.value,
          required: data.has('required'), active: data.has('active'), options,
        },
      })
      editor.replaceChildren()
      feedback(region, 'Field saved.')
      await load()
    }))
  }

  await load()
}
