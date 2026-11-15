import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

const labels = {
  checking: ['Checking…', 'Checking…'],
  connected: ['Reachable', 'Connected'],
  unavailable: ['Reachable', 'Unavailable'],
  failed: ['Health check failed', 'Unknown'],
}

async function getHealth(signal) {
  const response = await fetch('/api/health', {
    signal,
    cache: 'no-store',
  })
  const health = await response.json()

  if (response.status === 200 && health.mongodb === 'connected') {
    return 'connected'
  }
  if (response.status === 503 && health.mongodb === 'unavailable') {
    return 'unavailable'
  }

  return 'failed'
}

function App() {
  const [status, setStatus] = useState('checking')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)
    let active = true

    getHealth(controller.signal)
      .then((result) => {
        if (active) setStatus(result)
      })
      .catch(() => {
        if (active) setStatus('failed')
      })
      .finally(() => clearTimeout(timeout))

    return () => {
      active = false
      clearTimeout(timeout)
      controller.abort()
    }
  }, [attempt])

  const [api, mongodb] = labels[status]

  return (
    <main>
      <h1>TRIAD AI System Status</h1>
      <div role="status">
        <p>Flask API: {api}</p>
        <p>MongoDB: {mongodb}</p>
      </div>
      <button
        type="button"
        disabled={status === 'checking'}
        onClick={() => {
          setStatus('checking')
          setAttempt((value) => value + 1)
        }}
      >
        Check again
      </button>
    </main>
  )
}

createRoot(document.getElementById('root')).render(<App />)