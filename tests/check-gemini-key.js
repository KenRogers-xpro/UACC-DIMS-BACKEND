(async () => {
  try {
    const ai = await import('../src/lib/ai.js')
    console.log('Key diagnostics:', ai.getKeyDiagnostics())
    const check = await ai.checkKeyWithTestCall(10000)
    console.log('Test call result:', check)
  } catch (err) {
    console.error('Key check failed:', err)
  }
})()
