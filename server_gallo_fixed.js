import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import ingestRouter from './routes/ingest.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app  = express()
const PORT = process.env.PORT || 3001

app.use(cors())
app.use(express.json())

// Serve ingest portal static files
app.use('/ingest', express.static(path.join(__dirname, 'ingest')))

// Genres list (used by submission form dropdowns)
const GENRES = [
  'Afro Pop','Afrobeats','Alternative','Blues','Classical','Country',
  'Dance','Electronic','Folk','Funk','Gospel','Hip Hop','House',
  'Jazz','Kwaito','Latin','Maskandi','Metal','Mbaqanga','Mbube',
  'Neo Soul','Pop','R&B','Reggae','Rock','Soul','Traditional',
  'Trap','World Music'
]
app.get('/api/genres', (req, res) => res.json(GENRES))

// API routes
app.use('/api/ingest', ingestRouter)

// Health check
app.get('/health', (req, res) => res.json({ ok: true, service: 'gallo-ingest' }))

// Root redirect
app.get('/', (req, res) => res.redirect('/ingest'))

app.listen(PORT, () => {
  console.log(`Gallo Ingest running on http://localhost:${PORT}`)
  console.log(`  Portal: http://localhost:${PORT}/ingest`)
  console.log(`  Admin:  http://localhost:${PORT}/ingest/admin`)
})
