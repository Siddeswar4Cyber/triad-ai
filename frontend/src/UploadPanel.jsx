import { useState } from 'react'

const maxBytes = 10 * 1024 * 1024

export default function UploadPanel({ session }) {
  const [busy, setBusy] = useState(false)
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
    const reportType = data.get('reportType').trim()
    if (reportType) metadata['Report Type'] = reportType
    data.delete('reportType')
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
          <label htmlFor="report-type">Report type (optional)</label>
          <input id="report-type" name="reportType" maxLength={500} placeholder="e.g. Financial" />
        </fieldset>
        <button className="primary-button" disabled={busy}>{busy ? 'Uploading…' : 'Upload document'}</button>
      </form>
      {feedback && <p className={`feedback ${feedback.error ? 'error' : 'success'}`}
        role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
    </section>
  )
}
