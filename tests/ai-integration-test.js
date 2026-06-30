(async () => {
  const fetch = globalThis.fetch
  const base = process.argv[2] || 'http://localhost:5000'
  const email = process.argv[3] || 'gm@uacc.go.ug'
  const password = process.argv[4] || 'dims2026'

  console.log('Logging in to backend as', email)
  const loginRes = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const loginJson = await loginRes.json().catch(() => null)
  console.log('Login status:', loginRes.status)
  const token = loginJson?.data?.token || loginJson?.token
  if (!token) {
    console.error('Login failed', loginJson)
    process.exit(2)
  }

  console.log('Calling /api/ai with test message')
  const aiRes = await fetch(`${base}/api/ai`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ messages: [{ role: 'user', text: 'Hello from integration test' }] }),
  }).catch(e => ({ ok: false, error: e.message }))

  if (!aiRes.ok) {
    console.error('AI request failed', aiRes)
    process.exit(3)
  }
  const aiJson = await aiRes.json().catch(() => null)
  console.log('AI response:', JSON.stringify(aiJson, null, 2))
  process.exit(0)

})()
