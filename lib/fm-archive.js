/**
 * lib/fm-archive.js — writes WAV masters to a separate FM archive database.
 * Uses env: FM_ARCHIVE_HOST, FM_ARCHIVE_DB, FM_ARCHIVE_USER, FM_ARCHIVE_PASS,
 *           FM_ARCHIVE_LAYOUT, FM_ARCHIVE_WAV_FIELD
 */

const {
  FM_ARCHIVE_HOST, FM_ARCHIVE_DB,
  FM_ARCHIVE_USER, FM_ARCHIVE_PASS,
  FM_ARCHIVE_LAYOUT, FM_ARCHIVE_WAV_FIELD
} = process.env

const archiveBase = FM_ARCHIVE_HOST && FM_ARCHIVE_DB
  ? `${FM_ARCHIVE_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(FM_ARCHIVE_DB)}`
  : null

let _token = null
let _tokenExpiry = 0

async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token
  if (!archiveBase) throw new Error('FM_ARCHIVE_* env vars not configured')
  const res = await fetch(`${archiveBase}/sessions`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${FM_ARCHIVE_USER}:${FM_ARCHIVE_PASS}`).toString('base64'),
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({})
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = json?.messages?.[0]?.message || `HTTP ${res.status}`
    throw new Error(`FM archive login failed: ${msg}`)
  }
  _token = json?.response?.token
  if (!_token) throw new Error('FM archive login returned no token')
  _tokenExpiry = Date.now() + 14 * 60 * 1000
  return _token
}

async function archiveFetch(path, options = {}) {
  const token = await getToken()
  const url = `${archiveBase}${path}`
  const res = await fetch(url, {
    ...options,
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...(options.headers || {})
    }
  })
  // Refresh token on 401 and retry once
  if (res.status === 401) {
    _token = null
    _tokenExpiry = 0
    const freshToken = await getToken()
    return fetch(url, {
      ...options,
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${freshToken}`,
        ...(options.headers || {})
      }
    })
  }
  return res
}

/**
 * Archive a WAV buffer to the FM archive database.
 * Returns { fmRecordId }
 */
export async function archiveWav(wavBuffer, metadata = {}) {
  if (!archiveBase) throw new Error('FM_ARCHIVE_* env vars not configured')
  if (!FM_ARCHIVE_LAYOUT) throw new Error('FM_ARCHIVE_LAYOUT not set')
  if (!FM_ARCHIVE_WAV_FIELD) throw new Error('FM_ARCHIVE_WAV_FIELD not set')

  // 1. Create the metadata record
  const fieldData = {}
  if (metadata.title)    fieldData['Title']    = metadata.title
  if (metadata.artist)   fieldData['Artist']   = metadata.artist
  if (metadata.album)    fieldData['Album']    = metadata.album
  if (metadata.isrc)     fieldData['ISRC']     = metadata.isrc
  if (metadata.year)     fieldData['Year']     = String(metadata.year)
  if (metadata.genre)    fieldData['Genre']    = metadata.genre
  if (metadata.duration) fieldData['Duration'] = String(metadata.duration)

  const createRes = await archiveFetch(
    `/layouts/${encodeURIComponent(FM_ARCHIVE_LAYOUT)}/records`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fieldData })
    }
  )
  const createJson = await createRes.json().catch(() => ({}))
  if (!createRes.ok) {
    const msg = createJson?.messages?.[0]?.message || `HTTP ${createRes.status}`
    throw new Error(`FM archive create failed: ${msg}`)
  }
  const fmRecordId = String(createJson?.response?.recordId || '')
  if (!fmRecordId) throw new Error('FM archive create returned no recordId')

  // 2. Upload WAV to container field
  const form = new FormData()
  const blob = new Blob([wavBuffer], { type: 'audio/wav' })
  form.append('upload', blob, metadata.filename || 'audio.wav')

  const uploadRes = await archiveFetch(
    `/layouts/${encodeURIComponent(FM_ARCHIVE_LAYOUT)}/records/${fmRecordId}/containers/${encodeURIComponent(FM_ARCHIVE_WAV_FIELD)}/1`,
    { method: 'POST', body: form }
  )
  if (!uploadRes.ok) {
    const uploadJson = await uploadRes.json().catch(() => ({}))
    const msg = uploadJson?.messages?.[0]?.message || `HTTP ${uploadRes.status}`
    throw new Error(`FM archive WAV upload failed: ${msg}`)
  }

  return { fmRecordId }
}

/**
 * Fetch a record from the FM archive by its FM record ID.
 */
export async function getArchiveRecord(fmRecordId) {
  if (!archiveBase) throw new Error('FM_ARCHIVE_* env vars not configured')
  const res = await archiveFetch(
    `/layouts/${encodeURIComponent(FM_ARCHIVE_LAYOUT)}/records/${encodeURIComponent(fmRecordId)}`
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) return null
  return json?.response?.data?.[0] || null
}
