import { useState } from 'react'
import { api } from './api.js'

export default function Inbox({ session, useResource, Pending }) {
  const [direction, setDirection] = useState('incoming')
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const state = useResource(session, '/access/requests?direction=' + direction + '&page=' + page, revision)

  async function decide(action, requestId) {
    setBusy(true)
    setMessage('')
    try {
      await api(session, '/access/' + action, { method: 'POST', body: { request_id: requestId } })
    } catch (error) {
      setMessage(error.message)
    } finally {
      setRevision((value) => value + 1)
      setBusy(false)
    }
  }

  return <section className="work-section">
    <h3>Access requests</h3>
    <div className="action-row">
      {['incoming', 'outgoing'].map((item) => <button className="quiet-button" type="button"
        aria-pressed={direction === item} disabled={busy} key={item} onClick={() => {
          setDirection(item)
          setPage(1)
          setMessage('')
        }}>{item === 'incoming' ? 'Incoming' : 'Sent'}</button>)}
    </div>
    {message && <p role="alert" className="feedback error">{message}</p>}
    {!state.data ? <Pending state={state} /> : <>
      {state.data.requests.length ? <ul className="document-list request-list">
        {state.data.requests.map((entry) => <li key={entry.request_id}>
          <div>
            <a href={'#documents/' + entry.doc_id}>{entry.title || 'Document ' + entry.doc_id}</a>
            <p>{entry.requester || entry.division} · {entry.status}</p>
            {entry.requester_division && <p>{entry.requester_division}</p>}
          </div>
          {direction === 'incoming' && entry.status === 'pending' && <div className="action-row">
            <button className="quiet-button" disabled={busy} onClick={() => decide('approve', entry.request_id)}>Approve</button>
            <button className="quiet-button" disabled={busy} onClick={() => decide('reject', entry.request_id)}>Reject</button>
          </div>}
        </li>)}
      </ul> : <p>No {direction === 'incoming' ? 'incoming' : 'sent'} requests.</p>}
      {(page > 1 || state.data.has_more) && <div className="action-row">
        <button className="quiet-button" disabled={page === 1 || busy} onClick={() => setPage(page - 1)}>Previous</button>
        <span>Page {page}</span>
        <button className="quiet-button" disabled={!state.data.has_more || busy} onClick={() => setPage(page + 1)}>Next</button>
      </div>}
    </>}
  </section>
}
