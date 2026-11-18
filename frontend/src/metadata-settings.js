import { api } from './api.js?v=cleanup'
import { element as el, button, textInput, selectInput, formWith, feedback } from './dom.js?v=cleanup'

function checkbox(name, label, checked) {
  return el('label', { class: 'metadata-toggle' }, el('input', { name, type: 'checkbox', checked }), label)
}

export function metadataSettings(session, signal, onChange) {
  const root = el('details', { class: 'admin-field-settings' })
  const notice = el('div')
  const fieldsList = el('div', { class: 'admin-field-list' })
  const editor = el('div')
  let loaded = false
  root.append(
    el('summary', {}, 'Manage metadata fields'),
    el(
      'p',
      { class: 'field-help' },
      'Shared fields and dropdown choices apply to uploads, filters, and document metadata across all divisions.'
    ),
    notice,
    fieldsList,
    editor
  )
  root.addEventListener('toggle', () => {
    if (root.open && !loaded) load()
  })

  async function load() {
    loaded = true
    fieldsList.replaceChildren(el('p', { role: 'status' }, 'Loading fields…'))
    try {
      const { fields } = await api('/metadata-fields?all=1', { session, signal })
      if (signal.aborted) return
      fieldsList.replaceChildren(
        ...fields.map((field) => button(field.label + (field.active ? '' : ' (retired)'), () => edit(field))),
        button('Add field', () => edit())
      )
    } catch (error) {
      if (signal.aborted) return
      loaded = false
      feedback(notice, error.message, true)
      fieldsList.replaceChildren(button('Retry loading fields', load))
    }
  }

  function edit(existing) {
    const field = existing || { key: '', label: '', type: 'text', required: false, active: true, options: [] }
    feedback(notice, '')
    const type = selectInput(
      'metadata-field-type',
      'Type',
      [
        ['text', 'Text'],
        ['select', 'Dropdown'],
      ],
      field.type,
      { name: 'type', disabled: Boolean(existing) }
    )
    const typeControl = type.querySelector('select')
    const choices = el('div', { class: 'admin-field-choices' })
    let choiceNumber = 0
    const addChoice = button('Add choice', () => choice())
    choices.append(addChoice)

    function choice(option = {}) {
      const row = el('div', { class: 'admin-field-choice', 'data-option-id': option.id || '' })
      const label = textInput('metadata-choice-' + ++choiceNumber, 'Choice label', {
        value: option.label || '',
        maxlength: 80,
        required: true,
      })
      row.append(label, checkbox('choice-active', 'Active choice', option.active ?? true))
      if (!option.id) row.append(button('Remove choice', () => row.remove()))
      choices.insertBefore(row, addChoice)
    }
    field.options.forEach(choice)
    function updateType() {
      choices.hidden = typeControl.value !== 'select'
      for (const control of choices.querySelectorAll('input, button')) control.disabled = choices.hidden
    }
    typeControl.addEventListener('change', updateType)
    updateType()

    const form = formWith(
      [
        textInput('metadata-field-key', 'Field key', {
          name: 'key',
          value: field.key,
          required: true,
          readonly: Boolean(existing),
          pattern: '[a-z][a-z0-9_]{0,39}',
          maxlength: 40,
        }),
        el(
          'p',
          { class: 'field-help' },
          'Use a lowercase key such as cost_center. Keys and existing field types stay fixed to preserve saved values.'
        ),
        textInput('metadata-field-label', 'Field label', {
          name: 'label',
          value: field.label,
          required: true,
          maxlength: 80,
        }),
        type,
        checkbox('required', 'Required on new uploads', field.required),
        checkbox('active', 'Active field', field.active),
        choices,
      ],
      'Save field',
      notice,
      async (data) => {
        const options =
          typeControl.value === 'select'
            ? [...choices.querySelectorAll('[data-option-id]')].map((row) => ({
                id: row.dataset.optionId || undefined,
                label: row.querySelector('input:not([type=checkbox])').value.trim(),
                active: row.querySelector('input[type=checkbox]').checked,
              }))
            : []
        await api('/metadata-fields' + (existing ? '/' + field.key : ''), {
          session,
          signal,
          method: existing ? 'PATCH' : 'POST',
          body: {
            key: data.get('key'),
            label: data.get('label'),
            type: typeControl.value,
            required: data.has('required'),
            active: data.has('active'),
            options,
          },
        })
        if (signal.aborted) return
        editor.replaceChildren()
        feedback(notice, 'Shared metadata field saved.')
        await load()
        onChange()
      }
    )
    form.append(button('Cancel', () => editor.replaceChildren()))
    editor.replaceChildren(
      el('h3', {}, existing ? 'Edit ' + field.label : 'Add metadata field'),
      form,
      el(
        'p',
        { class: 'field-help' },
        'Retire fields or choices by clearing Active. Historical document values remain readable.'
      )
    )
    editor.querySelector(existing ? '#metadata-field-label' : '#metadata-field-key').focus()
  }
  return root
}
