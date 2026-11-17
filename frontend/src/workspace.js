import { api } from './api.js'
import { element as el, button, textInput, selectInput, formWith, details, feedback } from './dom.js'
import { settings } from './settings.js'

const maxFileBytes = 10 * 1024 * 1024

function heading(title) {
  return el('h3', { tabindex: -1 }, title)
}

function documentLink(docId, title) {
  return el('a', { href: documentUrl(docId) }, title)
}

function paging({ page, has_more }, load) {
  if (page === 1 && !has_more) return null
  return el('div', { class: 'action-row', 'aria-label': 'Pagination' },
    button('Previous', () => load(page - 1), { disabled: page === 1 }),
    el('span', {}, 'Page ' + page), button('Next', () => load(page + 1), { disabled: !has_more }))
}

async function replaceResults(root, signal, load) {
  root.replaceChildren(el('p', { role: 'status' }, 'Loading…'))
  try {
    const parts = await load()
    if (!signal.aborted) root.replaceChildren(...parts.filter(Boolean))
  } catch (error) {
    if (!signal.aborted) feedback(root, error.message, true)
  }
}

function showDocuments(root, session, path, query, signal) {
  function load(page = 1) {
    return replaceResults(root, signal, async () => {
      const params = new URLSearchParams(query)
      params.set('page', page)
      const result = await api(path + '?' + params, { session, signal })
      const list = result.documents.length ? el('ul', { class: 'document-list' },
        result.documents.map((doc) => el('li', {}, documentLink(doc.doc_id, doc.title), el('span', {}, doc.division))))
        : el('p', {}, 'No documents found.')
      return [list, paging(result, load)]
    })
  }
  return load()
}

function metadataInputs(fields, prefix, filtering = false) {
  return fields.map((field) => {
    const id = prefix + '-' + field.key
    const label = field.label + (!filtering && !field.required ? ' (optional)' : '')
    const attrs = { name: field.key, required: !filtering && field.required }
    if (field.type === 'select') {
      return selectInput(id, label, [['', filtering ? 'Any' : 'Select a choice'],
        ...field.options.map((option) => [option.id, option.label])], '', attrs)
    }
    return textInput(id, label, { ...attrs, maxlength: 500 })
  })
}

async function hub(root, session, signal) {
  const region = el('div')
  const results = el('div')
  const { fields } = await api('/metadata-fields', { session, signal })
  if (signal.aborted) return
  const division = selectInput('filter-division', 'Division', [['', 'My division'],
    [session.user.division_id, session.user.division]], '', { name: 'Division' })
  root.append(formWith([division, ...metadataInputs(fields, 'filter', true)], 'Apply filters', region,
    (data) => showDocuments(results, session, '/documents', [...data].filter(([, value]) => value), signal)),
  region, results)
  await showDocuments(results, session, '/documents', [], signal)
}

function search(root, session, signal) {
  const region = el('div')
  const results = el('div')
  const query = textInput('search-query', 'Search documents', { name: 'q', type: 'search', maxlength: 100, required: true })
  root.append(el('p', {}, 'Search document titles, metadata, and extracted text in your division.'),
    formWith([query], 'Search', region, (data) => showDocuments(results, session, '/search',
      { q: data.get('q').trim() }, signal)), region, results)
}

async function upload(root, session, signal) {
  const { fields } = await api('/metadata-fields', { session, signal })
  if (signal.aborted) return
  const region = el('div')
  const file = textInput('upload-file', 'File', { name: 'file', type: 'file', required: true,
    accept: '.pdf,.png,.jpg,.jpeg,.tif,.tiff,.webp', 'aria-describedby': 'upload-help' })
  const form = formWith([file, el('p', { id: 'upload-help', class: 'field-help' },
    'PDF, PNG, JPEG, TIFF, or WebP. Up to 10 MiB.'), ...metadataInputs(fields, 'upload')],
  'Upload document', region, async (data) => {
    const attachment = data.get('file')
    if (!attachment.size || attachment.size > maxFileBytes) throw new Error('Choose a nonempty file up to 10 MiB.')
    const multipart = new FormData()
    multipart.set('file', attachment)
    const metadata = Object.fromEntries(fields.map(({ key }) => [key, data.get(key).trim()]).filter(([, value]) => value))
    multipart.set('metadata', JSON.stringify(metadata))
    const result = await api('/documents/upload', { session, method: 'POST', body: multipart, signal })
    form.reset()
    feedback(region, result.filename + ' was uploaded to ' + session.user.division + '.')
    region.append(documentLink(result.doc_id, 'View uploaded document'))
  })
  form.classList.add('upload-panel')
  root.append(el('p', { class: 'field-help' }, 'Destination: ' + session.user.division), form, region)
}

function showDetails(root, session, id, signal) {
  const path = '/documents/' + id
  async function load() {
    await replaceResults(root, signal, async () => {
      const { document: doc } = await api(path, { session, signal })
      const region = el('div')
      const entries = [['Division', doc.division]]
      if (!doc.can_download) {
        const requestAccess = button('Request access', async () => {
          requestAccess.disabled = true
          try {
            await api('/access/request', { session, method: 'POST', body: { doc_id: id }, signal })
            await load()
          } catch (error) {
            feedback(region, error.message, true)
          } finally {
            requestAccess.disabled = false
          }
        }, { class: 'primary-button' })
        const controls = doc.request_status
          ? [el('p', { role: 'status' }, 'Access request: ' + doc.request_status + '.'), button('Refresh access', load)]
          : [requestAccess]
        return [heading('Restricted document'), details(entries), ...controls, region]
      }
      const status = { ready: 'Ready', failed: doc.ocr_error || 'OCR failed', not_queued: 'Awaiting backfill' }
      entries.push(['File', doc.filename], ['Searchable text', status[doc.ocr_status] || 'Processing'], ...Object.entries(doc.metadata))
      const download = button('Download', async () => {
        download.disabled = true
        try {
          const blob = await api(path + '/download', { session, binary: true, signal })
          const url = URL.createObjectURL(blob)
          const anchor = el('a', { href: url, download: doc.filename })
          document.body.append(anchor)
          anchor.click()
          anchor.remove()
          setTimeout(() => URL.revokeObjectURL(url), 1000)
        } catch (error) {
          feedback(region, error.message, true)
        } finally {
          download.disabled = false
        }
      }, { class: 'primary-button' })
      const share = button('Copy document link', async () => {
        try {
          await navigator.clipboard.writeText(window.location.href)
          feedback(region, 'Document link copied.')
        } catch {
          feedback(region, 'Copy the URL from the address bar to share this document.')
        }
      })
      const refresh = ['pending', 'processing'].includes(doc.ocr_status) ? button('Refresh OCR status', load) : null
      return [heading(doc.title), details(entries), download, el('div', { class: 'action-row' }, share, refresh), region]
    })
  }
  return load()
}

function inbox(root, session, signal) {
  const actions = el('div', { class: 'action-row' })
  const region = el('div')
  const results = el('div')
  let direction = 'incoming'
  let requestVersion = 0
  root.append(actions, region, results)
  const directions = [['incoming', 'Incoming'], ['outgoing', 'Sent']]
  const controls = directions.map(([value, title]) => button(title, () => {
    direction = value
    feedback(region, '')
    load()
  }))
  actions.append(...controls)

  async function load(page = 1) {
    const mode = direction
    const version = ++requestVersion
    controls.forEach((control, index) => control.setAttribute('aria-pressed', String(directions[index][0] === mode)))
    results.replaceChildren(el('p', { role: 'status' }, 'Loading…'))
    try {
      const result = await api('/access/requests?' + new URLSearchParams({ direction: mode, page }), { session, signal })
      if (signal.aborted || version !== requestVersion) return
      const list = result.requests.length ? el('ul', { class: 'document-list request-list' }, result.requests.map((entry) => {
        const row = el('li', {}, el('div', {}, documentLink(entry.doc_id, entry.title || 'Document ' + entry.doc_id),
          el('p', {}, (entry.requester || entry.division) + ' · ' + entry.status),
          entry.requester_division ? el('p', {}, entry.requester_division) : null))
        if (mode === 'incoming' && entry.status === 'pending') {
          const decision = el('div', { class: 'action-row' })
          for (const [action, label] of [['approve', 'Approve'], ['reject', 'Reject']]) {
            decision.append(button(label, async () => {
              decision.querySelectorAll('button').forEach((item) => { item.disabled = true })
              feedback(region, '')
              try {
                await api('/access/' + action, { session, method: 'POST', body: { request_id: entry.request_id }, signal })
              } catch (error) {
                feedback(region, error.message, true)
              }
              if (mode === direction && version === requestVersion) await load(page)
            }))
          }
          row.append(decision)
        }
        return row
      })) : el('p', {}, 'No ' + (mode === 'incoming' ? 'incoming' : 'sent') + ' requests.')
      results.replaceChildren(list)
      const navigation = paging(result, load)
      if (navigation) results.append(navigation)
    } catch (error) {
      if (!signal.aborted && version === requestVersion) feedback(results, error.message, true)
    }
  }
  return load()
}

export const pagePaths = {
  documents: '/documents.html',
  document: '/document.html',
  upload: '/upload.html',
  requests: '/requests.html',
  search: '/search.html',
  settings: '/settings.html',
}

export function documentUrl(id) {
  return pagePaths.document + '?' + new URLSearchParams({ id })
}

export async function workspace(page, root, session, query) {
  const routes = {
    documents: ['Documents', hub],
    upload: ['Upload', upload],
    requests: ['Requests', inbox],
    search: ['Search', search],
  }
  if (session.user.role === 'admin') routes.settings = ['Settings',
    (content, account, signal) => settings(account, content, signal)]

  document.querySelector('#workspace-nav').replaceChildren(...Object.entries(routes).map(([key, [name]]) =>
    el('a', { href: pagePaths[key], 'aria-current': page === key || (page === 'document' && key === 'documents')
      ? 'page' : null }, name)))

  const controller = new AbortController()
  window.addEventListener('pagehide', () => controller.abort(), { once: true })
  const { signal } = controller
  root.replaceChildren()
  try {
    if (page === 'document') {
      const id = query.get('id')
      if (!/^[a-f0-9]{24}$/i.test(id || '')) throw new Error('This document link is invalid.')
      await showDetails(root, session, id, signal)
    } else if (Object.hasOwn(routes, page)) {
      await routes[page][1](root, session, signal)
    } else {
      throw new Error('Metadata settings require an administrator.')
    }
  } catch (error) {
    if (!signal.aborted) feedback(root, error.message, true)
  }
}
