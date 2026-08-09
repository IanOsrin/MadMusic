// MAD Music → YouTube video generator (art-tracks + Shorts).
//
// Turns catalogue tracks into upload-ready videos using only owned assets:
// S3 artwork + S3 audio + FileMaker metadata. Two formats:
//   art-track — 1920×1080: ambient-blur sleeve background (the site's banner
//               treatment), sharp sleeve left, title/artist/year right, live
//               waveform strip, catalogue watermark. Full track by default;
//               --excerpt N clips to N seconds (rights call).
//   short     — 1080×1920 vertical, 30 s (offset --short-offset, default 30 s
//               in, so Shorts skip intros), same visual language + site CTA.
// Every video gets a .txt sidecar: suggested YouTube title, description with
// the track's share link (musicafricadirect.com/?t=<recordId>), and tags.
//
// Usage (from the project root, .env supplies FM_*):
//   node --env-file=.env scripts/youtube/generate-videos.mjs \
//     --tracks 49354,114898 --shorts 49354 [--out DIR] [--excerpt 60]
//
// Requires ffmpeg on PATH. Outputs default to ~/Downloads/mad-youtube-pilot/.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Text is rendered to a transparent PNG via macOS AppKit (render-overlay.jxa.js)
// and composited by ffmpeg — the Homebrew ffmpeg build has no drawtext filter.
const OVERLAY_RENDERER = new URL('./render-overlay.jxa.js', import.meta.url).pathname;
// YouTube content is public: links must ALWAYS point at prod. Never inherit
// APP_URL — the local .env sets it to localhost for payment testing, which
// put localhost links into uploaded video descriptions once.
const SITE = (process.env.YT_SITE_URL || 'https://musicafricadirect.com').replace(/\/+$/, '');

// ── args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const opt = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const TRACKS = opt('tracks').split(',').map((s) => s.trim()).filter(Boolean);
const SHORTS = opt('shorts').split(',').map((s) => s.trim()).filter(Boolean);
const OUT = opt('out', join(homedir(), 'Downloads', 'mad-youtube-pilot'));
const EXCERPT = parseInt(opt('excerpt', '0'), 10) || 0;   // 0 = full track
const SHORT_LEN = parseInt(opt('short-len', '30'), 10) || 30;
const SHORT_OFFSET = parseInt(opt('short-offset', '30'), 10) || 30;
// --meta-only: rewrite the .txt sidecars without re-rendering any video
// (e.g. after fixing description templates/links).
const META_ONLY = args.includes('--meta-only');
if (!TRACKS.length && !SHORTS.length) {
  console.error('No tracks given. --tracks id,id[,…] and/or --shorts id[,…]');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

// ── FileMaker metadata (read-only, by recordId) ──────────────────────────────
const fmBase = `${process.env.FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(process.env.FM_DB)}`;
let fmToken = null;
async function fmLogin() {
  const res = await fetch(`${fmBase}/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + Buffer.from(`${process.env.FM_USER}:${process.env.FM_PASS}`).toString('base64')
    },
    body: '{}'
  });
  const data = await res.json();
  if (!res.ok) throw new Error('FM login failed');
  return data.response.token;
}
async function getTrack(recordId) {
  let res = await fetchRetry(`${fmBase}/layouts/${encodeURIComponent(process.env.FM_LAYOUT)}/records/${recordId}`, {
    headers: { Authorization: `Bearer ${fmToken}` }
  });
  if (res.status === 401) { // FM session expired mid-batch (long encodes) — re-login once
    fmToken = await fmLogin();
    res = await fetchRetry(`${fmBase}/layouts/${encodeURIComponent(process.env.FM_LAYOUT)}/records/${recordId}`, {
      headers: { Authorization: `Bearer ${fmToken}` }
    });
  }
  const data = await res.json();
  const f = data.response?.data?.[0]?.fieldData;
  if (!f) return null;
  const pick = (...names) => names.map((n) => String(f[n] ?? '').trim()).find(Boolean) || '';
  return {
    recordId,
    title:  pick('Track Name', 'Tape Files::Track Name'),
    artist: pick('Track Artist', 'Tape Files::Track Artist'),
    album:  pick('Album Title', 'Tape Files::Album Title'),
    year:   pick('Year of Release'),
    genre:  pick('Genre', 'Local Genre'),
    pLine:  pick('pLine'),
    catalogue: pick('Album Catalogue Number', 'Reference Catalogue Number'),
    audioUrl: pick('S3_URL'),
    artUrl:   pick('Artwork_S3_URL', 'Tape Files::Artwork_S3_URL')
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

function renderOverlayPng(spec) {
  execFileSync('osascript', ['-l', 'JavaScript', OVERLAY_RENDERER, JSON.stringify(spec)], { stdio: 'ignore' });
  return spec.out;
}

// Transient-tolerant fetch: fmcloud/S3 occasionally drop a connection mid-run.
async function fetchRetry(url, opts, tries = 3) {
  for (let i = 0; ; i++) {
    try {
      return await fetch(url, opts);
    } catch (err) {
      if (i >= tries - 1) throw err;
      console.warn(`  retry ${i + 1}/${tries - 1} after fetch failure: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

async function download(url, dest) {
  if (existsSync(dest)) return dest;
  const res = await fetchRetry(url);
  if (!res.ok) throw new Error(`download ${res.status}: ${url}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

function ffmpeg(argv) {
  execFileSync('ffmpeg', ['-hidden_banner', ...argv].filter((a) => a !== '-hidden_banner'), {
    stdio: ['ignore', 'ignore', 'inherit']
  });
}

function sidecar(t, file, kind) {
  const shareUrl = `${SITE}/?t=${t.recordId}`;
  const lines = [
    `SUGGESTED TITLE:`,
    `${t.artist} – ${t.title}${t.year ? ` (${t.year})` : ''}${kind === 'short' ? ' #Shorts' : ''}`,
    ``,
    `DESCRIPTION:`,
    `${t.title} by ${t.artist}${t.album ? ` — from the album "${t.album}"` : ''}${t.year ? ` (${t.year})` : ''}.`,
    ``,
    `▶ Listen on MAD Music: ${shareUrl}`,
    `Stream African music — classics and new releases: ${SITE}`,
    ``,
    t.pLine || '',
    ``,
    `TAGS:`,
    [t.artist, t.title, t.genre, 'South African music', 'African music', 'MAD Music', t.year]
      .filter(Boolean).join(', ')
  ];
  writeFileSync(file, lines.join('\n'));
}

// ── renderers ────────────────────────────────────────────────────────────────
function renderArtTrack(t, art, audio, out) {
  const durationArgs = EXCERPT > 0 ? ['-t', String(EXCERPT)] : [];
  const meta = [t.year, t.genre].filter(Boolean).join('   ·   ');
  const overlay = renderOverlayPng({
    width: 1920, height: 1080, out: out.replace(/\.mp4$/, '.overlay.png'),
    items: [
      { text: t.title, font: 'Arial-BoldMT', size: 66, x: 980, y: 380 },
      { text: t.artist, font: 'ArialMT', size: 46, alpha: 0.92, x: 980, y: 486 },
      ...(meta ? [{ text: meta, font: 'ArialMT', size: 32, alpha: 0.6, x: 980, y: 566 }] : []),
      // Watermark → call to action: the link under the video is invisible while
      // watching; this is the one placement every viewer sees for the whole song.
      { text: 'Hear the full album and more at', font: 'ArialMT', size: 34, alpha: 0.85, x: 1860, y: 52, align: 'right' },
      { text: 'musicafricadirect.com', font: 'Arial-BoldMT', size: 42, alpha: 0.95, x: 1860, y: 96, align: 'right' }
    ]
  });
  const filter = [
    // ambient-blur background from the sleeve (never stretched art — blurred fill)
    `[1:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,gblur=sigma=40,eq=brightness=-0.25[bg]`,
    // sharp sleeve, left
    `[1:v]scale=760:760[sleeve]`,
    `[bg][sleeve]overlay=140:160[v1]`,
    // waveform strip along the bottom
    `[0:a]showwaves=s=1640x110:mode=cline:rate=25:colors=white@0.45[waves]`,
    `[v1][waves]overlay=140:930[v2]`,
    // pre-rendered text overlay (AppKit PNG — see OVERLAY_RENDERER)
    `[v2][2:v]overlay=0:0[vout]`
  ].join(';');

  ffmpeg([
    '-y', '-i', audio, '-loop', '1', '-i', art, '-i', overlay,
    '-filter_complex', filter, '-map', '[vout]', '-map', '0:a',
    ...durationArgs, '-shortest',
    '-c:v', 'libx264', '-preset', 'medium', '-tune', 'stillimage', '-crf', '19', '-r', '25', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart', out
  ]);
}

function renderShort(t, art, audio, out) {
  const overlay = renderOverlayPng({
    width: 1080, height: 1920, out: out.replace(/\.mp4$/, '.overlay.png'),
    items: [
      { text: t.title, font: 'Arial-BoldMT', size: 64, align: 'center', x: 0, y: 1260 },
      { text: t.artist, font: 'ArialMT', size: 46, alpha: 0.92, align: 'center', x: 0, y: 1364 },
      { text: 'Hear the full album and more at', font: 'ArialMT', size: 36, alpha: 0.85, align: 'center', x: 0, y: 1700 },
      { text: 'musicafricadirect.com', font: 'Arial-BoldMT', size: 46, align: 'center', x: 0, y: 1748 }
    ]
  });
  const filter = [
    `[1:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=45,eq=brightness=-0.25[bg]`,
    `[1:v]scale=880:880[sleeve]`,
    `[bg][sleeve]overlay=100:290[v1]`,
    `[0:a]showwaves=s=880x100:mode=cline:rate=25:colors=white@0.45[waves]`,
    `[v1][waves]overlay=100:1560[v2]`,
    `[v2][2:v]overlay=0:0[vout]`
  ].join(';');

  ffmpeg([
    '-y', '-ss', String(SHORT_OFFSET), '-i', audio, '-loop', '1', '-i', art, '-i', overlay,
    '-filter_complex', filter, '-map', '[vout]', '-map', '0:a',
    '-t', String(SHORT_LEN), '-shortest',
    '-af', `afade=t=in:d=0.8,afade=t=out:st=${SHORT_LEN - 1}:d=1`,
    '-c:v', 'libx264', '-preset', 'medium', '-tune', 'stillimage', '-crf', '19', '-r', '25', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart', out
  ]);
}

// ── main ─────────────────────────────────────────────────────────────────────
fmToken = await fmLogin();
try {
  const all = [...new Set([...TRACKS, ...SHORTS])];
  const failed = [];
  for (const rid of all) {
    try {
    const t = await getTrack(rid);
    if (!t || !t.audioUrl || !t.artUrl) {
      console.warn(`SKIP ${rid}: missing metadata/audio/artwork`);
      continue;
    }
    const base = `${slug(t.artist)}--${slug(t.title)}`;
    console.log(`\n${t.artist} – ${t.title} (${t.year || '?'})`);
    if (META_ONLY) {
      if (TRACKS.includes(rid)) sidecar(t, join(OUT, `${base}--arttrack.txt`), 'arttrack');
      if (SHORTS.includes(rid)) sidecar(t, join(OUT, `${base}--short.txt`), 'short');
      console.log('  sidecars rewritten (meta-only)');
      continue;
    }
    const art = await download(t.artUrl, join(OUT, `${base}.art${t.artUrl.includes('.webp') ? '.webp' : '.jpg'}`));
    const audio = await download(t.audioUrl, join(OUT, `${base}.mp3`));

    if (TRACKS.includes(rid)) {
      const out = join(OUT, `${base}--arttrack.mp4`);
      console.log(`  art-track → ${out}`);
      renderArtTrack(t, art, audio, out);
      sidecar(t, join(OUT, `${base}--arttrack.txt`), 'arttrack');
    }
    if (SHORTS.includes(rid)) {
      const out = join(OUT, `${base}--short.mp4`);
      console.log(`  short     → ${out}`);
      renderShort(t, art, audio, out);
      sidecar(t, join(OUT, `${base}--short.txt`), 'short');
    }
    } catch (err) {
      console.error(`FAILED ${rid}: ${err.message}`);
      failed.push(rid);
    }
  }
  console.log(`\nDone. Videos + metadata sidecars in ${OUT}`);
  if (failed.length) console.log(`FAILED (re-run with --tracks/--shorts ${failed.join(',')}): ${failed.length}`);
} finally {
  await fetch(`${fmBase}/sessions/${fmToken}`, { method: 'DELETE' }).catch(() => {});
}
