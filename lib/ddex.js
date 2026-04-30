import AdmZip from 'adm-zip'
import { parseStringPromise } from 'xml2js'
import { parseDDEXErn382 } from './ddex-ern382.js'
import { parseDDEXErn41  } from './ddex-ern41.js'

// Strip namespace prefixes from all keys recursively so callers use plain field names
function stripNs(obj) {
  if (Array.isArray(obj)) return obj.map(stripNs)
  if (obj && typeof obj === 'object') {
    const result = {}
    for (const [k, v] of Object.entries(obj)) {
      result[k.replace(/^[a-zA-Z_][\w]*:/, '')] = stripNs(v)
    }
    return result
  }
  return obj
}

export async function parseDDEXPackage(zipBuffer) {
  const zip     = new AdmZip(zipBuffer)
  const entries = zip.getEntries()

  const xmlEntry = entries.find(e =>
    e.entryName.endsWith('.xml') && !e.entryName.includes('__MACOSX')
  )
  if (!xmlEntry) throw new Error('No XML file found in DDEX package')

  const xmlStr = xmlEntry.getData().toString('utf8')

  const parsed = await parseStringPromise(xmlStr, {
    explicitArray:   false,
    mergeAttrs:      true,
    explicitCharkey: false,
  })

  // Extract version from namespace before stripping
  const ns      = xmlStr.match(/xmlns:ern="([^"]+)"/)?.[1] || ''
  const version = ns.includes('/382') || ns.includes('ern/382') ? '382'
    : ns.includes('/41')  || ns.includes('ern/41')  ? '41'
    : 'unknown'

  // Build file map: basename (lowercase) → Buffer
  const fileMap = {}
  entries.forEach(e => {
    if (!e.isDirectory) {
      const basename = e.name.toLowerCase()
      fileMap[basename] = e.getData()
    }
  })

  // Strip ns prefixes so parsers use plain names regardless of prefix conventions
  const rawRoot = parsed['ern:NewReleaseMessage'] || parsed['NewReleaseMessage'] || Object.values(parsed)[0]
  const root    = stripNs(rawRoot)

  let tracks
  if (version === '382') tracks = parseDDEXErn382(root, fileMap)
  else if (version === '41') tracks = parseDDEXErn41(root, fileMap)
  else throw new Error(`Unsupported DDEX version namespace: ${ns}`)

  return { version, tracks, fileMap }
}
