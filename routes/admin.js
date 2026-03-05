import { Router } from 'express';
import { searchCache, exploreCache, albumCache, publicPlaylistsCache, trendingCache } from '../cache.js';

const router = Router();

const SERVER_START_TIME = Date.now();

router.get('/health', (req, res) => {
  const uptimeMs = Date.now() - SERVER_START_TIME;
  const uptimeSec = Math.floor(uptimeMs / 1000);
  res.json({
    status: 'ok',
    uptime: uptimeSec,
    timestamp: new Date().toISOString()
  });
});

router.get('/cache/stats', (req, res) => {
  try {
    const stats = {
      search: searchCache.getStats(),
      explore: exploreCache.getStats(),
      album: albumCache.getStats(),
      publicPlaylists: publicPlaylistsCache.getStats(),
      timestamp: new Date().toISOString()
    };
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve cache stats' });
  }
});

export default router;
