import { useEffect, useState } from 'react'
import { api } from './api.js'

const maxBytes = 10 * 1024 * 1024

export default function UploadPanel({ session }) {
  const [fields, setFields] = useState(null)
  const [fieldError, setFieldError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    api(session, '/metadata-fields', { signal: controller.signal })
      .then(({ fields }) => setFields(fields))
      .catch((error) => { if (!controller.signal.aborted) setFieldError(error.message) })
    return () => controller.abort()
  }, [session, attempt])
  const [feedback, setFeedback] = useState(null)

  async function upload(event) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    if (data.get('file').size > maxBytes || !data.get('file').size) {
      setFeedback({ error: true, text: 'Choose a nonempty file up to 10 MiB.' })
      return
    }

    const metadata = {}
    for (const field of fields) {
      const value = data.get(field.key)?.trim()
      if (value) metadata[field.key] = value
    }
    for (const field of fields) data.delete(field.key)
    data.set('metadata', JSON.stringify(metadata))

    setBusy(true)
    setFeedback(null)
    try {
      const response = await fetch('/api/documents/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.token}` },
        body: data,
        signal: AbortSignal.timeout(30000),
      })
      const result = await response.json().catch(() => null)
      if (!response.ok || !result) {
        setFeedback({
          error: true,
          text: response.status === 401 ? 'Your session ended. Sign out and sign in again.'
            : result?.error || 'The upload could not be completed.',
        })
        return
      }
      form.reset()
      setFeedback({ text: `${result.filename} was uploaded to ${session.user.division}.` })
    } catch {
      setFeedback({ error: true, text: 'The upload could not be confirmed. Check your connection before retrying.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="upload-panel" aria-labelledby="upload-heading">
      <h3 id="upload-heading">Upload document</h3>
      <p className="field-help">Destination: {session.user.division}</p>
      <form onSubmit={upload} aria-busy={busy}>
        <fieldset disabled={busy}>
          <label htmlFor="upload-file">File</label>
          <input id="upload-file" name="file" type="file" required aria-describedby="upload-help"
            accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff,.webp" />
          <p id="upload-help" className="field-help">PDF, PNG, JPEG, TIFF, or WebP. Up to 10 MiB.</p>
          {!fields && !fieldError && <p role="status">Loading metadata fields…</p>}
          {fieldError && <p role="alert">{fieldError} <button className="quiet-button" type="button"
            onClick={() => { setFieldError(''); setAttempt((value) => value + 1) }}>Retry</button></p>}
          {fields?.map((field) => <div className="option-editor" key={field.key}>
            <label htmlFor={'upload-' + field.key}>{field.label}{field.required ? '' : ' (optional)'}</label>
            {field.type === 'select' ? <select id={'upload-' + field.key} name={field.key} defaultValue="" required={field.required}>
              <option value="">Select a choice</option>
              {field.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select> : <input id={'upload-' + field.key} name={field.key} maxLength={500} required={field.required} />}
          </div>)}
        </fieldset>
        <button className="primary-button" disabled={busy || !fields}>{busy ? 'Uploading…' : 'Upload document'}</button>
      </form>
      {feedback && <p className={`feedback ${feedback.error ? 'error' : 'success'}`}
        role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
    </section>
  )
}
