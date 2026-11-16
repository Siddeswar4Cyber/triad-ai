import { useEffect, useState } from 'react'
import { api } from './api.js'

const empty = { key: '', label: '', type: 'text', required: false, active: true, options: [] }

export default function Settings({ session, onSave }) {
  const [fields, setFields] = useState([])
  const [draft, setDraft] = useState(null)
  const [editing, setEditing] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    api(session, '/metadata-fields?all=1', { signal: controller.signal })
      .then(({ fields }) => setFields(fields))
      .catch((err) => { if (!controller.signal.aborted) setError(err.message) })
    return () => controller.abort()
  }, [session])

  function change(key, value) {
    setDraft((field) => ({ ...field, [key]: value }))
  }

  function edit(field, existing) {
    setDraft(field)
    setEditing(existing)
    setError('')
    setMessage('')
  }

  async function save(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const { field } = await api(session, '/metadata-fields' + (editing ? '/' + draft.key : ''), {
        method: editing ? 'PATCH' : 'POST', body: draft,
      })
      setFields((current) => [...current.filter((item) => item.key !== field.key), field]
        .sort((a, b) => a.key.localeCompare(b.key)))
      setDraft(null)
      setMessage('Field saved.')
      onSave?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return <section className="work-section" aria-labelledby="settings-title">
    <h3 id="settings-title">Metadata settings</h3>
    {error && <p className="feedback error" role="alert">{error}</p>}
    {message && <p className="feedback success" role="status">{message}</p>}
    <div className="action-row">
      {fields.map((field) => <button className="quiet-button" key={field.key} type="button"
        disabled={busy} onClick={() => edit(field, true)}>{field.label}{field.active ? '' : ' (retired)'}</button>)}
      <button className="quiet-button" type="button" disabled={busy} onClick={() => edit(empty, false)}>Add field</button>
    </div>
    {draft && <form onSubmit={save}>
      <fieldset disabled={busy}>
        <label htmlFor="field-key">Field key</label>
        <input id="field-key" value={draft.key} readOnly={editing} required pattern="[a-z][a-z0-9_]{0,39}"
          onChange={(event) => change('key', event.target.value)} />
        <label htmlFor="field-label">Label</label>
        <input id="field-label" value={draft.label} required maxLength={80}
          onChange={(event) => change('label', event.target.value)} />
        <label htmlFor="field-type">Type</label>
        <select id="field-type" value={draft.type} disabled={editing} onChange={(event) =>
          setDraft({ ...draft, type: event.target.value, options: [] })}>
          <option value="text">Text</option><option value="select">Select</option>
        </select>
        <label className="check-label"><input type="checkbox" checked={draft.required}
          onChange={(event) => change('required', event.target.checked)} /> Required on upload</label>
        <label className="check-label"><input type="checkbox" checked={draft.active}
          onChange={(event) => change('active', event.target.checked)} /> Active</label>
        {draft.type === 'select' && <>
          {draft.options.map((option, index) => <div className="option-editor" key={option.id || index}>
            <label htmlFor={'choice-' + index}>Choice {index + 1}</label>
            <input id={'choice-' + index} value={option.label} required maxLength={80}
              onChange={(event) => change('options', draft.options.map((item, i) =>
                i === index ? { ...item, label: event.target.value } : item))} />
            <label className="check-label"><input type="checkbox" checked={option.active}
              onChange={(event) => change('options', draft.options.map((item, i) =>
                i === index ? { ...item, active: event.target.checked } : item))} /> Active choice {index + 1}</label>
            {!option.id && <button className="quiet-button" type="button" onClick={() =>
              change('options', draft.options.filter((_, i) => i !== index))}>Remove new choice {index + 1}</button>}
          </div>)}
          <button className="quiet-button" type="button" disabled={draft.options.length >= 100}
            onClick={() => change('options', [...draft.options, { label: '', active: true }])}>Add choice</button>
        </>}
      </fieldset>
      <button className="primary-button" disabled={busy}>{busy ? 'Saving…' : 'Save field'}</button>
    </form>}
  </section>
}
