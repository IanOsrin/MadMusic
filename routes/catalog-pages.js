// ============================================================================
// routes/catalog-pages.js — public, server-rendered catalogue pages (SEO tier 2).
//
//   /artist/:slug   artist page: bio card, album grid, MusicGroup JSON-LD
//   /album/:slug    album page: artwork, tracklist + 30s previews, MusicAlbum JSON-LD
//   /genre/:slug    genre hub: intro line, top artists, album grid
//   /browse         index page: genres + notable artists (crawl entry point)
//
// Mounted only when CATALOG_PAGES_ENABLED=true (server.js). These are
// MARKETING surfaces outside the app: crawlers and humans get real HTML,
// previews use the public server-clipped stream, and every full-listen path
// leads into the app's normal trial/subscribe flow. No FM on the request
// path — reads come from the slug index (PG mirror) and pgFind.
// ============================================================================

import { Router } from 'express';
import { getIndex, slugify } from '../lib/catalog-slugs.js';
import { pgFind } from '../lib/catalog-store-pg.js';
import { getArtistBio } from './artist-bio.js';
import { recordIsVisible } from '../lib/fm-fields.js';
import { thumbArtworkUrl } from '../lib/track.js';

const router = Router();
const ORIGIN = 'https://musicafricadirect.com';
const GUEST_PREVIEW_ENABLED = process.env.GUEST_PREVIEW_ENABLED === 'true';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Album artwork: the same 300px WebP derivative the app's rails use
// (lib/track.js thumbArtworkUrl); missing artwork → the site's default tile.
const resized = (masterUrl) => thumbArtworkUrl(masterUrl, 300) || '/img/default-album.svg';

function pageShell({ title, description, canonicalPath, jsonLd, body, ogImage }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${esc(title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${ORIGIN}${esc(canonicalPath)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="MAD — Music Africa Direct">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:image" content="${esc(ogImage || ORIGIN + '/img/og-share.png')}">
  <meta property="og:url" content="${ORIGIN}${esc(canonicalPath)}">
  <meta name="twitter:card" content="summary_large_image">
  ${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : ''}
  <style>
    :root{--bg:#0b0b10;--card:#16161f;--border:#26263a;--text:#e8e8ee;--muted:#8f8fa3;--accent:#8b5cf6;--accent2:#cbbcf7}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Barlow,Helvetica,Arial,sans-serif;line-height:1.5}
    a{color:var(--accent2);text-decoration:none}a:hover{text-decoration:underline}
    .wrap{max-width:1060px;margin:0 auto;padding:0 20px 60px}
    header.site{display:flex;align-items:center;justify-content:space-between;padding:16px 0;border-bottom:1px solid var(--border);margin-bottom:28px}
    header.site img{height:34px}
    .cta{background:linear-gradient(135deg,#8b5cf6,#6d28d9);color:#fff;padding:9px 18px;border-radius:10px;font-weight:600;white-space:nowrap}
    .cta:hover{text-decoration:none;filter:brightness(1.1)}
    h1{font-size:1.9rem;margin:0 0 6px}h2{font-size:1.2rem;margin:28px 0 12px}
    .muted{color:var(--muted)}.crumbs{font-size:.85rem;color:var(--muted);margin-bottom:14px}
    .bio{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:18px 20px;margin:18px 0;max-width:760px}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:16px}
    .tile{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden}
    .tile img{width:100%;aspect-ratio:1;object-fit:cover;display:block;background:#101018}
    .tile .m{padding:8px 10px}.tile .t{font-size:.9rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .tile .a{font-size:.78rem;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    ol.tracks{list-style:none;margin:0;padding:0;max-width:760px}
    ol.tracks li{display:flex;align-items:center;gap:12px;padding:9px 10px;border-bottom:1px solid var(--border)}
    ol.tracks .n{color:var(--muted);width:22px;text-align:right;flex:none;font-size:.85rem}
    ol.tracks .name{flex:1;min-width:0}
    audio{height:32px;max-width:230px}
    .pill{display:inline-block;background:var(--card);border:1px solid var(--border);border-radius:999px;padding:6px 14px;margin:0 8px 8px 0;font-size:.85rem}
    footer{margin-top:44px;padding-top:18px;border-top:1px solid var(--border);font-size:.85rem;color:var(--muted)}
  </style>
</head>
<body>
<div class="wrap">
  <header class="site">
    <a href="/browse" aria-label="MAD — Music Africa Direct catalogue"><img src="/img/Madmusiclogonew-dark.png" alt="MAD — Music Africa Direct"></a>
    <a class="cta" href="/">▶ Open the player</a>
  </header>
  ${body}
  <footer>
    Music Africa Direct — a hundred years of South African music, digitised from the original masters and growing every week.
    <a href="/">Stream it free</a> · <a href="/browse">Browse the catalogue</a>
  </footer>
</div>
</body>
</html>`;
}

const send = (res, html, status = 200) => {
  res.status(status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Edge-cacheable: these pages change when the catalogue does (weekly-ish).
  res.setHeader('Cache-Control', 'public, max-age=600, s-maxage=86400, stale-while-revalidate=86400');
  res.send(html);
};

const notFound = (res, what) => send(res, pageShell({
  title: 'Not found — MAD Music',
  description: 'That page is not in the catalogue.',
  canonicalPath: '/browse',
  body: `<h1>Not on these shelves</h1><p class="muted">We couldn't find that ${esc(what)}. <a href="/browse">Browse the catalogue</a> instead.</p>`,
}), 404);

const albumTile = (album) => `
  <a class="tile" href="/album/${esc(album.slug)}">
    <img loading="lazy" src="${esc(resized(album.artwork))}" alt="${esc(album.title)} — ${esc(album.artist)}"
         onerror="this.onerror=null;this.src='/img/default-album.svg'">
    <div class="m"><div class="t">${esc(album.title)}</div>
    <div class="a">${esc(album.artist)}${album.year ? ' · ' + esc(album.year) : ''}</div></div>
  </a>`;

// ── /browse — crawl entry point ───────────────────────────────────────────────
router.get('/browse', async (_req, res, next) => {
  try {
    const idx = await getIndex();
    const genres = [...idx.genres.values()].sort((a, b) => b.albums - a.albums);
    const topArtists = [...idx.artists.values()]
      .sort((a, b) => b.albums.length - a.albums.length).slice(0, 60);
    const body = `
      <div class="crumbs">MAD Music · Catalogue</div>
      <h1>Browse the vault</h1>
      <p class="muted" style="max-width:720px">A hundred years of South African recording history — ${idx.artists.size.toLocaleString()} artists,
      ${idx.albums.size.toLocaleString()} albums, digitised from the original master tapes. Every track has a free preview.</p>
      <h2>Genres</h2>
      <div>${genres.map((g) => `<a class="pill" href="/genre/${esc(g.slug)}">${esc(g.name)} <span class="muted">(${g.albums})</span></a>`).join('')}</div>
      <h2>Artists with the deepest shelves</h2>
      <div>${topArtists.map((a) => `<a class="pill" href="/artist/${esc(a.slug)}">${esc(a.name)}</a>`).join('')}</div>`;
    send(res, pageShell({
      title: 'Browse South African music — MAD Music catalogue',
      description: `Explore ${idx.albums.size.toLocaleString()} South African albums across gospel, jazz, mbaqanga, maskandi, bubblegum and kwaito — streamed from the original Gallo masters.`,
      canonicalPath: '/browse',
      body,
    }));
  } catch (e) { next(e); }
});

// ── /artist/:slug ─────────────────────────────────────────────────────────────
router.get('/artist/:slug', async (req, res, next) => {
  try {
    const idx = await getIndex();
    const artist = idx.artists.get(String(req.params.slug || '').toLowerCase());
    if (!artist) return notFound(res, 'artist');
    const albums = artist.albums.map((s) => idx.albums.get(s)).filter(Boolean)
      .sort((a, b) => (a.year || '9999').localeCompare(b.year || '9999'));
    const bio = await getArtistBio(artist.name);

    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'MusicGroup',
      name: artist.name,
      url: `${ORIGIN}/artist/${artist.slug}`,
      ...(bio?.bio ? { description: bio.bio.slice(0, 500) } : {}),
      album: albums.slice(0, 50).map((a) => ({
        '@type': 'MusicAlbum', name: a.title, url: `${ORIGIN}/album/${a.slug}`,
        ...(a.year ? { datePublished: a.year } : {}),
      })),
    };
    const body = `
      <div class="crumbs"><a href="/browse">Catalogue</a> · Artist</div>
      <h1>${esc(artist.name)}</h1>
      <p class="muted">${albums.length} album${albums.length === 1 ? '' : 's'} · ${artist.tracks} tracks on MAD Music${albums[0]?.genre ? ' · ' + esc(albums[0].genre) : ''}</p>
      ${bio?.bio ? `<div class="bio">${esc(bio.bio).replace(/\n+/g, '</p><p>').replace(/^/, '<p>')}</p></div>` : ''}
      <h2>Albums</h2>
      <div class="grid">${albums.map(albumTile).join('')}</div>`;
    send(res, pageShell({
      title: `${artist.name} — albums and songs | MAD Music`,
      description: `Stream ${artist.name} on MAD Music: ${albums.length} albums from the original masters, with free previews of every track.${bio?.bio ? ' ' + bio.bio.slice(0, 100) : ''}`,
      canonicalPath: `/artist/${artist.slug}`,
      ogImage: albums.find((a) => a.artwork)?.artwork,
      jsonLd,
      body,
    }));
  } catch (e) { next(e); }
});

// ── /album/:slug ──────────────────────────────────────────────────────────────
router.get('/album/:slug', async (req, res, next) => {
  try {
    const idx = await getIndex();
    const album = idx.albums.get(String(req.params.slug || '').toLowerCase());
    if (!album) return notFound(res, 'album');

    const { data } = await pgFind([{ 'Album Title': album.title, 'Album Artist': album.artist }], { limit: 200 });
    const tracks = (data || [])
      .filter((r) => recordIsVisible(r.fieldData))
      .map((r) => ({
        recordId: r.recordId,
        name: r.fieldData['Track Name'] || '',
        artist: r.fieldData['Track Artist'] || album.artist,
        seq: parseInt(r.fieldData['Sequence Number'], 10) || 999,
        duration: r.fieldData['Duration'] || '',
      }))
      .filter((t) => t.name)
      .sort((a, b) => a.seq - b.seq);

    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'MusicAlbum',
      name: album.title,
      url: `${ORIGIN}/album/${album.slug}`,
      byArtist: { '@type': 'MusicGroup', name: album.artist, url: `${ORIGIN}/artist/${album.artistSlug}` },
      ...(album.year ? { datePublished: album.year } : {}),
      ...(album.genre ? { genre: album.genre } : {}),
      numTracks: tracks.length,
      track: tracks.slice(0, 60).map((t, i) => ({
        '@type': 'MusicRecording', name: t.name, position: i + 1,
        byArtist: { '@type': 'MusicGroup', name: t.artist },
      })),
    };
    const body = `
      <div class="crumbs"><a href="/browse">Catalogue</a> · <a href="/artist/${esc(album.artistSlug)}">${esc(album.artist)}</a> · Album</div>
      <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start">
        <img src="${esc(resized(album.artwork))}" alt="${esc(album.title)} album cover" width="240" height="240"
             style="border-radius:14px;background:#101018" onerror="this.onerror=null;this.src='/img/default-album.svg'">
        <div style="flex:1;min-width:260px">
          <h1>${esc(album.title)}</h1>
          <p class="muted"><a href="/artist/${esc(album.artistSlug)}">${esc(album.artist)}</a>${album.year ? ' · ' + esc(album.year) : ''}${album.genre ? ' · ' + esc(album.genre) : ''} · ${tracks.length} tracks</p>
          <p><a class="cta" href="/?utm_source=catalog&utm_medium=album">▶ Stream the full album free</a></p>
          ${GUEST_PREVIEW_ENABLED ? '<p class="muted" style="font-size:.85rem">Every track below has a free 30-second preview.</p>' : ''}
        </div>
      </div>
      <h2>Tracklist</h2>
      <ol class="tracks">${tracks.map((t, i) => `
        <li><span class="n">${i + 1}</span>
          <span class="name">${esc(t.name)}${t.artist !== album.artist ? ` <span class="muted">— ${esc(t.artist)}</span>` : ''}</span>
          ${GUEST_PREVIEW_ENABLED ? `<audio controls preload="none" src="/api/preview/${esc(t.recordId)}" title="Preview: ${esc(t.name)}"></audio>` : ''}
        </li>`).join('')}
      </ol>`;
    send(res, pageShell({
      title: `${album.title} — ${album.artist}${album.year ? ` (${album.year})` : ''} | MAD Music`,
      description: `Listen to ${album.title} by ${album.artist} on MAD Music — ${tracks.length} tracks${album.genre ? ` of South African ${album.genre}` : ''}, streamed from the original masters with free previews.`,
      canonicalPath: `/album/${album.slug}`,
      ogImage: album.artwork,
      jsonLd,
      body,
    }));
  } catch (e) { next(e); }
});

// ── /genre/:slug ──────────────────────────────────────────────────────────────
router.get('/genre/:slug', async (req, res, next) => {
  try {
    const idx = await getIndex();
    const genre = idx.genres.get(String(req.params.slug || '').toLowerCase());
    if (!genre) return notFound(res, 'genre');
    const albums = [...idx.albums.values()]
      .filter((a) => slugify(a.genre) === genre.slug)
      .sort((a, b) => (b.year || '').localeCompare(a.year || ''));
    const artistCounts = new Map();
    for (const a of albums) artistCounts.set(a.artistSlug, (artistCounts.get(a.artistSlug) || 0) + 1);
    const topArtists = [...artistCounts.entries()]
      .sort((x, y) => y[1] - x[1]).slice(0, 24)
      .map(([slug]) => idx.artists.get(slug)).filter(Boolean);

    const body = `
      <div class="crumbs"><a href="/browse">Catalogue</a> · Genre</div>
      <h1>${esc(genre.name)}</h1>
      <p class="muted" style="max-width:720px">${albums.length} ${esc(genre.name)} albums in the MAD vault — South African recordings digitised from the original masters, every track with a free preview.</p>
      <h2>Artists</h2>
      <div>${topArtists.map((a) => `<a class="pill" href="/artist/${esc(a.slug)}">${esc(a.name)}</a>`).join('')}</div>
      <h2>Albums</h2>
      <div class="grid">${albums.slice(0, 96).map(albumTile).join('')}</div>`;
    send(res, pageShell({
      title: `${genre.name} — South African ${genre.name} albums | MAD Music`,
      description: `${albums.length} ${genre.name} albums from a hundred years of South African music, streamed from the original masters on MAD Music.`,
      canonicalPath: `/genre/${genre.slug}`,
      body,
    }));
  } catch (e) { next(e); }
});

export default router;
