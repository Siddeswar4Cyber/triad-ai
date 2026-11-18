import { api } from './api.js?v=cleanup'
import { element as el, button, textInput, selectInput, formWith, feedback } from './dom.js?v=cleanup'
import { metadataSettings } from './metadata-settings.js?v=metadata-ui'

function divisionOptions(divisions) {
  return [
    ['', 'All divisions'],
    ...divisions.map(({ id, name, active }) => [id, name + (active ? '' : ' (inactive)')]),
  ]
}

function manageDivisions(root, session, signal, divisions) {
  const notice = el('div')
  const list = el('ul', { class: 'admin-division-list', 'aria-label': 'Divisions' })
  const addForm = formWith(
    [
      textInput('new-division-name', 'New division name', {
        name: 'name',
        required: true,
        maxlength: 80,
      }),
    ],
    'Add division',
    notice,
    async (form) => {
      const { division } = await api('/admin/divisions', {
        session,
        signal,
        method: 'POST',
        body: { name: form.get('name') },
      })
      list.append(divisionRow(division))
      addForm.reset()
      feedback(notice, division.name + ' was added.')
    }
  )
  addForm.classList.add('admin-add-division')

  function divisionRow(division) {
    const output = el('div')
    const heading = el('h3', {}, division.name)
    const state = el(
      'span',
      { class: 'admin-division-status', 'data-active': String(division.active) },
      division.active ? 'Active' : 'Inactive'
    )
    const editId = 'rename-division-' + division.id
    const nameField = textInput('division-' + division.id, 'Division name', {
      name: 'name',
      required: true,
      maxlength: 80,
    })
    const input = nameField.querySelector('input')
    const editor = formWith([nameField], 'Save name', output, async (form) => {
      rename.disabled = true
      try {
        const { division: saved } = await api('/admin/divisions/' + division.id, {
          session,
          signal,
          method: 'PATCH',
          body: { name: form.get('name') },
        })
        division.name = heading.textContent = saved.name
        feedback(output, 'Division name updated.')
      } finally {
        rename.disabled = false
      }
      setEditing(false)
    })
    editor.id = editId
    editor.classList.add('admin-rename-division')
    editor.hidden = true

    function setEditing(editing) {
      editor.hidden = !editing
      rename.setAttribute('aria-expanded', String(editing))
      rename.textContent = editing ? 'Cancel rename' : 'Rename'
      if (editing) {
        feedback(output, '')
        input.value = division.name
        input.focus()
        input.select()
      } else {
        rename.focus()
      }
    }

    const rename = button('Rename', () => setEditing(editor.hidden), {
      'aria-expanded': 'false',
      'aria-controls': editId,
    })

    const toggle = button(division.active ? 'Deactivate' : 'Reactivate', async () => {
      toggle.disabled = true
      try {
        const { division: saved } = await api('/admin/divisions/' + division.id, {
          session,
          signal,
          method: 'PATCH',
          body: { active: !division.active },
        })
        division.active = saved.active
        state.dataset.active = String(saved.active)
        state.textContent = saved.active ? 'Active' : 'Inactive'
        toggle.textContent = saved.active ? 'Deactivate' : 'Reactivate'
        feedback(
          output,
          saved.active ? 'Division reactivated.' : 'Division deactivated. Existing records are retained.'
        )
      } catch (error) {
        if (!signal.aborted) feedback(output, error.message, true)
      } finally {
        toggle.disabled = false
      }
    })
    return el(
      'li',
      { class: 'admin-division-row' },
      el(
        'div',
        { class: 'admin-division-summary' },
        el('div', { class: 'admin-division-identity' }, heading, state),
        el('div', { class: 'admin-division-actions' }, rename, toggle)
      ),
      editor,
      output
    )
  }

  root.append(
    el(
      'p',
      { class: 'admin-description' },
      'Inactive divisions keep their users and documents. New signups and uploads are disabled until reactivated.'
    ),
    addForm,
    notice,
    list
  )
  list.append(...divisions.map(divisionRow))
}

function documentMetadataEditor(doc, path, session, signal, onSave) {
  const title = el('h2', { id: 'metadata-title-' + doc.doc_id }, 'Edit metadata')
  const panel = el('div', { class: 'document-preview-body' })
  const dialog = el(
    'dialog',
    { class: 'document-preview admin-metadata-dialog', 'aria-labelledby': title.id },
    el(
      'header',
      { class: 'document-preview-heading' },
      title,
      button('Close', () => dialog.close(), { autofocus: true })
    ),
    panel
  )
  let request
  const open = button('Edit metadata', () => {
    request?.abort()
    request = new AbortController()
    dialog.showModal()
    load(AbortSignal.any([signal, request.signal]))
  })
  dialog.addEventListener('close', () => {
    if (!dialog.open) request?.abort()
  })

  async function load(editorSignal) {
    panel.replaceChildren(el('p', { role: 'status' }, 'Loading metadata…'))
    try {
      const { fields, values } = await api(path + '/metadata', { session, signal: editorSignal })
      if (editorSignal.aborted) return
      const notice = el('div')
      const initial = new Map()
      const inputs = fields.map(({ key, label, type, options }) => {
        const id = 'doc-meta-' + doc.doc_id + '-' + key
        const value = String(values[key] ?? '')
        if (type === 'select') {
          const choices = [
            ['', 'No value'],
            ...options.filter(({ active }) => active).map(({ id, label }) => [id, label]),
          ]
          const legacy = value && !choices.some(([id]) => id === value)
          const selected = legacy ? '__current' : value
          if (legacy)
            choices.unshift([
              selected,
              'Current: ' + (options.find(({ id }) => id === value)?.label ?? value),
            ])
          initial.set(key, selected)
          return selectInput(id, label, choices, selected, { name: key })
        }
        initial.set(key, value)
        return textInput(id, label, { name: key, value, maxlength: 500 })
      })
      const form = formWith(inputs, 'Save metadata', notice, async (data) => {
        const metadata = Object.fromEntries([...data].filter(([key, value]) => value !== initial.get(key)))
        if (!Object.keys(metadata).length) {
          feedback(notice, 'No changes to save.')
          return
        }
        await api(path + '/metadata', { session, signal: editorSignal, method: 'PATCH', body: { metadata } })
        if (editorSignal.aborted) return
        dialog.close()
        onSave()
      })
      panel.replaceChildren(
        el('p', { class: 'admin-description' }, doc.title),
        notice,
        fields.length ? form : el('p', {}, 'No active metadata fields are configured.')
      )
    } catch (error) {
      if (!editorSignal.aborted) feedback(panel, error.message, true)
    }
  }
  return [open, dialog]
}

function manageDocuments(
  root,
  session,
  signal,
  divisions,
  { renderDocument, paging, searchScopes, filePreview, downloadButton }
) {
  const filter = selectInput('admin-doc-division', 'Owning division', divisionOptions(divisions))
  const control = filter.querySelector('select')
  const term = textInput('admin-doc-query', 'Search documents', {
    type: 'search',
    name: 'q',
    maxlength: 100,
    placeholder: 'Title, metadata, or extracted text',
  })
  const scope = selectInput('admin-doc-scope', 'Search in', searchScopes, 'all', { name: 'scope' })
  const searchInput = term.querySelector('input')
  const scopeControl = scope.querySelector('select')
  const params = new URLSearchParams(location.search)
  control.value = divisions.some(({ id }) => id === params.get('division_id'))
    ? params.get('division_id')
    : ''
  searchInput.value = params.get('q') || ''
  scopeControl.value = searchScopes.some(([value]) => value === params.get('scope'))
    ? params.get('scope')
    : 'all'
  let searchQuery = searchInput.value.trim()
  let searchScope = scopeControl.value
  const list = el('div')
  const notice = el('div')
  let revision = 0
  const clear = button('Clear search', () => {
    searchInput.value = searchQuery = ''
    scopeControl.value = searchScope = 'all'
    load()
    searchInput.focus()
  })
  const form = el(
    'form',
    { class: 'admin-document-controls', role: 'search' },
    term,
    scope,
    filter,
    el('div', { class: 'action-row' }, button('Search'), clear)
  )
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    searchQuery = searchInput.value.trim()
    searchScope = scopeControl.value
    load()
  })
  root.append(
    metadataSettings(session, signal, () => load()),
    form,
    notice,
    list
  )

  async function load(page = 1) {
    const current = ++revision
    list.replaceChildren(el('p', { role: 'status' }, 'Loading documents…'))
    try {
      const query = new URLSearchParams({ page, division_id: control.value })
      clear.hidden = !searchQuery
      if (searchQuery) {
        query.set('q', searchQuery)
        query.set('scope', searchScope)
      }
      const result = await api('/admin/documents?' + query, { session, signal })
      if (signal.aborted || revision !== current) return
      list.replaceChildren(
        el(
          'p',
          { class: 'field-help admin-count', role: 'status' },
          result.documents.length +
            (result.documents.length === 1 ? ' document' : ' documents') +
            ' on this page' +
            (searchQuery ? ' for “' + searchQuery + '”' : '')
        )
      )
      if (result.documents.length) {
        list.append(
          el(
            'div',
            { class: 'hub-list-heading document-list-heading', 'aria-hidden': 'true' },
            el('span', {}, 'File and division'),
            el('span', {}, 'Uploaded'),
            el('span', {}, 'Text status'),
            el('span', {}, 'Actions')
          ),
          el(
            'ul',
            { class: 'hub-file-list document-rows' },
            result.documents.map((doc) => {
              const path = '/documents/' + doc.doc_id
              const downloadNotice = el('div')
              const [view, preview] = filePreview(doc, path, session, signal, 'View')
              const actions = el(
                'div',
                { class: 'document-actions', role: 'group', 'aria-label': 'Actions for ' + doc.title },
                view,
                preview,
                downloadButton(doc, path, session, signal, downloadNotice),
                ...documentMetadataEditor(doc, path, session, signal, () => {
                  feedback(notice, 'Metadata saved for ' + doc.title + '.')
                  load(page)
                }),
                downloadNotice
              )
              return renderDocument(doc, actions, () => view.click())
            })
          )
        )
      } else {
        list.append(
          el(
            'p',
            { class: 'admin-description' },
            searchQuery
              ? 'No documents match this search.'
              : 'No documents found for the selected division filter.'
          )
        )
      }
      const nav = paging(result, load)
      if (nav) list.append(nav)
    } catch (error) {
      if (signal.aborted || revision !== current) return
      feedback(list, error.message, true)
      list.append(button('Retry loading documents', () => load(page)))
    }
  }

  control.addEventListener('change', () => load())
  return load()
}

async function systemStatus(root, signal) {
  const apiState = el('dd')
  const dbState = el('dd')
  const summary = el('p', { class: 'admin-health-summary', role: 'status' })
  const checked = el('p', { class: 'admin-health-checked' })
  const refresh = button('Check again', check, { class: 'admin-health-refresh' })
  const services = el(
    'dl',
    { class: 'admin-health-services', 'aria-label': 'Service availability' },
    el('div', {}, el('dt', {}, 'Flask API'), apiState),
    el('div', {}, el('dt', {}, 'MongoDB'), dbState)
  )
  root.append(el('div', { class: 'admin-health-heading' }, summary, refresh), services, checked)
  function state(target, text, style = '') {
    target.dataset.state = style
    target.replaceChildren(el('span', { class: 'admin-health-dot', 'aria-hidden': 'true' }), text)
  }
  async function check() {
    refresh.disabled = true
    refresh.textContent = 'Checking…'
    summary.textContent = 'Checking service availability…'
    summary.dataset.state = 'checking'
    services.setAttribute('aria-busy', 'true')
    state(apiState, 'Checking')
    state(dbState, 'Checking')
    try {
      const response = await fetch('/api/health', {
        cache: 'no-store',
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      })
      const result = await response.json()
      if (signal.aborted) return
      if (response.ok && result.mongodb === 'connected') {
        state(apiState, 'Reachable', 'good')
        state(dbState, 'Connected', 'good')
        summary.textContent = 'All checked services are available'
        summary.dataset.state = 'good'
      } else if (response.status === 503 && result.mongodb === 'unavailable') {
        state(apiState, 'Reachable', 'good')
        state(dbState, 'Unavailable', 'bad')
        summary.textContent = 'Database connection needs attention'
        summary.dataset.state = 'bad'
      } else {
        throw new Error('Unexpected health response')
      }
    } catch {
      if (signal.aborted) return
      state(apiState, 'Unreachable', 'bad')
      state(dbState, 'Unknown')
      summary.textContent = 'Unable to reach the API'
      summary.dataset.state = 'bad'
    } finally {
      if (signal.aborted) return
      refresh.disabled = false
      refresh.textContent = 'Check again'
      services.setAttribute('aria-busy', 'false')
      checked.replaceChildren(
        'Last checked ',
        el(
          'time',
          { datetime: new Date().toISOString() },
          new Intl.DateTimeFormat(undefined, {
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit',
          }).format(new Date())
        )
      )
    }
  }
  return check()
}

async function activityLog(root, session, signal, paging) {
  const labels = {
    account_registered: 'Account registered',
    signed_in: 'Signed in',
    signed_out: 'Signed out',
    document_uploaded: 'Document uploaded',
    document_downloaded: 'Document downloaded',
    document_metadata_updated: 'Document metadata updated',
    access_requested: 'Access requested',
    access_approved: 'Access approved',
    access_rejected: 'Access rejected',
    division_created: 'Division created',
    division_updated: 'Division updated',
    metadata_field_updated: 'Metadata field updated',
    report_type_added: 'Report type added',
    admin_promoted: 'Admin promoted',
  }
  const categories = [
    ['', 'All activity', []],
    ['accounts', 'Accounts', ['account_registered', 'signed_in', 'signed_out', 'admin_promoted']],
    ['documents', 'Documents', ['document_uploaded', 'document_downloaded', 'document_metadata_updated']],
    ['requests', 'Access requests', ['access_requested', 'access_approved', 'access_rejected']],
    [
      'administration',
      'Administration',
      ['division_created', 'division_updated', 'metadata_field_updated', 'report_type_added'],
    ],
  ]
  let category = ''
  let action = ''
  const filters = el('div', { class: 'admin-log-filters', role: 'group', 'aria-label': 'Activity category' })
  const types = el('div', { class: 'admin-log-types', role: 'group', 'aria-label': 'Activity type' })
  function renderFilters() {
    filters.replaceChildren(
      ...categories.map(([key, label]) =>
        button(
          label,
          () => {
            category = key
            action = ''
            renderFilters()
            load()
          },
          { 'aria-pressed': String(category === key) }
        )
      )
    )
    const selected = categories.find(([key]) => key === category)
    types.hidden = !category
    types.replaceChildren(
      ...[['', 'All ' + selected[1].toLowerCase()], ...selected[2].map((key) => [key, labels[key]])].map(
        ([key, label]) =>
          button(
            label,
            () => {
              action = key
              renderFilters()
              load()
            },
            { 'aria-pressed': String(action === key) }
          )
      )
    )
  }
  const results = el('div')
  let revision = 0
  const statistics = el('dl', {
    class: 'admin-log-statistics',
    'aria-label': 'Recorded activity totals',
    'aria-busy': 'true',
  })
  const totals = [
    ['accounts', 'New accounts'],
    ['uploads', 'Document uploads'],
    ['approvals', 'Approved requests'],
  ]
  function showStatistics(values) {
    statistics.replaceChildren(
      ...totals.map(([key, label]) =>
        el(
          'div',
          {},
          el('dt', {}, label),
          el('dd', {}, values ? new Intl.NumberFormat().format(values[key]) : '—')
        )
      )
    )
  }
  showStatistics()
  root.append(
    statistics,
    el(
      'p',
      { class: 'field-help admin-log-statistics-note' },
      'Totals across all categories since activity logging began.'
    ),
    el(
      'div',
      { class: 'admin-log-controls' },
      filters,
      button('Refresh', () => load())
    ),
    types,
    el(
      'p',
      { class: 'field-help' },
      'Activity is recorded from when logging was enabled. Times use your local timezone.'
    ),
    results
  )
  renderFilters()
  async function load(page = 1) {
    const current = ++revision
    statistics.setAttribute('aria-busy', 'true')
    results.replaceChildren(el('p', { role: 'status' }, 'Loading activity…'))
    try {
      const query = new URLSearchParams({ page, category, action })
      const result = await api('/admin/activity?' + query, { session, signal })
      if (signal.aborted || current !== revision) return
      showStatistics(result.statistics)
      statistics.setAttribute('aria-busy', 'false')
      results.replaceChildren()
      if (!result.entries.length) results.append(el('p', {}, 'No activity found.'))
      const list = el('ol', { class: 'admin-log-list' })
      for (const entry of result.entries) {
        const time = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
          new Date(entry.created_at)
        )
        list.append(
          el(
            'li',
            { class: 'admin-log-entry' },
            el(
              'div',
              { class: 'admin-log-heading' },
              el('h3', {}, labels[entry.action] || entry.action),
              el('time', { datetime: entry.created_at }, time)
            ),
            el(
              'p',
              { class: 'field-help' },
              entry.actor.email +
                (entry.division ? ' · ' + entry.division : '') +
                (entry.actor.role ? ' · ' + entry.actor.role : '')
            ),
            el(
              'dl',
              { class: 'admin-log-details' },
              Object.entries(entry.details).map(([key, value]) =>
                el(
                  'div',
                  {},
                  el('dt', {}, key.replaceAll('_', ' ')),
                  el('dd', {}, Array.isArray(value) ? value.join(', ') : String(value))
                )
              )
            )
          )
        )
      }
      results.append(list)
      const nav = paging(result, load)
      if (nav) results.append(nav)
    } catch (error) {
      if (signal.aborted || current !== revision) return
      showStatistics()
      statistics.setAttribute('aria-busy', 'false')
      feedback(results, error.message, true)
      results.append(button('Retry', () => load(page)))
    }
  }
  return load()
}

export async function adminWorkspace(root, session, signal, features) {
  const views = [
    ['divisions', 'Divisions', 'Manage divisions', 'Add, rename, deactivate, or reactivate divisions.'],
    [
      'documents',
      'Documents',
      'Browse and search documents',
      'Search titles, metadata, and extracted text across divisions.',
    ],
    [
      'requests',
      'Incoming requests',
      'Review access requests',
      'Filter requests by owning division and approve or reject pending requests.',
    ],
    ['status', 'System status', 'System status', 'Check API availability and the database connection.'],
    [
      'activity',
      'Activity log',
      'Activity across all divisions',
      'Review account registrations, uploads, access decisions, and administrative changes.',
    ],
  ]
  const params = new URLSearchParams(location.search)
  const [view, label, title, description] = views.find(([key]) => key === params.get('view')) || views[0]
  const isDetail = view === 'documents' && params.has('id')
  const content = el(
    'section',
    { class: 'admin-section', 'aria-labelledby': 'admin-section-title' },
    el('h2', { id: 'admin-section-title' }, isDetail ? 'File information' : label)
  )
  const panel = el('div')
  content.append(panel)
  root.append(
    el(
      'header',
      { class: 'admin-banner' },
      el('h2', {}, isDetail ? 'Document details' : title),
      el(
        'p',
        {},
        isDetail ? 'Review file information, metadata, and download access for this document.' : description
      )
    ),
    el(
      'nav',
      { class: 'admin-views', 'aria-label': 'Admin sections' },
      views.map(([key, label]) =>
        el(
          'a',
          {
            href: '/admin.html?view=' + key,
            'aria-current': key === view ? 'page' : null,
          },
          label
        )
      )
    ),
    content
  )

  if (view === 'status') return systemStatus(panel, signal)
  if (view === 'activity') return activityLog(panel, session, signal, features.paging)
  if (isDetail) {
    panel.append(
      el('p', { class: 'admin-back' }, el('a', { href: '/admin.html?view=documents' }, 'Back to documents'))
    )
    const detail = el('div')
    panel.append(detail)
    return features.showDocument(detail, session, params.get('id'), signal)
  }

  const { divisions } = await api('/admin/divisions', { session, signal })
  if (signal.aborted) return
  if (view === 'documents') return manageDocuments(panel, session, signal, divisions, features)
  if (view === 'requests') return features.showRequests(panel, session, signal, divisions)
  return manageDivisions(panel, session, signal, divisions)
}
