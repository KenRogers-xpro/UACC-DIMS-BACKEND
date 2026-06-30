(async () => {
  try {
    const ai = await import('../src/lib/ai.js')
    const res = await ai.generateFromMessages([{ role: 'user', text: 'Say hello' }])
    console.log('Local AI call result:', res)
  } catch (err) {
    console.error('Local AI call failed:', err)
  }
})()
