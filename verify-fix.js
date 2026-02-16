import { fetch } from 'undici';

console.log('Testing if hasValidAudio field is present...\n');

// Wait for server to be ready
await new Promise(resolve => setTimeout(resolve, 2000));

try {
  const response = await fetch('http://localhost:3000/api/public-playlists?name=A%20Walk%20in%20the%20Park');
  const data = await response.json();

  const tracks = data.tracks || [];

  console.log(`✓ API returned ${tracks.length} tracks for "A Walk in the Park"`);

  if (tracks.length > 0) {
    const firstTrack = tracks[0];
    console.log(`\nFirst track:`);
    console.log(`  Name: ${firstTrack.name}`);
    console.log(`  Artist: ${firstTrack.trackArtist}`);
    console.log(`  hasValidAudio: ${firstTrack.hasValidAudio}`);
    console.log(`  resolvedSrc: ${firstTrack.resolvedSrc ? 'Present' : 'Missing'}`);

    const allHaveFlag = tracks.every(t => t.hasValidAudio === true);
    console.log(`\n${allHaveFlag ? '✓' : '✗'} All tracks have hasValidAudio=true: ${allHaveFlag}`);
  } else {
    console.log('\n❌ No tracks returned! This is the problem.');
  }
} catch (err) {
  console.error('Error:', err.message);
  console.log('\nMake sure the server is running on port 3000');
}
