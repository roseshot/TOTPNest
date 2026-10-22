// Set the appearance before React renders, without using an inline script.
;(() => {
  let saved = null
  try { saved = window.localStorage.getItem('totpnest:theme') }
  catch { /* Private browsing with restricted storage is supported. */ }
  let light = false
  try { light = window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false }
  catch { /* Keep dark as the fallback. */ }
  const theme = saved === 'light' || saved === 'dark' ? saved : light ? 'light' : 'dark'
  document.documentElement.dataset.theme = theme
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'light' ? '#f4f7fc' : '#0d1422')
})()
