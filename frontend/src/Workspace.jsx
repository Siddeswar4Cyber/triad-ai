import { useEffect, useState } from 'react'
import { api } from './api.js'
import Settings from './Settings.jsx'
import Inbox from './Inbox.jsx'
import UploadPanel from './UploadPanel.jsx'

function useResource(session, path, revision) {
  const [state, setState] = useState({})
  useEffect(() => {
    if (!path) return
    const control = new AbortController()
    setState({ path })
    api(session, path, { signal: control.signal })
      .then((data) => { if (!control.signal.aborted) setState({ path, data }) })
      .catch((error) => { if (!control.signal.aborted) setState({ path, error: error.message }) })
    return () => control.abort()
  }, [session, path, revision])
  return state.path === path ? state : {}
}

function Pending({ state }) {
  return state.error
    ? <p role="alert" className="feedback error">{state.error}</p>
    : <p role="status">Loading…</p>
}

function FilterFields({ fields, session }) {
  return <fieldset>
    <label htmlFor="filter-division">Division</label>
    <select id="filter-division" name="Division"><option value="">My division</option>
      <option value={session.user.division_id}>{session.user.division}</option>
    </select>
    {fields.map((field) => <div className="option-editor" key={field.key}>
      <label htmlFor={'filter-' + field.key}>{field.label}</label>
      {field.type === 'select' ? <select id={'filter-' + field.key} name={field.key}>
        <option value="">Any</option>
        {field.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select> : <input id={'filter-' + field.key} name={field.key} maxLength={500} />}
    </div>)}
  </fieldset>
}

function Results({ state, page, setPage }) {
  if (!state.data) return <Pending state={state} />
  return <>
    {!state.data.documents.length ? <p>No documents found.</p> :
      <ul className="document-list">{state.data.documents.map((doc) => <li key={doc.doc_id}>
        <a href={'#documents/' + doc.doc_id}>{doc.title}</a>
        <span>{doc.division}</span>
      </li>)}</ul>}
    {(page > 1 || state.data.has_more) && <div className="action-row" aria-label="Pagination">
      <button className="quiet-button" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button>
      <span>Page {page}</span>
      <button className="quiet-button" disabled={!state.data.has_more} onClick={() => setPage(page + 1)}>Next</button>
    </div>}
  </>
}

function Hub({ session, fields }) {
  const [filters, setFilters] = useState('')
  const [page, setPage] = useState(1)
  const state = useResource(session, '/documents?page=' + page + filters)
  return <section className="work-section">
    <h3>Document Hub</h3>
    <form className="workspace-form" onSubmit={(event) => {
      event.preventDefault()
      const query = new URLSearchParams([...new FormData(event.currentTarget)].filter(([, value]) => value))
      setFilters(query.size ? '&' + query.toString() : '')
      setPage(1)
    }}>
      <FilterFields session={session} fields={fields} />
      <button className="primary-button">Apply filters</button>
    </form>
    <Results state={state} page={page} setPage={setPage} />
  </section>
}

function Details({ session, id }) {
  const [revision, setRevision] = useState(0)
  const [requesting, setRequesting] = useState(false)
  const state = useResource(session, '/documents/' + id, revision)
  const [notice, setNotice] = useState(null)
  const [downloading, setDownloading] = useState(false)
  if (!state.data) return <Pending state={state} />
  const doc = state.data.document

  async function download() {
    setDownloading(true)
    setNotice(null)
    try {
      const blob = await api(session, '/documents/' + id + '/download', { binary: true })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = doc.filename
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) {
      setNotice({ error: true, text: error.message })
    } finally {
      setDownloading(false)
    }
  }

  async function requestAccess() {
    setRequesting(true)
    setNotice(null)
    try {
      await api(session, '/access/request', { method: 'POST', body: { doc_id: id } })
      setRevision((value) => value + 1)
    } catch (error) {
      setNotice({ error: true, text: error.message })
    } finally {
      setRequesting(false)
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setNotice({ text: 'Document link copied.' })
    } catch {
      setNotice({ error: true, text: 'Copy the URL from your browser to share this link.' })
    }
  }

  return <section className="work-section">
    <h3>{doc.title || 'Restricted document'}</h3>
    <dl className="account-details">
      <div><dt>Division</dt><dd>{doc.division}</dd></div>
      {doc.can_download && <>
        <div><dt>File</dt><dd>{doc.filename}</dd></div>
        {Object.entries(doc.metadata).map(([key, value]) =>
          <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}
      </>}
    </dl>
    {doc.can_download ? <>
      <button type="button" className="primary-button" disabled={downloading} onClick={download}>
        {downloading ? 'Downloading…' : 'Download'}
      </button>
      <button type="button" className="quiet-button" onClick={copyLink}>Copy document link</button>
    </> : doc.request_status ? <>
      <p role="status">Access request: {doc.request_status}.</p>
      <button className="quiet-button" type="button" onClick={() => setRevision((value) => value + 1)}>Refresh access</button>
    </> : <button className="primary-button" type="button" disabled={requesting} onClick={requestAccess}>
      {requesting ? 'Sending…' : 'Request access'}
    </button>}
    {notice && <p className={'feedback ' + (notice.error ? 'error' : 'success')}
      role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
  </section>
}

function locationView() {
  const hash = window.location.hash.slice(1)
  if (/^documents\/[a-f0-9]{24}$/i.test(hash)) return hash
  if (['documents', 'upload', 'settings', 'requests'].includes(hash)) return hash
  return 'documents'
}

export default function Workspace({ session, signOut, busy }) {
  const [view, setView] = useState(locationView)
  const [revision, setRevision] = useState(0)
  const metadata = useResource(session, '/metadata-fields', revision)
  const admin = session.user.role === 'admin'

  useEffect(() => {
    const update = () => setView(locationView())
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])

  const links = [['documents', 'Documents'], ['upload', 'Upload'], ['requests', 'Requests'], ...(admin ? [['settings', 'Settings']] : [])]
  return <>
    <div className="workspace-account">
      <div><strong>{session.user.email}</strong><p>{session.user.division}</p></div>
      <button type="button" className="quiet-button" disabled={busy} onClick={signOut}>
        {busy ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
    <nav className="workspace-nav" aria-label="Workspace">
      {links.map(([name, label]) => <a key={name} href={'#' + name}
        aria-current={view === name ? 'page' : undefined}>{label}</a>)}
    </nav>
    {view.startsWith('documents/') ? <Details key={view} session={session} id={view.split('/')[1]} />
      : view === 'upload' ? <UploadPanel session={session} />
      : view === 'requests' ? <Inbox session={session} useResource={useResource} Pending={Pending} />
      : view === 'settings' && admin ? <Settings session={session} onSave={() => setRevision((value) => value + 1)} />
      : metadata.data ? <Hub session={session} fields={metadata.data.fields} /> : <Pending state={metadata} />}
  </>
}
