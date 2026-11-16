import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import AuthPanel from './AuthPanel.jsx'
import './styles.css'

const labels = {
  checking: ['Checking', 'Checking'],
  connected: ['Reachable', 'Connected'],
  unavailable: ['Reachable', 'Unavailable'],
  failed: ['Unreachable', 'Unknown'],
}

function ServiceStatus() {
  const [status, setStatus] = useState('checking')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)
    let active = true

    async function check() {
      let result = 'failed'
      try {
        const response = await fetch('/api/health', { signal: controller.signal, cache: 'no-store' })
        const health = await response.json()
        if (response.status === 200 && health.mongodb === 'connected') result = 'connected'
        if (response.status === 503 && health.mongodb === 'unavailable') result = 'unavailable'
      } catch {
        // A network error or timeout leaves the service status as failed.
      } finally {
        clearTimeout(timeout)
        if (active) setStatus(result)
      }
    }

    check()
    return () => {
      active = false
      clearTimeout(timeout)
      controller.abort()
    }
  }, [attempt])

  const [api, database] = labels[status]
  return (
    <section id="system-status" className="status-panel" aria-labelledby="status-heading" tabIndex={-1}>
      <div className="status-heading">
        <h2 id="status-heading">System status</h2>
        <button className="quiet-button" type="button" disabled={status === 'checking'} onClick={() => {
          setStatus('checking')
          setAttempt((value) => value + 1)
        }}>Check again</button>
      </div>
      <dl className="services" aria-live="polite" aria-atomic="true">
        <div><dt>Flask API</dt><dd><span className={`dot ${api === 'Reachable' ? 'good' : api === 'Unreachable' ? 'bad' : ''}`} />{api}</dd></div>
        <div><dt>MongoDB</dt><dd><span className={`dot ${database === 'Connected' ? 'good' : database === 'Unavailable' ? 'bad' : ''}`} />{database}</dd></div>
      </dl>
    </section>
  )
}

function App() {
  return (
    <>
      <a className="skip-link" href="#account">Skip to account</a>
      <header className="topbar">
        <div className="brand"><span className="brand-mark" aria-hidden="true" />TRIAD AI</div>
        <nav aria-label="Main navigation">
          <a href="#account">Account</a>
          <a href="#system-status">System status</a>
        </nav>
      </header>
      <main className="workspace">
        <div className="intro">
          <h1>Document<br /> Management</h1>
          <p>Sign in to your division workspace.</p>
          <div className="document-art" aria-hidden="true">
            <span className="orbit orbit-outer" />
            <span className="orbit orbit-inner" />
            <span className="orbit-point" />
            <span className="paper paper-back" />
            <span className="paper paper-front"><i /><i /><i /></span>
          </div>
          <ServiceStatus />
        </div>
        <AuthPanel />
      </main>
    </>
  )
}

createRoot(document.getElementById('root')).render(<App />)
