import cluster from 'node:cluster';
import os from 'node:os';

const numCPUs = os.cpus().length;
// Default to 1 worker. The Render Starter tier we run on is 0.5 CPU / 512 MB —
// extra workers don't add throughput (they share half a core) but they DO
// multiply the per-process memory footprint (LRU caches, FM token, sqlite
// connection, express middleware) and push us into OOM-kill territory.
// On a beefier tier set MAX_WORKERS via env var to override.
const MAX_WORKERS = Number.parseInt(process.env.MAX_WORKERS || '0', 10) || 1;

if (cluster.isPrimary) {
  console.log(`[CLUSTER] Primary process ${process.pid} is running`);
  console.log(`[CLUSTER] Starting ${MAX_WORKERS} workers (${numCPUs} CPUs available)`);

  if (MAX_WORKERS > 1) {
    // Stream-event tracking keeps per-process state (streamTotalMap, the
    // stream-record LRU, and the concurrent-create dedup map in
    // lib/stream-events.js). With multiple workers, events for one play can
    // land on different workers and fragment records / reset totals. Make
    // that state shared (Redis/FM-only) BEFORE scaling workers.
    console.warn('[CLUSTER] ⚠️  MAX_WORKERS > 1: stream-event accumulators are per-process — play tracking will fragment across workers. See lib/stream-events.js.');
  }

  // Fork workers with a staggered delay so they don't all hammer FileMaker
  // at the same instant during startup (avoids FM request queue bursts).
  for (let i = 0; i < MAX_WORKERS; i++) {
    setTimeout(() => cluster.fork({ WORKER_INDEX: String(i) }), i * 1500);
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`[CLUSTER] Worker ${worker.process.pid} died (${signal || code}). Restarting...`);
    cluster.fork();
  });

  cluster.on('online', (worker) => {
    console.log(`[CLUSTER] Worker ${worker.process.pid} started`);
  });
} else {
  // Workers share the TCP connection
  await import('./server.js');
  console.log(`[CLUSTER] Worker ${process.pid} serving requests`);
}
