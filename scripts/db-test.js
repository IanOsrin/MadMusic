import 'dotenv/config'
import { query, runMigrations } from '../lib/db.js'

await runMigrations()

// Insert
await query(
  `INSERT INTO artists (name, slug) VALUES ($1, $2)`,
  ['Test Artist', '_db-test-artist']
)

// Read back
const rows = await query(
  `SELECT id, name FROM artists WHERE slug = $1`,
  ['_db-test-artist']
)
if (!rows.length) throw new Error('Artist not found after insert')
const { id } = rows[0]

// Delete
await query(`DELETE FROM artists WHERE id = $1`, [id])

// Confirm gone
const gone = await query(`SELECT 1 FROM artists WHERE id = $1`, [id])
if (gone.length) throw new Error('Artist still present after delete')

console.log('DB OK')
