// store.js — backwards-compatibility re-export shim for token storage.
// Playlists and library have moved to FM-backed modules; import directly from:
//   lib/token-store.js    — token CRUD and generation
//   lib/playlist-store.js — playlist FM operations
//   lib/library-store.js  — user library FM operations
export * from './lib/token-store.js';
