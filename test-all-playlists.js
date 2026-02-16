import { fetch } from 'undici';

const baseUrl = 'http://localhost:3000';

// Get all playlists
const playlistsResp = await fetch(`${baseUrl}/api/public-playlists`);
const playlistsData = await playlistsResp.json();

console.log('Testing all public playlists...\n');

for (const playlist of playlistsData.playlists) {
  console.log(`📁 ${playlist.name}`);
  console.log(`   Albums: ${playlist.albumCount}, Tracks: ${playlist.trackCount}`);

  // Get tracks for this playlist
  const tracksResp = await fetch(`${baseUrl}/api/public-playlists?name=${encodeURIComponent(playlist.name)}`);
  const tracksData = await tracksResp.json();

  const tracks = tracksData.tracks || [];
  console.log(`   API returned: ${tracks.length} tracks`);

  if (tracks.length > 0) {
    console.log(`   ✓ First track: "${tracks[0].name}" by ${tracks[0].trackArtist}`);
  } else {
    console.log(`   ❌ No tracks returned!`);
  }
  console.log('');
}

console.log('Done.');
