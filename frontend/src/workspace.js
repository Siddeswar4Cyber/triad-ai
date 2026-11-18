import { api } from './api.js?v=cleanup'
import {
  element as el,
  button,
  textInput,
  selectInput,
  formWith,
  details,
  feedback,
} from './dom.js?v=cleanup'
import { adminWorkspace } from './admin.js?v=metadata-ui'

const maxFileBytes = 10 * 1024 * 1024

function heading(title) {
  return el('h3', { tabindex: -1 }, title)
}

function documentLink(docId, title, admin = false) {
  return el('a', { href: documentUrl(docId, admin) }, title)
}

function paging({ page, has_more }, load) {
  if (page === 1 && !has_more) return null
  return el(
    'div',
    { class: 'action-row', 'aria-label': 'Pagination' },
    button('Previous', () => load(page - 1), { disabled: page === 1 }),
    el('span', {}, 'Page ' + page),
    button('Next', () => load(page + 1), { disabled: !has_more })
  )
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

function metadataInputs(fields, prefix, filtering = false) {
  return fields.map((field) => {
    const id = prefix + '-' + field.key
    const label = filtering
      ? 'Filter by ' + field.label
      : field.label + (!field.required ? ' (optional)' : '')
    const attrs = { name: field.key, required: !filtering && field.required }
    if (prefix === 'upload' && field.key === 'report_type' && field.type === 'select') {
      const choices = el(
        'datalist',
        { id: id + '-choices' },
        field.options.map((option) => el('option', { value: option.label }))
      )
      return el(
        'div',
        { class: 'option-editor' },
        el('label', { for: id }, label),
        el('input', {
          id,
          ...attrs,
          list: choices.id,
          maxlength: 80,
          autocomplete: 'off',
          placeholder: 'Search or enter a new report type',
          'aria-describedby': id + '-help',
        }),
        choices,
        el(
          'p',
          { id: id + '-help', class: 'field-help' },
          'Choose an existing type or enter a new one. New types are added when you upload.'
        )
      )
    }
    if (field.type === 'select') {
      return selectInput(
        id,
        label,
        [
          ['', filtering ? 'Any' : 'Select a choice'],
          ...field.options.map((option) => [option.id, option.label]),
        ],
        '',
        attrs
      )
    }
    return textInput(id, label, { ...attrs, maxlength: 500 })
  })
}

function hubDocument(doc, actions, openPreview) {
  const format = doc.content_type.split('/').at(-1).replace('jpeg', 'jpg').toUpperCase()
  const size =
    doc.size >= 1024 * 1024
      ? (doc.size / (1024 * 1024)).toFixed(1) + ' MB'
      : Math.max(1, Math.round(doc.size / 1024)) + ' KB'
  const date = new Date(doc.created_at)
  const dateLabel = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)
  const status = {
    ready: 'Searchable',
    pending: 'Queued',
    processing: 'Processing',
    failed: 'OCR failed',
    not_queued: 'Awaiting OCR',
  }
  const metadata = Object.entries(doc.metadata).slice(0, 2)
  return el(
    'li',
    { class: 'hub-file-row' },
    el(
      'div',
      { class: 'hub-file-name' },
      el('span', { class: 'hub-file-icon', 'aria-hidden': 'true' }, format),
      el(
        'div',
        {},
        button(doc.title, openPreview, { class: 'document-title-button', 'aria-haspopup': 'dialog' }),
        el('p', { class: 'hub-file-subtitle' }, format + ' · ' + size),
        el('p', { class: 'hub-file-subtitle' }, 'Division: ' + doc.division),
        metadata.length
          ? el(
              'p',
              { class: 'hub-file-subtitle' },
              metadata.map(([label, value]) => label + ': ' + value).join(' · ')
            )
          : null
      )
    ),
    el('time', { datetime: doc.created_at, class: 'hub-file-date' }, dateLabel),
    el(
      'span',
      { class: 'hub-file-status', 'data-status': doc.ocr_status },
      status[doc.ocr_status] || 'Awaiting OCR'
    ),
    actions
  )
}

async function hub(root, session, signal) {
  const region = el('div')
  const filterPanel = el('section', { class: 'hub-filters', 'aria-labelledby': 'hub-filter-title' })
  const resultPanel = el('section', { class: 'hub-results', 'aria-labelledby': 'hub-results-title' })
  const results = el('div', { class: 'hub-result-list', 'aria-busy': 'true' })
  const summary = el('p', { class: 'hub-result-summary', role: 'status' })
  let filters = []
  let revision = 0

  const filterTitle = el('h2', { id: 'hub-filter-title' }, 'Filters')
  filterPanel.append(filterTitle, el('p', { role: 'status' }, 'Loading filters…'))
  resultPanel.append(
    el('div', { class: 'hub-results-heading' }, el('h2', { id: 'hub-results-title' }, 'Documents'), summary),
    results
  )

  root.append(
    el(
      'header',
      { class: 'hub-banner' },
      el(
        'div',
        {},
        el('h2', {}, session.user.division + ' library'),
        el('p', {}, 'Browse files in your division or search their extracted text.')
      ),
      el(
        'div',
        { class: 'hub-banner-actions' },
        el('a', { href: pagePaths.search, class: 'hub-secondary' }, 'Advanced search'),
        el(
          'a',
          { href: pagePaths.upload, class: 'hub-primary' },
          el('span', { 'aria-hidden': 'true' }, '+'),
          'Upload Document'
        )
      )
    ),
    el('div', { class: 'hub-layout' }, filterPanel, resultPanel)
  )

  async function load(page = 1) {
    const current = ++revision
    const params = new URLSearchParams(filters)
    params.set('page', page)
    summary.textContent = 'Loading documents…'
    results.setAttribute('aria-busy', 'true')
    results.replaceChildren()
    try {
      const result = await api('/documents?' + params, { session, signal })
      if (signal.aborted || current !== revision) return
      const count = result.documents.length
      summary.textContent = count + (count === 1 ? ' document on this page' : ' documents on this page')
      if (count) {
        results.append(userDocumentList(result.documents, session, signal))
      } else {
        results.append(
          el(
            'div',
            { class: 'hub-empty' },
            el('h3', {}, filters.length ? 'No matching documents' : 'No documents here yet'),
            el(
              'p',
              {},
              filters.length
                ? 'Clear or change your filters to see more files.'
                : 'Upload a PDF or image to start your division library.'
            )
          )
        )
      }
      const navigation = paging(result, load)
      if (navigation) results.append(navigation)
    } catch (error) {
      if (signal.aborted || current !== revision) return
      summary.textContent = ''
      feedback(results, error.message, true)
      results.append(button('Retry loading documents', () => load(page)))
    } finally {
      if (current === revision) results.setAttribute('aria-busy', 'false')
    }
  }

  async function loadFilters() {
    filterPanel.replaceChildren(filterTitle, el('p', { role: 'status' }, 'Loading filters…'))
    try {
      const [{ fields }, { divisions }] = await Promise.all([
        api('/metadata-fields', { session, signal }),
        api('/auth/divisions', { session, signal }),
      ])
      if (signal.aborted) return
      const division = selectInput(
        'filter-division',
        'Filter by Division',
        [
          ['', 'My division'],
          ...divisions.map(({ id, name }) => [id, name]),
          ...(!divisions.some(({ id }) => id === session.user.division_id)
            ? [[session.user.division_id, session.user.division]]
            : []),
        ],
        '',
        { name: 'Division' }
      )
      const form = formWith(
        [division, ...metadataInputs(fields, 'filter', true)],
        'Apply filters',
        region,
        (data) => {
          filters = [...data].filter(([, value]) => value)
          return load()
        }
      )
      form.append(
        button('Clear filters', () => {
          form.reset()
          filters = []
          load()
        })
      )
      filterPanel.replaceChildren(filterTitle, form, region)
    } catch (error) {
      if (signal.aborted) return
      feedback(region, error.message, true)
      filterPanel.replaceChildren(filterTitle, region, button('Retry loading filters', loadFilters))
    }
  }

  await Promise.all([load(), loadFilters()])
}

const searchScopes = [
  ['all', 'All fields'],
  ['title', 'Titles only'],
  ['metadata', 'Metadata only'],
  ['text', 'Extracted text only'],
]

function searchUrl(query, scope, page) {
  return pagePaths.search + '?' + new URLSearchParams({ q: query, scope, page })
}

function search(root, session, signal) {
  const params = new URLSearchParams(location.search)
  const query = (params.get('q') || '').trim()
  const scope = params.get('scope') || 'all'
  const selectedScope = searchScopes.some(([value]) => value === scope) ? scope : 'all'
  const term = textInput('search-query', 'Search documents', {
    name: 'q',
    type: 'search',
    maxlength: 100,
    required: true,
    value: query,
    placeholder: 'Enter a title, metadata value, or phrase…',
  })
  const input = term.querySelector('input')
  input.addEventListener('input', () => input.setCustomValidity(''))
  const scopeInput = selectInput('search-scope', 'Search in', searchScopes, selectedScope, { name: 'scope' })
  const form = el(
    'form',
    { action: pagePaths.search, method: 'get', class: 'search-form', role: 'search' },
    term,
    scopeInput,
    button('Search')
  )
  form.addEventListener('submit', (event) => {
    input.value = input.value.trim()
    if (!input.value) {
      event.preventDefault()
      input.setCustomValidity('Enter a search term.')
      input.reportValidity()
    }
  })

  const results = el('div', { class: 'search-results' })
  root.append(
    el(
      'section',
      { class: 'search-banner', 'aria-labelledby': 'search-banner-title' },
      el(
        'div',
        { class: 'search-banner-heading' },
        el(
          'div',
          {},
          el('h2', { id: 'search-banner-title' }, 'Search documents you can access'),
          el(
            'p',
            {},
            'Search titles, metadata, and extracted text in your division and documents approved for you.'
          )
        ),
        el('span', { class: 'search-division' }, session.user.division + ' + approved access')
      ),
      form
    ),
    results
  )

  function emptyState(title, description) {
    return el('div', { class: 'search-empty' }, el('h3', {}, title), el('p', {}, description))
  }

  if (!query) {
    results.append(
      emptyState(
        'Search your document library',
        'Try a report title, a metadata value, or a phrase from an uploaded file.'
      )
    )
    return
  }

  async function runSearch() {
    results.replaceChildren(el('p', { role: 'status' }, 'Searching documents…'))
    results.setAttribute('aria-busy', 'true')
    try {
      const request = new URLSearchParams({ q: query, scope, page: params.get('page') ?? '1' })
      const result = await api('/search?' + request, { session, signal })
      if (signal.aborted) return
      const count = result.documents.length
      const summary = count + (count === 1 ? ' match' : ' matches') + ' on this page for “' + query + '”'
      results.replaceChildren(
        el(
          'div',
          { class: 'search-results-heading' },
          el(
            'div',
            {},
            el('h2', {}, 'Search results'),
            el('p', { class: 'field-help', role: 'status' }, summary)
          ),
          el('a', { href: pagePaths.search }, 'Clear search')
        )
      )

      if (count) {
        results.append(userDocumentList(result.documents, session, signal))
      } else {
        results.append(
          emptyState(
            'No matching documents',
            'Try a shorter phrase or choose All fields. Scanned text becomes searchable after OCR finishes.'
          )
        )
      }
      if (result.page > 1 || result.has_more) {
        results.append(
          el(
            'nav',
            { class: 'search-pagination', 'aria-label': 'Search result pages' },
            result.page > 1 ? el('a', { href: searchUrl(query, scope, result.page - 1) }, 'Previous') : null,
            el('span', {}, 'Page ' + result.page),
            result.has_more ? el('a', { href: searchUrl(query, scope, result.page + 1) }, 'Next') : null
          )
        )
      }
    } catch (error) {
      if (signal.aborted) return
      feedback(results, error.message, true)
      results.append(button('Retry search', runSearch))
    } finally {
      if (!signal.aborted) results.setAttribute('aria-busy', 'false')
    }
  }

  return runSearch()
}

const uploadExtensions = /\.(pdf|png|jpe?g|tiff?|webp)$/i

function uploadFileError(file) {
  if (!file.size) return 'This file is empty. Choose a different file.'
  if (file.size > maxFileBytes) return 'This file exceeds 10 MiB. Choose a smaller file.'
  if (!uploadExtensions.test(file.name)) return 'Choose a PDF, PNG, JPEG, TIFF, or WebP file.'
  return ''
}

async function upload(root, session, signal) {
  root.replaceChildren(el('p', { role: 'status' }, 'Loading upload form…'))
  let fields
  try {
    const response = await api('/metadata-fields', { session, signal })
    fields = response.fields
  } catch (error) {
    if (!signal.aborted) {
      feedback(root, error.message, true)
      root.append(button('Retry loading form', () => upload(root, session, signal)))
    }
    return
  }
  if (signal.aborted) return

  const region = el('div', { class: 'upload-result' })
  const fileFeedback = el('div')
  const selection = el('div', { class: 'upload-selection', 'aria-live': 'polite' })
  const fileInput = el('input', {
    id: 'upload-file',
    name: 'file',
    type: 'file',
    required: true,
    class: 'upload-file-input',
    accept: '.pdf,.png,.jpg,.jpeg,.tif,.tiff,.webp',
    'aria-labelledby': 'upload-choose',
    'aria-describedby': 'upload-help',
  })
  const dropZone = el(
    'label',
    { class: 'upload-drop', for: fileInput.id },
    fileInput,
    el('span', { class: 'upload-drop-icon', 'aria-hidden': 'true' }, '↑'),
    el('strong', { id: 'upload-choose' }, 'Choose a file'),
    el('span', { class: 'upload-drop-hint' }, 'or drag and drop it here')
  )

  function showSelection(file) {
    selection.replaceChildren()
    if (!file) return
    const size =
      file.size >= 1024 * 1024
        ? (file.size / (1024 * 1024)).toFixed(1) + ' MiB'
        : Math.max(1, Math.round(file.size / 1024)) + ' KiB'
    const remove = button('Remove file', () => {
      fileInput.value = ''
      showSelection(null)
      fileInput.focus()
    })
    selection.append(
      el(
        'div',
        { class: 'upload-selected-file' },
        el('div', {}, el('strong', {}, file.name), el('p', { class: 'field-help' }, size)),
        remove
      )
    )
  }

  function checkSelection(files, fromDrop = false) {
    feedback(fileFeedback, '')
    if (!files.length) {
      if (!fromDrop) showSelection(null)
      return
    }
    const file = files[0]
    const error = files.length !== 1 ? 'Choose one file at a time.' : uploadFileError(file)
    if (error) {
      if (!fromDrop) fileInput.value = ''
      showSelection(fileInput.files[0])
      feedback(fileFeedback, error, true)
      return
    }
    if (fromDrop) fileInput.files = files
    showSelection(file)
  }
  fileInput.addEventListener('change', () => checkSelection(fileInput.files))

  // Only file drags are handled here. Ordinary drag interactions still work.
  dropZone.addEventListener('dragover', (event) => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    if (!form.hasAttribute('aria-busy')) dropZone.classList.add('is-dragging')
  })
  dropZone.addEventListener('dragleave', (event) => {
    if (!dropZone.contains(event.relatedTarget)) dropZone.classList.remove('is-dragging')
  })
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault()
    dropZone.classList.remove('is-dragging')
    if (!form.hasAttribute('aria-busy')) checkSelection(event.dataTransfer.files, true)
  })

  const filePanel = el(
    'section',
    { class: 'upload-card upload-file-card', 'aria-labelledby': 'upload-file-title' },
    el('h2', { id: 'upload-file-title' }, 'File'),
    dropZone,
    el('p', { id: 'upload-help', class: 'field-help' }, 'PDF, PNG, JPEG, TIFF, or WebP. Up to 10 MiB.'),
    fileFeedback,
    selection
  )
  const documentPanel = el(
    'section',
    { class: 'upload-card upload-metadata-card', 'aria-labelledby': 'upload-metadata-title' },
    el('h2', { id: 'upload-metadata-title' }, 'Document details'),
    details([['Destination division', session.user.division]]),
    el('p', { class: 'field-help' }, 'Your account’s division determines where this document is stored.'),
    fields.length ? el('div', { class: 'upload-metadata-fields' }, metadataInputs(fields, 'upload')) : null
  )

  const form = formWith([filePanel, documentPanel], 'Upload document', region, async (data) => {
    const attachment = data.get('file')
    const error = uploadFileError(attachment)
    if (error) throw new Error(error)
    const submitButton = form.querySelector('button[type=submit]')
    submitButton.textContent = 'Uploading…'
    try {
      const multipart = new FormData()
      multipart.set('file', attachment)
      const metadata = Object.fromEntries(
        fields.map(({ key }) => [key, data.get(key).trim()]).filter(([, value]) => value)
      )
      const reportField = fields.find(({ key, type }) => key === 'report_type' && type === 'select')
      if (reportField && metadata.report_type) {
        const { option } = await api('/metadata-fields/report_type/options', {
          session,
          signal,
          method: 'POST',
          body: { label: metadata.report_type },
        })
        metadata.report_type = option.id
        if (!reportField.options.some(({ id }) => id === option.id)) {
          reportField.options.push(option)
          form.querySelector('#upload-report_type-choices').append(el('option', { value: option.label }))
        }
      }
      multipart.set('metadata', JSON.stringify(metadata))
      const result = await api('/documents/upload', { session, method: 'POST', body: multipart, signal })
      form.reset()
      showSelection(null)
      feedback(fileFeedback, '')
      feedback(region, result.filename + ' was uploaded to ' + session.user.division + '.')
      region.append(documentLink(result.doc_id, 'View uploaded document'))
    } finally {
      submitButton.textContent = 'Upload document'
    }
  })
  form.classList.add('upload-form')
  root.replaceChildren(form, region)
}

function userDocumentList(documents, session, signal) {
  return el(
    'div',
    { class: 'user-document-list' },
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
      documents.map((doc) => {
        const path = '/documents/' + doc.doc_id
        const notice = el('div')
        const [view, dialog] = filePreview(doc, path, session, signal, 'View')
        const actions = el(
          'div',
          { class: 'document-actions', role: 'group', 'aria-label': 'Actions for ' + doc.title },
          view,
          dialog,
          downloadButton(doc, path, session, signal, notice),
          notice
        )
        return hubDocument(doc, actions, () => view.click())
      })
    )
  )
}

function filePreview(doc, path, session, signal, label = 'Preview file') {
  const paged = ['application/pdf', 'image/tiff'].includes(doc.content_type)
  const pages = el('div', { class: 'document-preview-pages' })
  const status = el('div')
  const body = el(
    'div',
    { class: 'document-preview-body', tabindex: 0, role: 'region', 'aria-label': 'Document pages' },
    pages,
    status
  )
  const title = el('h2', { id: 'preview-title-' + doc.doc_id }, doc.title)
  const dialog = el('dialog', { class: 'document-preview', 'aria-labelledby': title.id })
  const close = button('Close preview', () => dialog.close(), { autofocus: true })
  const shareNotice = el('div', { class: 'document-preview-share-notice' })
  const shareUrl = new URL(documentUrl(doc.doc_id), location.origin).href
  const copy = button('Copy link', async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      feedback(shareNotice, 'Document link copied.')
    } catch {
      const link = el('input', {
        type: 'url',
        value: shareUrl,
        readonly: true,
        'aria-label': 'Document link',
      })
      shareNotice.replaceChildren(el('p', {}, 'Copy this document link.'), link)
      link.focus()
      link.select()
    }
  })
  const urls = new Set()
  let request
  const open = button(
    label,
    () => {
      clear()
      shareNotice.replaceChildren()
      dialog.showModal()
      signal.addEventListener('abort', clear, { once: true })
      body.scrollTop = 0
      request = new AbortController()
      loadPreview()
    },
    { class: 'primary-button' }
  )

  function clear() {
    request?.abort()
    pages.replaceChildren()
    status.replaceChildren()
    for (const url of urls) URL.revokeObjectURL(url)
    urls.clear()
  }

  async function loadPreview(frame = 0) {
    const previewSignal = AbortSignal.any([signal, request.signal])
    status.replaceChildren(el('p', { role: 'status' }, 'Loading document preview…'))
    try {
      while (!previewSignal.aborted) {
        const response = await api(path + '/preview' + (paged ? '?frame=' + frame : ''), {
          session,
          binary: 'response',
          signal: previewSignal,
        })
        const blob = await response.blob()
        if (previewSignal.aborted) return
        const url = URL.createObjectURL(blob)
        urls.add(url)
        pages.append(el('img', { src: url, alt: paged ? doc.title + ', page ' + (frame + 1) : doc.title }))
        if (!paged || response.headers.get('X-Preview-Has-Next') !== 'true') break
        frame += 1
      }
      if (previewSignal.aborted) return
      status.replaceChildren()
    } catch (error) {
      if (previewSignal.aborted) return
      feedback(status, error.message, true)
      status.append(button('Retry preview', () => loadPreview(frame)))
    }
  }

  dialog.append(
    el(
      'header',
      { class: 'document-preview-heading' },
      title,
      el('div', { class: 'document-preview-tools' }, copy, close),
      shareNotice
    ),
    body
  )
  dialog.addEventListener('close', () => {
    if (dialog.open) return
    signal.removeEventListener('abort', clear)
    clear()
  })
  return [open, dialog]
}

function downloadButton(doc, path, session, signal, region) {
  const download = button(
    'Download',
    async () => {
      download.disabled = true
      feedback(region, '')
      try {
        const blob = await api(path + '/download', { session, binary: true, signal })
        const url = URL.createObjectURL(blob)
        const anchor = el('a', { href: url, download: doc.filename })
        document.body.append(anchor)
        anchor.click()
        anchor.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      } catch (error) {
        if (!signal.aborted) feedback(region, error.message, true)
      } finally {
        download.disabled = false
      }
    },
    { class: 'primary-button' }
  )
  return download
}

function showDetails(root, session, id, signal) {
  if (!/^[a-f0-9]{24}$/i.test(id || '')) throw new Error('This document link is invalid.')
  const path = '/documents/' + id
  async function load() {
    await replaceResults(root, signal, async () => {
      const { document: doc } = await api(path, { session, signal })
      const region = el('div')
      const entries = [['Division', doc.division]]
      const isAdmin = session.user.role === 'admin'
      function accessControls() {
        const requestAccess = button(
          'Request access',
          async () => {
            requestAccess.disabled = true
            try {
              await api('/access/request', { session, method: 'POST', body: { doc_id: id }, signal })
              await load()
            } catch (error) {
              feedback(region, error.message, true)
            } finally {
              requestAccess.disabled = false
            }
          },
          { class: 'primary-button' }
        )
        const controls = doc.request_status
          ? [
              el('p', { role: 'status' }, 'Access request: ' + doc.request_status + '.'),
              button('Refresh access', load),
            ]
          : [requestAccess]
        return controls
      }
      if (!Object.hasOwn(doc, 'title')) {
        return [heading('Restricted document'), details(entries), ...accessControls(), region]
      }
      const status = {
        ready: 'Ready',
        failed: doc.ocr_error || 'OCR failed',
        not_queued: 'Awaiting backfill',
      }
      entries.push(
        ['File', doc.filename],
        ['Searchable text', status[doc.ocr_status] || 'Processing'],
        ...Object.entries(doc.metadata)
      )
      const shareUrl = new URL(documentUrl(id), location.origin).href
      const share = button('Copy document link', async () => {
        try {
          await navigator.clipboard.writeText(shareUrl)
          feedback(region, 'Document link copied.')
        } catch {
          feedback(region, 'Share this document using ' + shareUrl)
        }
      })
      const refresh = ['pending', 'processing'].includes(doc.ocr_status)
        ? button('Refresh OCR status', load)
        : null
      return [
        heading(doc.title),
        details(entries),
        ...(isAdmin ? filePreview(doc, path, session, signal) : []),
        ...(doc.can_download ? [downloadButton(doc, path, session, signal, region)] : accessControls()),
        el('div', { class: 'action-row' }, share, refresh),
        region,
      ]
    })
  }
  return load()
}

const requestStatuses = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected' }
const requestDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

function requestTime(label, timestamp) {
  return el(
    'div',
    {},
    el('dt', {}, label),
    el('dd', {}, el('time', { datetime: timestamp }, requestDate.format(new Date(timestamp))))
  )
}

function inbox(root, session, signal, divisions = null) {
  const acrossDivisions = divisions !== null
  const directions = acrossDivisions
    ? [['incoming', 'Incoming']]
    : [
        ['incoming', 'Incoming'],
        ['outgoing', 'Sent'],
      ]
  const region = el('div', { class: 'requests-feedback' })
  const results = el('div', { class: 'requests-results' })
  const summary = el('p', { class: 'field-help', role: 'status' })
  const modeDescription = el('p', { class: 'field-help' })
  const title = el(
    acrossDivisions ? 'h3' : 'h2',
    {},
    acrossDivisions ? 'Request results' : 'Incoming requests'
  )
  let direction = 'incoming'
  let requestVersion = 0

  const controls = directions.map(([value, label]) =>
    button(label, () => {
      if (value === direction) return
      direction = value
      feedback(region, '')
      load()
    })
  )
  const modes = el(
    'div',
    { class: 'requests-modes', role: 'group', 'aria-label': 'Request direction' },
    controls
  )
  const filter = el('select', { id: 'request-status' }, [
    el('option', { value: '' }, 'All statuses'),
    ...Object.entries(requestStatuses).map(([value, label]) => el('option', { value }, label)),
  ])
  filter.addEventListener('change', () => {
    feedback(region, '')
    load()
  })
  const division = acrossDivisions
    ? selectInput('request-division', 'Owning division', [
        ['', 'All divisions'],
        ...divisions.map(({ id, name, active }) => [id, name + (active ? '' : ' (inactive)')]),
      ])
    : null
  const divisionControl = division?.querySelector('select')
  divisionControl?.addEventListener('change', () => {
    feedback(region, '')
    load()
  })
  const toolbar = el(
    'div',
    { class: 'requests-toolbar' },
    acrossDivisions ? division : modes,
    el('div', { class: 'requests-filter' }, el('label', { for: filter.id }, 'Status'), filter)
  )

  const dialogTitle = el('h2', { id: 'request-dialog-title' })
  const dialogDescription = el('p', { id: 'request-dialog-description' })
  const dialogError = el('div')
  const dialogActions = el('div', { class: 'requests-dialog-actions' })
  const dialog = el(
    'dialog',
    { class: 'requests-dialog', 'aria-labelledby': dialogTitle.id, 'aria-describedby': dialogDescription.id },
    dialogTitle,
    dialogDescription,
    dialogError,
    dialogActions
  )
  let deciding = false
  dialog.addEventListener('cancel', (event) => {
    if (deciding) event.preventDefault()
  })
  if (!acrossDivisions) {
    root.append(
      el(
        'header',
        { class: 'requests-banner' },
        el(
          'div',
          {},
          el('h2', {}, session.user.division + ' access desk'),
          el('p', {}, 'Review requests for your division or track access you’ve requested.')
        ),
        el('a', { class: 'requests-banner-link', href: pagePaths.documents }, 'Back to documents')
      )
    )
  }
  root.append(
    el(
      'section',
      { class: 'requests-card', 'aria-label': 'Request inbox' },
      toolbar,
      el('div', { class: 'requests-intro' }, title, modeDescription, summary),
      region,
      results
    ),
    dialog
  )

  function confirmDecision(action, entry, page) {
    const approve = action === 'approve'
    const label = approve ? 'Approve' : 'Reject'
    dialogTitle.textContent = label + ' access request?'
    dialogDescription.textContent = approve
      ? 'This will allow ' + entry.requester + ' to download “' + entry.title + '”.'
      : 'This will deny ' + entry.requester + ' access to “' + entry.title + '”.'
    feedback(dialogError, '')

    const cancel = button('Cancel', () => dialog.close(), { autofocus: true, class: 'requests-neutral' })
    const confirm = button(
      label + ' request',
      async () => {
        deciding = true
        cancel.disabled = confirm.disabled = true
        feedback(dialogError, '')
        try {
          await api('/access/' + action, {
            session,
            method: 'POST',
            body: { request_id: entry.request_id },
            signal,
          })
          dialog.close()
          feedback(region, 'Request ' + (approve ? 'approved.' : 'rejected.'))
          await load(page)
          title.focus()
        } catch (error) {
          if (!signal.aborted) feedback(dialogError, error.message, true)
        } finally {
          deciding = false
          cancel.disabled = confirm.disabled = false
        }
      },
      { class: approve ? 'requests-approve' : 'requests-reject' }
    )
    dialogActions.replaceChildren(cancel, confirm)
    dialog.showModal()
  }

  function renderRow(entry, mode, page) {
    const incoming = mode === 'incoming'
    const name = entry.title || 'Document ' + entry.doc_id.slice(-8)
    const contact = incoming ? entry.requester : entry.division
    const context = incoming ? entry.requester_division : null
    const caption = incoming ? 'Requested by' : 'Owning division'
    const badge = el(
      'span',
      { class: 'requests-status', 'data-status': entry.status },
      requestStatuses[entry.status]
    )
    const actions =
      incoming && entry.status === 'pending'
        ? el(
            'div',
            { class: 'requests-row-actions' },
            button('Approve', () => confirmDecision('approve', entry, page), { class: 'requests-approve' }),
            button('Reject', () => confirmDecision('reject', entry, page), { class: 'requests-neutral' })
          )
        : null

    return el(
      'li',
      { class: 'requests-row' },
      el('div', { class: 'requests-row-heading' }, documentLink(entry.doc_id, name, acrossDivisions), badge),
      el(
        'p',
        { class: 'requests-contact' },
        el('span', {}, caption + ' '),
        contact,
        context ? el('span', {}, ' · ' + context) : null
      ),
      acrossDivisions
        ? el('p', { class: 'requests-contact' }, el('span', {}, 'Owning division '), entry.division)
        : null,
      el(
        'dl',
        { class: 'requests-dates' },
        requestTime('Requested', entry.created_at),
        entry.decided_at ? requestTime('Decided', entry.decided_at) : null
      ),
      actions
    )
  }

  async function load(page = 1) {
    const mode = direction
    const status = filter.value
    const version = ++requestVersion
    controls.forEach((control, index) =>
      control.setAttribute('aria-pressed', String(directions[index][0] === mode))
    )
    if (!acrossDivisions) title.textContent = mode === 'incoming' ? 'Incoming requests' : 'Sent requests'
    title.tabIndex = -1
    modeDescription.textContent = acrossDivisions
      ? 'Requests for documents across all divisions.'
      : mode === 'incoming'
        ? 'Requests from other divisions for documents in your division.'
        : 'Requests you’ve made for documents owned by other divisions.'
    summary.textContent = 'Loading requests…'
    results.setAttribute('aria-busy', 'true')
    results.replaceChildren()
    try {
      const query = new URLSearchParams({ direction: mode, page })
      if (status) query.set('status', status)
      if (divisionControl?.value) query.set('division_id', divisionControl.value)
      const result = await api((acrossDivisions ? '/admin/requests?' : '/access/requests?') + query, {
        session,
        signal,
      })
      if (signal.aborted || version !== requestVersion) return
      if (page > 1 && !result.requests.length) return load(page - 1)
      const count = result.requests.length
      summary.textContent = count + (count === 1 ? ' request on this page' : ' requests on this page')
      if (count)
        results.append(
          el(
            'ul',
            { class: 'requests-list' },
            result.requests.map((entry) => renderRow(entry, mode, page))
          )
        )
      else
        results.append(
          el(
            'div',
            { class: 'requests-empty' },
            el(
              'h3',
              {},
              status
                ? 'No matching requests'
                : mode === 'incoming'
                  ? 'No incoming requests'
                  : 'No sent requests'
            ),
            el(
              'p',
              {},
              status
                ? 'Choose a different status to see more requests.'
                : mode === 'incoming'
                  ? acrossDivisions
                    ? 'Requests across divisions will appear here.'
                    : 'Requests for documents in your division will appear here.'
                  : 'Requests you send from a restricted document’s details page will appear here.'
            )
          )
        )
      const navigation = paging(result, load)
      if (navigation) results.append(navigation)
    } catch (error) {
      if (signal.aborted || version !== requestVersion) return
      summary.textContent = ''
      feedback(results, error.message, true)
      results.append(button('Retry loading requests', () => load(page)))
    } finally {
      if (version === requestVersion) results.setAttribute('aria-busy', 'false')
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
  admin: '/admin.html',
}

export function documentUrl(id, admin = false) {
  return admin
    ? pagePaths.admin + '?' + new URLSearchParams({ view: 'documents', id })
    : pagePaths.document + '?' + new URLSearchParams({ id })
}

export function workspaceDestination(destination, user) {
  if (user.role !== 'admin') return destination
  const url = new URL(destination, location.origin)
  if (url.pathname === pagePaths.admin) return url.pathname + url.search
  if (url.pathname === pagePaths.document) return documentUrl(url.searchParams.get('id') || '', true)
  if (url.pathname === pagePaths.requests) return pagePaths.admin + '?view=requests'
  if (url.pathname === pagePaths.search || url.pathname === pagePaths.documents) {
    url.searchParams.set('view', 'documents')
    return pagePaths.admin + '?' + url.searchParams
  }
  return pagePaths.admin
}

export async function workspace(page, root, session, query) {
  const routes = {
    documents: ['Documents', hub],
    upload: ['Upload', upload],
    requests: ['Requests', inbox],
    search: ['Search', search],
  }
  document.querySelector('#workspace-nav')?.replaceChildren(
    ...Object.entries(routes).map(([key, [name]]) =>
      el(
        'a',
        {
          href: pagePaths[key],
          'aria-current': page === key || (page === 'document' && key === 'documents') ? 'page' : null,
        },
        name
      )
    )
  )

  const controller = new AbortController()
  window.addEventListener('pagehide', () => controller.abort(), { once: true })
  const { signal } = controller
  root.replaceChildren()
  try {
    if (page === 'admin' && session.user.role === 'admin') {
      await adminWorkspace(root, session, signal, {
        renderDocument: hubDocument,
        paging,
        showRequests: inbox,
        showDocument: showDetails,
        searchScopes,
        filePreview,
        downloadButton,
      })
    } else if (page === 'document') {
      await showDetails(root, session, query.get('id'), signal)
    } else if (Object.hasOwn(routes, page)) {
      await routes[page][1](root, session, signal)
    } else {
      throw new Error('This page requires an administrator.')
    }
  } catch (error) {
    if (!signal.aborted) feedback(root, error.message, true)
  }
}
