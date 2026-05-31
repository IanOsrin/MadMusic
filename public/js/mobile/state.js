// Shared mutable app state + cached DOM element refs for the mobile app.
// Imported as live bindings by the other mobile modules, so mutations to
// `state` are seen everywhere. `elements` resolves at module-eval time, which
// is safe because the graph loads via <script type="module"> (deferred until
// the DOM is parsed).

export const state = {
  currentUser: null,
  currentTab: 'newreleases',
  selectedGenre: 'All',
  selectedDecade: null, // { label: '1970s', start: 1970 } or null
  playlists: [],
  featuredPlaylists: [],
  trendingTracks: [],
  randomTracks: [],
  newReleaseTracks: [],
  newReleasesLoaded: false,
  g100Tracks: [],
  g100Albums: [],        // deduplicated album objects
  g100Loaded: false,
  g100Playlists: [],
  g100PlaylistsLoaded: false,
  searchResults: [],
  currentTrack: null,
  playlistContext: null,
  discoverAlbumCache: new Map(), // albumKey → full album object (fetched from /api/album)
  streamSessionId: null,
  lastProgressUpdate: 0,
  playerBubble: {
    visible: false,
    position: { x: 0, y: 0 }
  },
  playerModal: {
    visible: false
  }
};

export const elements = {
  audio: document.getElementById('audio'),
  floatingPlayer: document.getElementById('floating-player'),
  playerModal: document.getElementById('player-modal'),
  userBadge: document.getElementById('user-badge'),
  newReleasesContent: document.getElementById('newreleases-content'),
  g100Content: document.getElementById('g100-content'),
  g100PlaylistsContent: document.getElementById('g100-playlists-content'),
  discoverContent: document.getElementById('discover-content'),
  searchInput: document.getElementById('search-input'),
  searchResults: document.getElementById('search-results'),
  playlistsContent: document.getElementById('playlists-content'),
  modalOverlay: document.getElementById('modal-overlay'),
  bottomSheet: document.getElementById('bottom-sheet'),
  toastContainer: document.getElementById('toast-container')
};
