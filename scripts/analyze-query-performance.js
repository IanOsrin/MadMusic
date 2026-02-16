#!/usr/bin/env node

/**
 * FileMaker Query Performance Analyzer
 *
 * This script helps identify which queries are slow and need indexing
 * Run: node scripts/analyze-query-performance.js
 */

import { searchCache, albumCache, exploreCache } from '../cache.js';

console.log('╔════════════════════════════════════════════════════════════════╗');
console.log('║       MASS FileMaker Query Performance Analyzer               ║');
console.log('╚════════════════════════════════════════════════════════════════╝\n');

// Get cache statistics
console.log('📊 Cache Statistics (Higher hit rate = better performance)\n');

console.log('Search Cache:');
console.log(`  - Size: ${searchCache.size} / ${searchCache.max} entries`);
console.log(`  - TTL: ${searchCache.ttl / 1000 / 60} minutes`);
console.log(`  - Estimated hit rate: Check server logs for [CACHE HIT] vs [CACHE MISS]\n`);

console.log('Album Cache:');
console.log(`  - Size: ${albumCache.size} / ${albumCache.max} entries`);
console.log(`  - TTL: ${albumCache.ttl / 1000 / 60} minutes\n`);

console.log('Explore Cache:');
console.log(`  - Size: ${exploreCache.size} / ${exploreCache.max} entries`);
console.log(`  - TTL: ${exploreCache.ttl / 1000 / 60} minutes\n`);

console.log('═══════════════════════════════════════════════════════════════\n');

console.log('🔍 Fields That Should Be Indexed in FileMaker:\n');

const criticalIndexes = [
  { field: 'Album Artist', priority: '🔥 CRITICAL', impact: '5-10x faster searches' },
  { field: 'Album Title', priority: '🔥 CRITICAL', impact: '5-10x faster searches' },
  { field: 'Track Name', priority: '🔥 CRITICAL', impact: '5-10x faster searches' },
  { field: 'Track Artist', priority: '🔥 CRITICAL', impact: '3-5x faster searches' },
  { field: 'Local Genre', priority: '⚡ HIGH', impact: '4-8x faster genre searches' },
  { field: 'Genre', priority: '⚡ HIGH', impact: '4-8x faster genre searches' },
  { field: 'Visibility', priority: '⚡ HIGH', impact: '2-3x faster overall' },
  { field: 'Featured', priority: '📊 MEDIUM', impact: '2x faster featured albums' },
  { field: 'Album Catalogue Number', priority: '📁 MEDIUM', impact: '2-3x faster album loads' },
  { field: 'TimestampUTC', priority: '📈 LOW', impact: 'Faster trending (cached 24h)' }
];

criticalIndexes.forEach(({ field, priority, impact }) => {
  console.log(`${priority}  ${field.padEnd(30)} → ${impact}`);
});

console.log('\n═══════════════════════════════════════════════════════════════\n');

console.log('📝 How to Check/Enable Indexing:\n');
console.log('1. Open FileMaker Pro');
console.log('2. Go to File → Manage → Database (Cmd+Shift+D)');
console.log('3. Click Fields tab');
console.log('4. For each field above:');
console.log('   • Select the field');
console.log('   • Click Options button');
console.log('   • Go to Storage tab');
console.log('   • Check "Automatically create indexes when needed"');
console.log('   • Click OK\n');

console.log('5. After indexing, restart your MASS server and test:\n');
console.log('   npm run start:single\n');

console.log('═══════════════════════════════════════════════════════════════\n');

console.log('🧪 Performance Test Commands:\n');
console.log('Test search speed:');
console.log('  curl "http://127.0.0.1:3000/api/search?artist=Beatles&limit=10"\n');

console.log('Test genre search speed:');
console.log('  curl "http://127.0.0.1:3000/api/search?genre=Rock&limit=25"\n');

console.log('Test album lookup:');
console.log('  curl "http://127.0.0.1:3000/api/album?title=Abbey%20Road&artist=Beatles"\n');

console.log('Watch server logs for timing:');
console.log('  Look for "[CACHE MISS] search - querying FileMaker..."');
console.log('  Compare before/after indexing\n');

console.log('═══════════════════════════════════════════════════════════════\n');

console.log('💡 Expected Results:\n');
console.log('BEFORE indexing:  [SEARCH] Query took 5000-15000ms');
console.log('AFTER indexing:   [SEARCH] Query took 100-500ms\n');

console.log('📋 Full checklist available in:');
console.log('   scripts/FILEMAKER_INDEX_CHECKLIST.md\n');

// Check if running in production
if (process.env.NODE_ENV === 'production') {
  console.log('⚠️  WARNING: Running in PRODUCTION mode');
  console.log('   Make sure to test indexing changes on staging first!\n');
}

console.log('✅ Analysis complete!\n');
