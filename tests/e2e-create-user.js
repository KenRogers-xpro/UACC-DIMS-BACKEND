// E2E test: IT admin creates a user, user logs in, accesses /api/documents
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

  console.log('Server is up — logging in as IT admin')

  // IT admin credentials (from seed)
  const ADMIN_EMAIL = process.env.IT_ADMIN_EMAIL || 'it@uacc.go.ug'
  const ADMIN_PASSWORD = process.env.IT_ADMIN_PASSWORD || 'dims2026'

  const loginRes = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  })

  const loginJson = await loginRes.json().catch(() => null)
  if (!loginJson || !loginJson.success || !loginJson.data?.token) {
    console.error('Admin login failed', loginJson)
    process.exit(3)
  }

  const adminToken = loginJson.data.token

  // Create a unique test user
  const ts = Date.now()
  const testEmail = `e2e_user_${ts}@uacc.test`
  const testPassword = 'TestPass123'
  const testName = `E2E User ${ts}`

  console.log('Creating user', testEmail)

  const createRes = await fetch(`${base}/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({
      name: testName,
      email: testEmail,
      password: testPassword,
      role: 'STAFF',
      department: 'OPERATIONS',
    }),
  })

  const createJson = await createRes.json().catch(() => null)
  console.log('Create user response:', JSON.stringify(createJson, null, 2))
  if (!createJson || !createJson.success) {
    console.error('User creation failed')
    process.exit(4)
  }

  // Now login as the new user
  console.log('Logging in as new user')
  const userLoginRes = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: testEmail, password: testPassword }),
  })
  const userLoginJson = await userLoginRes.json().catch(() => null)
  console.log('User login response:', JSON.stringify(userLoginJson, null, 2))

  if (!userLoginJson || !userLoginJson.success || !userLoginJson.data?.token) {
    console.error('New user login failed')
    process.exit(5)
  }

  const userToken = userLoginJson.data.token

  // Access a module endpoint accessible to authenticated users
  console.log('Fetching /api/documents as new user')
  const docsRes = await fetch(`${base}/documents`, {
    headers: { Authorization: `Bearer ${userToken}` },
  })
  const docsJson = await docsRes.json().catch(() => null)
  console.log('Documents response:', JSON.stringify(docsJson, null, 2))

  if (!docsJson || !docsJson.success) {
    console.error('User could not access documents')
    process.exit(6)
  }

  console.log('E2E test passed: new user logged in and accessed /api/documents')
  process.exit(0)
})()
