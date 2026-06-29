// Simple smoke test: login and GET /api/users
const base = process.env.API_URL || 'http://localhost:5000/api'

async function waitForServer(retries = 10) {
  const baseRoot = base.replace(/\/api\/?$/, '')
  for (let i = 0; i < retries; i++) {
    try {
      const checks = [`${base}/health`, `${baseRoot}/health`]
      for (const url of checks) {
        try {
          const r = await fetch(url)
          if (r.ok) return true
        } catch (e) {
          /* ignore */
        }
      }
    } catch (e) {
      // ignore
    }
    await new Promise(r => setTimeout(r, 1000))
  }
  return false
}

;(async () => {
  const ready = await waitForServer(15)
  if (!ready) {
    console.error('Server not responding at', base)
    process.exit(2)
  }

  console.log('Server is up — attempting login')

  const loginRes = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'it@uacc.go.ug', password: 'dims2026' }),
  })

  const loginJson = await loginRes.json().catch(() => null)
  console.log('Login response:', JSON.stringify(loginJson, null, 2))

  if (!loginJson || !loginJson.success || !loginJson.data?.token) {
    console.error('Login failed')
    process.exit(3)
  }

  const token = loginJson.data.token
  console.log('Token acquired, fetching /api/users')

  const usersRes = await fetch(`${base}/users`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const usersJson = await usersRes.json().catch(() => null)
  console.log('Users response:', JSON.stringify(usersJson, null, 2))

  if (!usersJson || !usersJson.success) {
    console.error('GET /api/users failed')
    process.exit(4)
  }

  console.log('Smoke test passed: /api/users returned', (usersJson.data || []).length, 'records')
  process.exit(0)
})()
