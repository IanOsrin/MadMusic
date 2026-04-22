#!/usr/bin/env python3
"""
sync-audio-lab.py
=================
Generates public/audio-lab.html from the standalone digital-cupboard-audio.html.

The standalone is the SINGLE SOURCE OF TRUTH for all shared features (EQ,
compressor, waveform, stem cards, phase switch, etc.).  This script applies
the small set of streamer-specific differences automatically.

Run from the DigitalCupboardAudio folder:
  python3 sync-audio-lab.py

Or from the project root:
  python3 DigitalCupboardAudio/sync-audio-lab.py
"""

import re
import sys
from pathlib import Path

SCRIPT_DIR  = Path(__file__).parent.resolve()
PROJECT_DIR = SCRIPT_DIR.parent
SRC  = SCRIPT_DIR / 'digital-cupboard-audio.html'
DEST = PROJECT_DIR / 'public' / 'audio-lab.html'

# ── Helpers ───────────────────────────────────────────────────────────────────

def replace_once(text, old, new, label):
    if old not in text:
        print(f'  ⚠  Could not find marker: {label}')
        return text
    print(f'  ✓  {label}')
    return text.replace(old, new, 1)

# ── Load source ───────────────────────────────────────────────────────────────

html = SRC.read_text(encoding='utf-8')
print(f'Read {SRC.name} ({len(html):,} chars)')

# ── 1. Strip the ##STREAMER_ONLY_START## / ##STREAMER_ONLY_END## comment block
#      and insert its contents as real HTML (the AI server banner).
# ─────────────────────────────────────────────────────────────────────────────
html = replace_once(
    html,
    '<!-- ##STREAMER_ONLY_START##',
    '',   # opening comment tag removed — content becomes live HTML
    'Uncomment AI server banner'
)
html = replace_once(
    html,
    '##STREAMER_ONLY_END## -->',
    '',
    'Close AI server banner comment'
)

# ── 2. Setup-box instruction text (inline ##STANDALONE## / ##STREAMER## / ##END##)
# ─────────────────────────────────────────────────────────────────────────────
html = re.sub(
    r'<!-- ##STANDALONE## -->.*?<!-- ##STREAMER## -->(.*?)<!-- ##END## -->',
    r'\1',
    html,
    flags=re.DOTALL
)
print('  ✓  Setup box instruction text')

# ── 3. demucsHost — standalone uses location.hostname, streamer hardcodes localhost
# ─────────────────────────────────────────────────────────────────────────────
html = re.sub(
    r'/\* ##STANDALONE## \*/.*?/\* ##END## \*/',
    "const demucsHost = 'localhost' // always local — demucs runs on the user's machine",
    html,
    flags=re.DOTALL
)
print('  ✓  demucsHost')

# ── 4. checkServerStatus — remove standalone-only guards
# ─────────────────────────────────────────────────────────────────────────────
html = replace_once(
    html,
    '  if (replicateKey) return   // cloud mode — don\'t ping local server\n',
    '',
    'Remove cloud guard from checkServerStatus'
)
html = replace_once(
    html,
    '  window._localServerConnected = false\n  if (replicateKey) return   // cloud already active — don\'t reset status\n',
    '',
    'Remove _localServerConnected reset from checkServerStatus'
)

# ── 5. runAiSplitCloud — replace standalone body with streamer body
#      Standalone: WAV encode → base64 dataURL → direct Replicate API
#      Streamer:   pass S3 URL → server proxy → /api/audio-lab/replicate/*
# ─────────────────────────────────────────────────────────────────────────────
STANDALONE_CLOUD_BODY = """\
  out.innerHTML = `<div class="stem-progress-wrap"><div class="stem-prog-track"><div class="stem-prog-fill" style="width:5%"></div></div><div class="stem-prog-label">Encoding audio…</div></div>`
  await new Promise(r => setTimeout(r, 0))

  const wavBlob = encodeWAV(audioBuf)
  const dataUrl = await new Promise(res => {
    const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(wavBlob)
  })
  const mb = Math.round(wavBlob.size / 1024 / 1024 * 10) / 10

  out.innerHTML = `<div class="stem-progress-wrap"><div class="stem-prog-track"><div class="stem-prog-fill" style="width:12%"></div></div><div class="stem-prog-label">Sending ${mb} MB to Replicate…</div></div>`

  // Start prediction — called directly (no CSP in standalone)
  const startResp = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: { 'Authorization': `Token ${replicateKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: REPLICATE_MODEL, input: { audio: dataUrl, model: 'htdemucs' } })
  })"""

STREAMER_CLOUD_BODY = """\
  // Pass the original audio URL directly to Replicate — it fetches the MP3 from S3 itself,
  // no encoding or upload needed on our side.
  const audioInput = window._originalAudioUrl
  if (!audioInput) throw new Error('No audio URL available — try reloading the track')

  out.innerHTML = `<div style="padding:12px;color:var(--muted);font-size:0.82rem;">☁️ Sending to Replicate…</div>`

  const _authHeaders = window._massAccessToken ? { 'X-Access-Token': window._massAccessToken } : {}

  const startResp = await fetch('/api/audio-lab/replicate/predictions', {
    method: 'POST',
    headers: { ..._authHeaders, 'X-Replicate-Key': replicateKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: REPLICATE_MODEL, input: { audio: audioInput, model: 'htdemucs' } })"""

html = replace_once(html, STANDALONE_CLOUD_BODY, STREAMER_CLOUD_BODY, 'Replace cloud upload (WAV encode → S3 URL pass-through)')

# ── 6. Poll calls — swap direct Replicate URLs for proxy URLs, add auth headers
# ─────────────────────────────────────────────────────────────────────────────
html = replace_once(
    html,
    "    await new Promise(r => setTimeout(r, 5000))\n    const pollResp = await fetch(`https://api.replicate.com/v1/predictions/${pred.id}`, {\n      headers: { 'Authorization': `Token ${replicateKey}` }\n    })",
    "    await new Promise(r => setTimeout(r, 3000))\n    const pollResp = await fetch(`/api/audio-lab/replicate/predictions/${pred.id}`, {\n      headers: { ..._authHeaders, 'X-Replicate-Key': replicateKey }\n    })",
    'Replace poll URL + headers'
)
html = replace_once(
    html,
    "    const secs = attempts * 5\n    const pct = Math.min(15 + attempts * 0.4, 82)\n    out.innerHTML = `<div class=\"stem-progress-wrap\"><div class=\"stem-prog-track\"><div class=\"stem-prog-fill\" style=\"width:${pct}%\"></div></div><div class=\"stem-prog-label\">🤖 Cloud processing… ${secs}s elapsed (1–3 min)</div></div>`",
    "    out.innerHTML = `<div style=\"padding:12px;color:var(--muted);font-size:0.82rem;\">🤖 Processing… (${attempts * 3}s)</div>`",
    'Replace poll progress bar with simple text'
)

# ── 7. After normalise comment — add console.log for debugging
# ─────────────────────────────────────────────────────────────────────────────
html = replace_once(
    html,
    "  // Normalise output — object {drums,bass,...} or array\n  const raw = result.output\n  let stems",
    "  // Normalise output — Replicate may return an object {drums,bass,...} or an array of URLs\n  const raw = result.output\n  console.log('[Replicate] output:', JSON.stringify(raw))\n\n  let stems  // always end up as { name: url }",
    'Add Replicate output console.log'
)

# ── 8. Error message wording
# ─────────────────────────────────────────────────────────────────────────────
html = replace_once(
    html,
    "    throw new Error(`Unexpected Replicate output: ${JSON.stringify(raw)}`)",
    "    throw new Error(`Unexpected Replicate output format: ${JSON.stringify(raw)}`)",
    'Normalise error message wording'
)

# ── 9. Stem rendering — standalone uses allStemCards + tmpCtx, streamer is simpler
# ─────────────────────────────────────────────────────────────────────────────
STANDALONE_STEMS = """\
  out.innerHTML = ''
  allStemCards = []
  const badge = document.createElement('div')
  badge.className = 'stem-note'
  badge.style.cssText = 'border-color:#22c55e;color:#86efac'
  badge.textContent = `✨ AI stems — Replicate · Demucs htdemucs · cloud processed`
  out.appendChild(badge)

  const colorMap = { vocals:'#7db02a', drums:'#d94040', bass:'#c47d2a', other:'#a855f7' }
  const descMap  = { vocals:'AI vocals · htdemucs', drums:'AI drums · htdemucs', bass:'AI bass · htdemucs', other:'AI other · htdemucs' }

  // Pre-insert placeholders so we can replace without innerHTML += destroying siblings
  const entries = Object.entries(stems).filter(([, url]) => url && typeof url === 'string')
  const placeholders = {}
  for (const [name] of entries) {
    const ph = document.createElement('div')
    ph.style.cssText = 'padding:8px;color:var(--muted);font-size:0.8rem;'
    ph.textContent = `⬇ Loading ${name}…`
    out.appendChild(ph)
    placeholders[name] = ph
  }

  for (const [name, url] of entries) {
    const resp = await fetch(url)   // Replicate CDN — no CORS/CSP issues in standalone
    if (!resp.ok) throw new Error(`Failed to download ${name} stem (HTTP ${resp.status})`)
    const ab = await resp.arrayBuffer()
    const tmpCtx = new AudioContext()
    const buf = await tmpCtx.decodeAudioData(ab)
    tmpCtx.close()
    const { el, ...ctrl } = makeStemCard({
      label: name.charAt(0).toUpperCase() + name.slice(1),
      buf,
      color: colorMap[name] || '#8b5cf6',
      desc:  descMap[name]  || 'AI-separated stem · Replicate'
    })
    placeholders[name].replaceWith(el)
    allStemCards.push(ctrl)
  }

  $('stemsTransport').classList.add('visible')
  if (allStemCards.length) runBPMDetect(audioBuf)
  setStatus('AI stems ready', 'ready')"""

STREAMER_STEMS = """\
  out.innerHTML = ''
  const colours = { drums:'#e94560', bass:'#2a6ee9', vocals:'#a855f7', other:'#C9A227' }
  const entries = Object.entries(stems).filter(([, url]) => url && typeof url === 'string')

  // Pre-insert placeholder divs so we can replace them without innerHTML += destroying siblings
  const placeholders = {}
  for (const [name] of entries) {
    const ph = document.createElement('div')
    ph.style.cssText = 'padding:8px;color:var(--muted);font-size:0.8rem;'
    ph.textContent = `⬇ Loading ${name}…`
    out.appendChild(ph)
    placeholders[name] = ph
  }

  for (const [name, url] of entries) {
    if (!url || typeof url !== 'string') continue
    // Proxy through our server to avoid CSP/CORS issues with Replicate CDN URLs
    const proxyUrl = '/api/audio-proxy?url=' + encodeURIComponent(url)
    const resp = await fetch(proxyUrl)
    if (!resp.ok) throw new Error(`Failed to download ${name} stem (HTTP ${resp.status})`)
    const ct = resp.headers.get('content-type') || ''
    if (ct.includes('json') || ct.includes('text/html')) {
      const txt = await resp.text()
      throw new Error(`Unexpected response for ${name}: ${txt.slice(0, 120)}`)
    }
    const ab = await resp.arrayBuffer()
    let decoded
    try {
      decoded = await audioCtx.decodeAudioData(ab)
    } catch (e) {
      throw new Error(`Could not decode ${name} stem (${ct}, ${ab.byteLength} bytes): ${e.message}`)
    }
    const card = makeStemCard({ label: name, buf: decoded, color: colours[name] || '#8b5cf6', desc: `${name} stem` })
    placeholders[name].replaceWith(card)
  }

  $('stemsTransport').style.display = ''"""

html = replace_once(html, STANDALONE_STEMS, STREAMER_STEMS, 'Replace stem rendering (standalone cards → streamer cards)')

# ── 10. runAiSplit — add _aiSplitInProgress flag (streamer only)
# ─────────────────────────────────────────────────────────────────────────────
html = replace_once(
    html,
    "    // Cloud path — Replicate key set and no local server running",
    "    window._aiSplitInProgress = true\n\n    // Cloud path — if local server isn't running but Replicate key is set",
    'Add _aiSplitInProgress flag'
)
html = replace_once(
    html,
    "    if (!replicateKey) checkServerStatus()",
    "    window._aiSplitInProgress = false\n    checkServerStatus()",
    'Remove replicateKey guard from finally, clear _aiSplitInProgress'
)

# ── 11. Append streamer-only sections (loadFromUrl, checkAiServer, init IIFE)
# ─────────────────────────────────────────────────────────────────────────────
STREAMER_TAIL = """

// ─────────────────────────────────────────────────────────────────────────────
// Load from URL (called when opened from the streamer with ?url=...&title=...)
// ─────────────────────────────────────────────────────────────────────────────
async function loadFromUrl(url, title) {
  const dropZone = $('dropZone')
  dropZone.innerHTML = `
    <div class="drop-icon">⏳</div>
    <h2>Loading "${title || 'track'}"…</h2>
    <p>Fetching audio from the archive</p>`

  try {
    // Route through server proxy to avoid S3/CDN CORS restrictions
    const proxyUrl = '/api/audio-proxy?url=' + encodeURIComponent(url)
    const resp = await fetch(proxyUrl)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const blob = await resp.blob()
    const filename = title ? title + '.mp3' : url.split('/').pop() || 'track.mp3'
    const file = new File([blob], filename, { type: blob.type || 'audio/mpeg' })
    await loadFile(file)
  } catch (err) {
    dropZone.innerHTML = `
      <div class="drop-icon">⚠️</div>
      <h2>Could not load track</h2>
      <p style="color:#d94040">${err.message}</p>
      <p>You can still drop or browse a local file below.</p>
      <button class="btn-browse" id="btnBrowse2">Browse Files</button>`
    document.getElementById('btnBrowse2')?.addEventListener('click', () => $('fileInput').click())
    dropZone.classList.remove('hidden')
    $('editor').classList.remove('visible')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AI Server status check
// ─────────────────────────────────────────────────────────────────────────────
async function checkAiServer() {
  const banner  = document.getElementById('aiServerBanner')
  const dot     = document.getElementById('aiServerDot')
  const msg     = document.getElementById('aiServerMsg')
  const instr   = document.getElementById('aiServerInstructions')
  banner.style.display = 'block'

  try {
    const resp = await fetch('http://localhost:8765/ping', { signal: AbortSignal.timeout(2000) })
    const data = await resp.json()
    if (data.status === 'ok') {
      dot.style.background  = '#7db02a'
      msg.style.color       = '#7db02a'
      msg.textContent       = '✓ AI Stem Server connected — AI Split is ready'
      instr.style.display   = 'none'
      const btn = document.getElementById('btnAiSplit')
      if (btn) btn.disabled = false
      return true
    }
  } catch (e) {}

  dot.style.background  = '#d94040'
  msg.style.color       = '#b09070'
  msg.textContent       = 'AI Stem Server not running — AI Split unavailable'
  instr.style.display   = 'block'

  const isMac = navigator.platform.toLowerCase().includes('mac') || navigator.userAgent.includes('Mac')
  document.getElementById('aiMacInstructions').style.display = isMac ? '' : 'none'
  document.getElementById('aiWinInstructions').style.display = isMac ? 'none' : ''
  return false
}

// ─────────────────────────────────────────────────────────────────────────────
// On page load — check URL params and AI server
// ─────────────────────────────────────────────────────────────────────────────
;(async function init() {
  await checkAiServer()
  setInterval(() => { if (!window._aiSplitInProgress) checkAiServer() }, 15000)

  const params = new URLSearchParams(window.location.search)
  const srcUrl   = params.get('url')
  const srcTitle = params.get('title')
  const srcTok   = params.get('tok')
  if (srcTok) window._massAccessToken = decodeURIComponent(srcTok)

  if (srcUrl) {
    window._originalAudioUrl = decodeURIComponent(srcUrl)   // kept for Replicate cloud path
    await loadFromUrl(window._originalAudioUrl, srcTitle ? decodeURIComponent(srcTitle) : '')
  }
})()"""

# Insert before closing </script> tag
if '</script>' in html:
    html = html.replace('</script>', STREAMER_TAIL + '\n</script>', 1)
    print('  ✓  Append streamer-only sections (loadFromUrl, checkAiServer, init IIFE)')
else:
    print('  ⚠  Could not find </script> to append streamer sections')

# ── Write output ──────────────────────────────────────────────────────────────

DEST.write_text(html, encoding='utf-8')
src_lines  = SRC.read_text().count('\n')
dest_lines = html.count('\n')
print(f'\nWrote {DEST} ({dest_lines:,} lines, source was {src_lines:,} lines)')
print('Done ✅')
