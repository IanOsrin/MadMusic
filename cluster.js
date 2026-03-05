import cluster from 'node:cluster';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const numCPUs = os.cpus().length;
const MAX_WORKERS = parseInt(process.env.MAX_WORKERS || '0', 10) || Math.min(numCPUs, 4);

if (cluster.isPrimary) {
  console.log(`[CLUSTER] Primary process ${process.pid} is running`);
  console.log(`[CLUSTER] Starting ${MAX_WORKERS} workers (${numCPUs} CPUs available)`);

  // Fork workers
  for (let i = 0; i < MAX_WORKERS; i++) {
    cluster.fork();
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
