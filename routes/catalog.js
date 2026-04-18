// routes/catalog.js — thin index: mounts catalog sub-routers.
// Each sub-router owns its helpers, caches, and route handlers.
//
//   search.js    → /wake, /search, /explore, /ai-search
//   trending.js  → /trending, /my-stats
//   featured.js  → /featured-albums, /releases/latest, /new-releases
//   discovery.js → /random-songs, /public-playlists, /album, /missing-audio-songs
//   genres.js    → /genres
import { Router } from 'express';
import searchRouter    from './catalog/search.js';
import trendingRouter  from './catalog/trending.js';
import featuredRouter  from './catalog/featured.js';
import discoveryRouter from './catalog/discovery.js';
import genresRouter    from './catalog/genres.js';

const router = Router();

router.use('/', searchRouter);
router.use('/', trendingRouter);
router.use('/', featuredRouter);
router.use('/', discoveryRouter);
router.use('/', genresRouter);

export default router;
