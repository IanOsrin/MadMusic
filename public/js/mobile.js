    // ===== Fetch Interceptor for Access Token =====
    // This must run FIRST to intercept all API calls
    (function() {
      const originalFetch = window.fetch;

      window.fetch = function(url, options = {}) {
        const isApiCall = url.includes('/api/') || url.startsWith('/api/');

        if (isApiCall) {
          const accessToken = localStorage.getItem('mass_access_token');

          if (accessToken) {
            // Initialize headers if not present
            if (!options.headers) {
              options.headers = {};
            }

            // Add access token header
            if (options.headers instanceof Headers) {
              options.headers.set('X-Access-Token', accessToken);
            } else if (typeof options.headers === 'object') {
              options.headers['X-Access-Token'] = accessToken;
            }
          }
        }

        // Call original fetch
        return originalFetch(url, options);
      };
    })();

    // ===== Genre List =====
    const GENRES = [
      "All",
      "40's",
      "50's",
      "60's",
      "70's",
      "80'",
      "90's",
      "Acapella",
      "Acoustic",
      "Accordian",
      "Adult",
      "Adult Contemporary",
      "Adult Contemporary (Singer/Songwriter)",
      "African",
      "African Dancehall",
      "African Jazz",
      "Afrikaans",
      "Afro Acid Beat",
      "Afro Beat",
      "Afro Dancehall",
      "Afro-Folk",
      "Afro Fusion",
      "Afro Gqom",
      "Afro House",
      "Afro Jazz",
      "Afro Pop",
      "Afro-Pop",
      "Afro Rock",
      "Afro Soul",
      "Afro Tech",
      "Afro Zouk",
      "Alternative",
      "Alternative Rock",
      "Amapiano",
      "Ambient",
      "Animation",
      "Anthem",
      "Basotho Traditional",
      "Big Band",
      "Blues",
      "BoereMusiek",
      "Bubblegum",
      "Children",
      "Childrens Music",
      "Chillout",
      "Choral",
      "Choir",
      "Christian",
      "Christmas",
      "Classic Lounge",
      "Classic Rock",
      "Classical",
      "Club Dance",
      "Comedy",
      "Cool Jazz",
      "Country",
      "Country (Contemporary)",
      "Country (Traditional)",
      "Cultural",
      "Dance",
      "Dancehall",
      "Deep House",
      "Disco",
      "Diwali",
      "Drama",
      "Dub Step",
      "Dubstep",
      "Easy Listening",
      "EDM",
      "Electro",
      "Electro House",
      "Electro Pop",
      "Electro Rock",
      "Electronic",
      "Electronic Dance",
      "Folk",
      "Folk (Singer/Songwriter)",
      "Free Jazz",
      "French Pop",
      "Funk",
      "Fusion",
      "Garage",
      "General",
      "Genetone",
      "Ghetto Zouk",
      "Gospel",
      "Gospel Jazz",
      "Gqom",
      "Halloween",
      "Hard Rock",
      "High Life",
      "Hip Hop",
      "Hip Hop Instrumental",
      "Holiday",
      "House",
      "Hymn",
      "Indie",
      "Indie Dance",
      "Indie Folk",
      "Indie Rock",
      "Inspirational",
      "Instrumental",
      "Islamic",
      "Is'cathamiya",
      "Jazz",
      "Jazz (Contemporary)",
      "Jazz (Traditional)",
      "Jazz Fusion",
      "K Pop",
      "Kalifah AgaNaga",
      "Karahanyuze",
      "Karaoke",
      "Kids",
      "Kizomba",
      "Kuduro",
      "Kwaito",
      "Kwela",
      "Latin",
      "Latin Music",
      "Live",
      "Lounge",
      "Mambo",
      "Marabi",
      "Mancala",
      "Maskandi",
      "Mbhaqanga",
      "Meaning Tunes",
      "Mgqashiyo",
      "Modern Classical",
      "Motswako",
      "Music Feature Films",
      "Musicals",
      "MX Funk",
      "Name Tune",
      "New Age",
      "New Age Kwaito",
      "New Wave",
      "Ndebele Traditional",
      "Nujazz",
      "Oldies",
      "Other",
      "Podcast",
      "Pop",
      "Pop (Singer/Songwriter)",
      "Pop Rock",
      "Progressive Punk",
      "Progressive Rock",
      "Psych Rock",
      "Rap",
      "Reggae",
      "Reggaeton",
      "Religious",
      "Rhumba",
      "RnB",
      "Rock",
      "Rockabilly",
      "Salsa",
      "Samba",
      "Sax Jive",
      "Sega",
      "Shangaani",
      "Shangaan Disco",
      "Singer/Songwriter",
      "Soukous",
      "Soul",
      "Soulful House",
      "Soundtrack",
      "Spiritual",
      "Spoken Word",
      "Swing Music",
      "Tango",
      "Tech House",
      "Township Jive",
      "Traditional",
      "Trance",
      "Trap",
      "TrapSoul",
      "Tsonga Disco",
      "Tsonga Traditional",
      "Twist",
      "Urban",
      "Vocal",
      "Volksmusik",
      "World Music",
      "Zouk"
    ];

    // ===== Global State =====
    const state = {
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

    // ===== DOM Elements =====
    const elements = {
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

    // ===== Utility Functions =====
    function showToast(message, type = 'success') {
      const toast = document.createElement('div');
      toast.className = `toast ${type}`;
      toast.textContent = message;
      elements.toastContainer.appendChild(toast);
      setTimeout(() => toast.remove(), 3000);
    }

    function formatTime(seconds) {
      if (!seconds || isNaN(seconds)) return '0:00';
      const mins = Math.floor(seconds / 60);
      const secs = Math.floor(seconds % 60);
      return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    function generateSessionId() {
      return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    // ===== Tab Navigation =====
    document.querySelectorAll('.tab-button').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        switchTab(tab);
      });
    });

    function switchTab(tabName) {
      const wasAlreadyActive = state.currentTab === tabName;
      state.currentTab = tabName;

      // Update tab buttons
      document.querySelectorAll('.tab-button').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabName);
      });

      // Update tab content
      document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.toggle('active', content.id === `${tabName}-tab`);
      });

      // Load data if needed
      if (tabName === 'newreleases') {
        if (wasAlreadyActive || !state.newReleasesLoaded) {
          loadNewReleases(wasAlreadyActive);
        }
      } else if (tabName === 'g100') {
        if (!state.g100Loaded || wasAlreadyActive) loadG100(wasAlreadyActive);
        if (!state.g100PlaylistsLoaded) loadG100Playlists();
      } else if (tabName === 'discover') {
        // Refresh if tapping active tab, genre is selected, or first load
        if (wasAlreadyActive || state.selectedGenre !== 'All' || state.randomTracks.length === 0) {
          loadDiscover();
        }
      } else if (tabName === 'genres') {
        renderGenres();
      } else if (tabName === 'decades') {
        renderDecades();
      } else if (tabName === 'playlists' && state.currentUser && state.playlists.length === 0) {
        loadPlaylists();
      }
    }

    // ===== Genres =====
    function renderGenres() {
      const container = document.getElementById('genres-content');
      container.innerHTML = '';

      GENRES.forEach(genre => {
        const btn = document.createElement('button');
        btn.className = 'genre-btn';
        btn.textContent = genre;
        if (state.selectedGenre === genre) {
          btn.classList.add('active');
        }
        btn.addEventListener('click', () => selectGenre(genre));
        container.appendChild(btn);
      });
    }

    window.selectGenre = function(genre) {
      state.selectedGenre = genre;
      renderGenres();

      // Switch to discover tab and filter
      switchTab('discover');
      loadDiscover();
    };

    function getGenreField(fields) {
      return window.MADHelpers.getGenreField(fields);
    }

    // ===== Decades =====
    const DECADES = [
      { label: '1950s', start: 1950 },
      { label: '1960s', start: 1960 },
      { label: '1970s', start: 1970 },
      { label: '1980s', start: 1980 },
      { label: '1990s', start: 1990 },
      { label: '2000s', start: 2000 },
      { label: '2010s', start: 2010 },
      { label: '2020s', start: 2020 }
    ];

    function renderDecades() {
      const container = document.getElementById('decades-content');
      container.innerHTML = '';

      // Add "All Decades" button
      const allBtn = document.createElement('button');
      allBtn.className = 'genre-btn';
      allBtn.textContent = 'All Decades';
      if (!state.selectedDecade) {
        allBtn.classList.add('active');
      }
      allBtn.addEventListener('click', () => selectDecade(null));
      container.appendChild(allBtn);

      // Add decade buttons
      DECADES.forEach(decade => {
        const btn = document.createElement('button');
        btn.className = 'genre-btn'; // Reusing genre-btn styles
        btn.textContent = decade.label;
        if (state.selectedDecade && state.selectedDecade.start === decade.start) {
          btn.classList.add('active');
        }
        btn.addEventListener('click', () => selectDecade(decade.start));
        container.appendChild(btn);
      });
    }

    function selectDecade(startYear) {
      if (startYear === null) {
        state.selectedDecade = null;
      } else {
        const decade = DECADES.find(d => d.start === startYear);
        state.selectedDecade = decade;
      }
      renderDecades();

      // Switch to discover tab and load with both filters
      switchTab('discover');
      loadDiscover();
    }

    // Clear filter functions (make them global for onclick handlers)
    window.clearDecadeFilter = function() {
      state.selectedDecade = null;
      loadDiscover();
    };

    window.clearGenreFilter = function() {
      state.selectedGenre = 'All';
      loadDiscover();
    };

    window.clearAllFilters = function() {
      state.selectedDecade = null;
      state.selectedGenre = 'All';
      loadDiscover();
    };

    // ===== Access Token Authentication =====
    async function checkAuth() {
      const accessToken = localStorage.getItem('mass_access_token');
      if (!accessToken) return null;

      // Reuse the main app's session ID if present (same localStorage origin),
      // so the server doesn't reject the token as "in use on another device"
      if (!state.streamSessionId) {
        state.streamSessionId = localStorage.getItem('mass.session') || generateSessionId();
        localStorage.setItem('mass.session', state.streamSessionId);
      }

      try {
        const response = await fetch('/api/access/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: accessToken.trim().toUpperCase(), sessionId: state.streamSessionId })
        });

        const data = await response.json();
        if (response.ok && data.valid) {
          // Store token info for display
          localStorage.setItem('mass_token_info', JSON.stringify({
            type: data.type,
            expirationDate: data.expirationDate
          }));
          if (data.email) localStorage.setItem('mass_token_email', data.email);
          return { email: data.email || 'Token User', tokenType: data.type, expirationDate: data.expirationDate };
        } else {
          // Token invalid/expired — clear it
          localStorage.removeItem('mass_access_token');
          localStorage.removeItem('mass_token_info');
          localStorage.removeItem('mass_token_email');
          return null;
        }
      } catch (err) {
        console.error('Token validation failed', err);
        // Keep token for retry, use cached info if available
        const email = localStorage.getItem('mass_token_email');
        return email ? { email } : null;
      }
    }

    function logout() {
      localStorage.removeItem('mass_access_token');
      localStorage.removeItem('mass_token_info');
      localStorage.removeItem('mass_token_email');
      state.currentUser = null;
      state.playlists = [];
      updateAuthUI();
      showToast('Logged out');
      window.location.reload();
    }

    function updateAuthUI() {
      const tokenStatus = document.getElementById('token-status');
      const tokenEmail = document.getElementById('token-email');
      const tokenExpiry = document.getElementById('token-expiry');

      if (state.currentUser) {
        if (tokenEmail) tokenEmail.textContent = state.currentUser.email || '';
        if (tokenStatus) tokenStatus.textContent = 'Access Active';

        // Show expiry info
        if (tokenExpiry && state.currentUser.expirationDate) {
          const expDate = new Date(state.currentUser.expirationDate);
          const now = new Date();
          if (isNaN(expDate.getTime())) {
            tokenExpiry.textContent = '';
          } else {
            const hoursLeft = (expDate - now) / (1000 * 60 * 60);
            const daysLeft = Math.ceil(hoursLeft / 24);
            if (hoursLeft < 1) tokenExpiry.textContent = 'Token expired';
            else if (hoursLeft < 24) tokenExpiry.textContent = `Expires in ${Math.floor(hoursLeft)} hour${Math.floor(hoursLeft) !== 1 ? 's' : ''}`;
            else tokenExpiry.textContent = `Expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`;
          }
        } else if (tokenExpiry) {
          tokenExpiry.textContent = state.currentUser.tokenType === 'unlimited' ? 'Unlimited access' : '';
        }

        elements.userBadge.textContent = state.currentUser.email ? state.currentUser.email.split('@')[0] : 'Active';
      } else {
        if (tokenStatus) tokenStatus.textContent = 'No access token';
        if (tokenEmail) tokenEmail.textContent = '';
        if (tokenExpiry) tokenExpiry.textContent = '';
        elements.userBadge.textContent = 'Guest';
      }
    }

    // Profile tab event listeners
    document.getElementById('change-token-btn').addEventListener('click', () => setAccessToken());
    document.getElementById('buy-access-btn').addEventListener('click', () => buyAccess());
    document.getElementById('logout-btn').addEventListener('click', logout);

    // ===== Initialize =====
    async function init() {
      // Check URL for payment result first (redirect back from Paystack)
      const urlParams = new URLSearchParams(window.location.search);
      const paymentStatus = urlParams.get('payment');
      const paymentToken = urlParams.get('token');

      if (paymentStatus === 'success' && paymentToken) {
        console.log('[Mobile] Payment success, saving token:', paymentToken);
        localStorage.setItem('mass_access_token', paymentToken.trim().toUpperCase());
        // Clean URL then reload so the app starts a fresh session with the new token
        window.history.replaceState({}, document.title, window.location.pathname);
        showToast('Payment successful! Access activated.', 'success');
        setTimeout(() => window.location.reload(), 1500);
        return;
      } else if (paymentStatus === 'failed' || paymentStatus === 'error') {
        window.history.replaceState({}, document.title, window.location.pathname);
        showToast('Payment was not completed. Please try again.', 'error');
      } else if (paymentToken && !paymentStatus) {
        // Token passed directly from main app — save it silently
        console.log('[Mobile] Token passed from main app, saving');
        localStorage.setItem('mass_access_token', paymentToken.trim().toUpperCase());
        window.history.replaceState({}, document.title, window.location.pathname);
      }

      // Check token exists locally — no server round-trip (avoids session conflict)
      const accessToken = localStorage.getItem('mass_access_token');
      if (!accessToken) {
        elements.newReleasesContent.innerHTML = `
          <div class="empty-state">
            <div class="empty-icon">🔑</div>
            <p style="margin-bottom: 8px;"><strong>Access Token Required</strong></p>
            <p style="color: var(--text-muted); font-size: 14px; margin-bottom: 16px;">You need an access token to use MASS Mobile</p>
            <button class="btn btn-primary" onclick="setAccessToken()" style="margin-bottom: 8px;">Enter Access Token</button>
            <button class="btn btn-secondary" onclick="buyAccess()">Buy Access</button>
          </div>
        `;
        updateAuthUI();
        return;
      }

      // Token present — load app; server validates on each protected API call
      state.currentUser = { email: localStorage.getItem('mass_token_email') || '' };
      updateAuthUI();
      loadNewReleases();
      loadPlaylists();
    }

    // Function to set access token
    function setAccessToken() {
      const token = prompt('Please enter your access token:');
      if (token) {
        localStorage.setItem('mass_access_token', token);
        showToast('Access token saved! Reloading...', 'success');
        setTimeout(() => window.location.reload(), 1000);
      }
    }

    // Function to buy access via Paystack
    async function buyAccess() {
      const email = prompt('Enter your email address for the receipt:');
      if (!email || !email.includes('@')) {
        showToast('Please enter a valid email address', 'error');
        return;
      }

      showToast('Redirecting to payment...', 'success');

      try {
        const response = await fetch('/api/payments/initialize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim(), plan: '7-day', source: 'mobile' })
        });

        const data = await response.json();

        if (response.ok && data.authorization_url) {
          window.location.href = data.authorization_url;
        } else {
          showToast(data.error || 'Failed to start payment', 'error');
        }
      } catch (err) {
        console.error('[Mobile] Payment error:', err);
        showToast('Payment service unavailable', 'error');
      }
    }

    // ===== New Releases =====
    async function loadNewReleases(forceRefresh = false) {
      const container = elements.newReleasesContent;
      const btn = document.getElementById('nr-refresh-btn');
      if (btn) btn.classList.add('spinning');

      container.innerHTML = `
        <div class="nr-album-grid">
          <div class="skeleton-card skeleton" style="aspect-ratio:1;height:auto;border-radius:14px;margin:0;"></div>
          <div class="skeleton-card skeleton" style="aspect-ratio:1;height:auto;border-radius:14px;margin:0;"></div>
          <div class="skeleton-card skeleton" style="aspect-ratio:1;height:auto;border-radius:14px;margin:0;"></div>
          <div class="skeleton-card skeleton" style="aspect-ratio:1;height:auto;border-radius:14px;margin:0;"></div>
          <div class="skeleton-card skeleton" style="aspect-ratio:1;height:auto;border-radius:14px;margin:0;"></div>
          <div class="skeleton-card skeleton" style="aspect-ratio:1;height:auto;border-radius:14px;margin:0;"></div>
          <div class="skeleton-card skeleton" style="aspect-ratio:1;height:auto;border-radius:14px;margin:0;"></div>
          <div class="skeleton-card skeleton" style="aspect-ratio:1;height:auto;border-radius:14px;margin:0;"></div>
        </div>`;

      try {
        const url = '/api/new-releases?limit=60' + (forceRefresh ? '&refresh=1' : '');
        const response = await fetch(url);
        const data = await response.json();

        if (!data.ok || !data.items?.length) {
          container.innerHTML = `<div class="empty-state"><div class="empty-icon">🎵</div><p>No new releases right now — check back soon!</p></div>`;
          state.newReleasesLoaded = true;
          return;
        }

        // Group tracks into albums (same logic as discover)
        const validTracks = data.items.filter(item => hasValidAudio(item) && hasValidArtwork(item));
        state.newReleaseTracks = validTracks;
        state.newReleasesLoaded = true;
        renderNewReleases();
      } catch (err) {
        console.error('[New Releases] Failed to load', err);
        container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>Failed to load new releases</p></div>`;
      } finally {
        if (btn) btn.classList.remove('spinning');
      }
    }

    function renderNewReleases() {
      const container = elements.newReleasesContent;
      const tracks = state.newReleaseTracks;

      if (!tracks.length) {
        container.innerHTML = `<div class="empty-state"><div class="empty-icon">🎵</div><p>No new releases available</p></div>`;
        return;
      }

      // Group by album
      const albumMap = new Map();
      tracks.forEach(track => {
        const fields = track.fields || track.fieldData || {};
        const albumTitle = getAlbumField(fields) || getTitleField(fields) || 'Unknown Album';
        const artist    = getAlbumArtist(fields);
        const artwork   = getArtworkUrl(fields);
        const key       = `${albumTitle}|||${artist}`.toLowerCase();

        if (!albumMap.has(key)) {
          albumMap.set(key, { title: albumTitle, artist, artwork, tracks: [] });
        }
        albumMap.get(key).tracks.push(track);
      });

      const albums = [...albumMap.values()];
      const grid = document.createElement('div');
      grid.className = 'nr-album-grid';

      // Dismiss any open overlay when tapping outside
      document.addEventListener('click', () => {
        document.querySelectorAll('.nr-album-card.overlay-active').forEach(c => c.classList.remove('overlay-active'));
      }, { capture: true, once: false });

      albums.forEach(album => {
        const card = document.createElement('div');
        card.className = 'nr-album-card';

        const trackCount = album.tracks.length;
        const trackLabel = trackCount === 1 ? 'track' : 'tracks';
        const playSVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="white" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;

        card.innerHTML = `
          <img class="nr-album-artwork" src="${album.artwork}" alt="${album.title}" loading="lazy" onerror="this.src='/img/placeholder.png'">
          <span class="nr-new-badge">NEW</span>
          <div class="nr-card-overlay">
            <div class="nr-overlay-title">${album.title}</div>
            <div class="nr-overlay-artist">${album.artist}</div>
            <div class="nr-overlay-actions">
              <span class="nr-track-count">${trackCount} ${trackLabel}</span>
              <button class="nr-play-btn" title="Play album">${playSVG}</button>
            </div>
          </div>
        `;

        // First tap → reveal overlay; second tap on overlay → open track modal
        card.addEventListener('click', (e) => {
          if (e.target.closest('.nr-play-btn')) return; // handled below

          if (!card.classList.contains('overlay-active')) {
            // Close any other open overlays first
            document.querySelectorAll('.nr-album-card.overlay-active').forEach(c => c.classList.remove('overlay-active'));
            card.classList.add('overlay-active');
            e.stopPropagation();
          } else {
            // Already open — tapping overlay area opens track list
            showAlbumTracksModal(album);
          }
        });

        // Play button → play immediately
        card.querySelector('.nr-play-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          if (album.tracks.length > 0) {
            state.playlistContext = { tracks: album.tracks, currentIndex: 0, playFn: playTrack };
            playTrack(album.tracks[0]);
          }
          card.classList.remove('overlay-active');
        });

        grid.appendChild(card);
      });

      container.innerHTML = '';
      container.appendChild(grid);
    }

    // ===== G100 =====
    async function loadG100(forceRefresh = false) {
      const container = elements.g100Content;
      const btn = document.getElementById('g100-refresh-btn');
      if (btn) btn.classList.add('spinning');

      container.innerHTML = `
        <div class="nr-album-grid">
          <div class="skeleton-card skeleton" style="aspect-ratio:1;height:auto;border-radius:14px;margin:0;"></div>
          <div class="skeleton-card skeleton" style="aspect-ratio:1;height:auto;border-radius:14px;margin:0;"></div>
          <div class="skeleton-card skeleton" style="aspect-ratio:1;height:auto;border-radius:14px;margin:0;"></div>
          <div class="skeleton-card skeleton" style="aspect-ratio:1;height:auto;border-radius:14px;margin:0;"></div>
        </div>`;

      try {
        const res  = await fetch('/api/g100-albums');
        const data = await res.json();
        const items = data.items || [];

        if (!items.length) {
          container.innerHTML = `<div class="empty-state"><div class="empty-icon">🏆</div><p>No G100 albums found</p></div>`;
          state.g100Loaded = true;
          return;
        }

        // Deduplicate by album+artist, then group into album objects
        const seen = new Set();
        const albumMap = new Map();

        items.forEach(item => {
          const fields = item.fields || {};
          const albumTitle = getAlbumField(fields);
          const artist     = getAlbumArtist(fields);
          const artwork    = getArtworkUrl(fields);
          const key        = `${albumTitle}|||${artist}`.toLowerCase();

          if (!albumMap.has(key)) {
            albumMap.set(key, { title: albumTitle, artist, artwork, tracks: [] });
          }
          // Only add track if it has valid audio
          if (hasValidAudio(item)) {
            albumMap.get(key).tracks.push(item);
          }
        });

        state.g100Albums = [...albumMap.values()].filter(a => a.tracks.length > 0 || a.artwork !== '/img/placeholder.png');
        state.g100Loaded = true;
        renderG100Albums('');
      } catch (err) {
        console.error('[G100] Failed to load albums', err);
        container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>Failed to load G100 albums</p></div>`;
      } finally {
        if (btn) btn.classList.remove('spinning');
      }
    }

    function filterG100Albums(query) {
      renderG100Albums(query);
    }

    function renderG100Albums(filter = '') {
      const container = elements.g100Content;
      const q = (filter || '').toLowerCase().trim();
      const albums = q
        ? state.g100Albums.filter(a => a.title.toLowerCase().includes(q) || a.artist.toLowerCase().includes(q))
        : state.g100Albums;

      if (!albums.length) {
        container.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><p>No albums match "${filter}"</p></div>`;
        return;
      }

      const grid = document.createElement('div');
      grid.className = 'nr-album-grid';

      albums.forEach(album => {
        const card = document.createElement('div');
        card.className = 'nr-album-card';

        const trackCount = album.tracks.length;
        const trackLabel = trackCount === 1 ? 'track' : 'tracks';
        const playSVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="white" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;

        card.innerHTML = `
          <img class="nr-album-artwork" src="${album.artwork}" alt="${album.title}" loading="lazy" onerror="this.src='/img/placeholder.png'">
          <span class="g100-badge">G100</span>
          <div class="nr-card-overlay">
            <div class="nr-overlay-title">${album.title}</div>
            <div class="nr-overlay-artist">${album.artist}</div>
            <div class="nr-overlay-actions">
              <span class="nr-track-count">${trackCount} ${trackLabel}</span>
              ${trackCount > 0 ? `<button class="nr-play-btn" style="background:var(--g100-gold);" title="Play">${playSVG}</button>` : ''}
            </div>
          </div>
        `;

        card.addEventListener('click', (e) => {
          if (e.target.closest('.nr-play-btn')) return;
          if (!card.classList.contains('overlay-active')) {
            document.querySelectorAll('.nr-album-card.overlay-active').forEach(c => c.classList.remove('overlay-active'));
            card.classList.add('overlay-active');
            e.stopPropagation();
          } else if (album.tracks.length > 0) {
            showAlbumTracksModal(album);
          }
        });

        const playBtn = card.querySelector('.nr-play-btn');
        if (playBtn) {
          playBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            state.playlistContext = { tracks: album.tracks, currentIndex: 0, playFn: playTrack };
            playTrack(album.tracks[0]);
            card.classList.remove('overlay-active');
          });
        }

        grid.appendChild(card);
      });

      container.innerHTML = '';
      container.appendChild(grid);
    }

    async function loadG100Playlists() {
      const container = elements.g100PlaylistsContent;
      try {
        const res  = await fetch('/api/public-playlists');
        const data = await res.json();
        const playlists = data.playlists || [];

        if (!playlists.length) {
          container.innerHTML = `<div class="empty-state"><div class="empty-icon">📋</div><p>No playlists available</p></div>`;
          state.g100PlaylistsLoaded = true;
          return;
        }

        state.g100Playlists = playlists;
        state.g100PlaylistsLoaded = true;
        renderG100Playlists(playlists);
      } catch (err) {
        console.error('[G100 Playlists] Failed to load', err);
        container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>Failed to load playlists</p></div>`;
      }
    }

    function renderG100Playlists(playlists) {
      const container = elements.g100PlaylistsContent;
      const grid = document.createElement('div');
      grid.className = 'g100-playlist-grid';

      playlists.forEach((pl, i) => {
        const hue  = (i * 47 + 210) % 360;
        const card = document.createElement('div');
        card.className = 'g100-playlist-card';
        card.style.setProperty('--pl-hue', hue);

        card.innerHTML = `
          <div class="g100-playlist-art">
            ${pl.imageUrl
              ? `<img src="${pl.imageUrl}" alt="${pl.name}" loading="lazy">`
              : `<svg viewBox="0 0 24 24" fill="currentColor" width="40" height="40" style="opacity:0.6;"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>`
            }
          </div>
          <div class="g100-playlist-info">
            <div class="g100-playlist-name">${pl.name}</div>
            <div class="g100-playlist-count">${pl.trackCount} track${pl.trackCount !== 1 ? 's' : ''}</div>
          </div>
        `;

        card.addEventListener('click', () => showG100PlaylistTracks(pl.name));
        grid.appendChild(card);
      });

      container.innerHTML = '';
      container.appendChild(grid);
    }

    async function showG100PlaylistTracks(playlistName) {
      // Show loading state in bottom sheet immediately
      elements.bottomSheet.innerHTML = `
        <div class="bottom-sheet-header">${playlistName}</div>
        <div class="empty-state"><div class="empty-icon">⏳</div><p>Loading tracks…</p></div>
        <button class="btn btn-secondary" style="width:100%;margin-top:16px;" onclick="closeModal()">Close</button>
      `;
      elements.modalOverlay.classList.add('show');

      try {
        const res  = await fetch(`/api/public-playlists?name=${encodeURIComponent(playlistName)}`);
        const data = await res.json();

        if (!data.ok || !data.tracks?.length) {
          elements.bottomSheet.innerHTML = `
            <div class="bottom-sheet-header">${playlistName}</div>
            <div class="empty-state"><div class="empty-icon">🎵</div><p>No tracks in this playlist</p></div>
            <button class="btn btn-secondary" style="width:100%;margin-top:16px;" onclick="closeModal()">Close</button>
          `;
          return;
        }

        // Normalise track shape to what playTrack expects
        const tracks = data.tracks.map(t => ({
          fields: {
            'Track Name':   t.name        || '',
            'Album Artist': t.trackArtist || t.albumArtist || '',
            'Album Title':  t.albumTitle  || '',
            'S3_URL':       t.resolvedSrc || t.mp3 || '',
            'Artwork::Picture': t.artwork || t.picture || '',
          }
        }));

        elements.bottomSheet.innerHTML = `
          <div class="bottom-sheet-header">${playlistName}</div>
          <p style="text-align:center;color:var(--text-secondary);margin-bottom:16px;">${tracks.length} track${tracks.length !== 1 ? 's' : ''}</p>
          ${tracks.map((t, idx) => {
            const fields = t.fields;
            return `<button class="bottom-sheet-option" data-idx="${idx}">${fields['Track Name'] || 'Unknown Track'}<span style="display:block;font-size:11px;color:var(--text-muted);margin-top:2px;">${fields['Album Artist'] || ''}</span></button>`;
          }).join('')}
          <button class="btn btn-secondary" style="width:100%;margin-top:16px;" onclick="closeModal()">Close</button>
        `;

        elements.bottomSheet.querySelectorAll('[data-idx]').forEach(btn => {
          btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.idx);
            state.playlistContext = { tracks, currentIndex: idx, playFn: playTrack };
            playTrack(tracks[idx]);
            closeModal();
          });
        });
      } catch (err) {
        console.error('[G100 Playlist] Failed to load tracks', err);
        elements.bottomSheet.innerHTML = `
          <div class="bottom-sheet-header">${playlistName}</div>
          <div class="empty-state"><div class="empty-icon">⚠️</div><p>Failed to load tracks</p></div>
          <button class="btn btn-secondary" style="width:100%;margin-top:16px;" onclick="closeModal()">Close</button>
        `;
      }
    }

    // ===== Discovery =====
    async function refreshDiscover() {
      // Clear the album cache so fresh counts are fetched after reload
      state.discoverAlbumCache.clear();
      const btn = document.getElementById('discover-refresh-btn');
      if (btn) btn.classList.add('spinning');
      try {
        await loadDiscover();
      } finally {
        if (btn) btn.classList.remove('spinning');
      }
    }

    async function loadDiscover() {
      // Show loading indicator
      elements.discoverContent.innerHTML = '<div class="empty-state"><div class="empty-icon">⏳</div><p>Loading tracks...</p></div>';

      try {
        let response, data;

        if (state.selectedDecade) {
          // Fetch tracks by decade
          const params = new URLSearchParams({
            start: state.selectedDecade.start,
            end: state.selectedDecade.start + 9,
            limit: 300
          });
          console.log('[Load Discover] Fetching decade:', state.selectedDecade.label);
          response = await fetch(`/api/explore?${params}`);
          data = await response.json();
          console.log('[Load Discover] Decade results:', data.total || 0, 'tracks found');
          state.randomTracks = data.items || [];

          // Apply genre filter if selected
          if (state.selectedGenre !== 'All') {
            console.log('[Load Discover] Applying genre filter:', state.selectedGenre);
            state.randomTracks = state.randomTracks.filter(track => {
              const genre = getGenreField(track.fields);
              return genre.toLowerCase().includes(state.selectedGenre.toLowerCase());
            });
            console.log('[Load Discover] After genre filter:', state.randomTracks.length, 'tracks');
          }
        } else if (state.selectedGenre !== 'All') {
          // Fetch tracks by genre only (no decade filter)
          console.log('[Load Discover] Fetching genre:', state.selectedGenre);
          response = await fetch(`/api/search?genre=${encodeURIComponent(state.selectedGenre)}&limit=200`);
          data = await response.json();
          console.log('[Load Discover] Genre results:', data.total, 'total tracks');

          // Shuffle results to show different tracks on refresh
          const items = data.items || [];
          for (let i = items.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [items[i], items[j]] = [items[j], items[i]];
          }
          state.randomTracks = items;
        } else {
          // Fetch random tracks (no filters)
          response = await fetch('/api/random-songs?count=50');
          data = await response.json();
          state.randomTracks = data.items || [];
        }

        renderDiscoverTracks();
      } catch (err) {
        console.error('Failed to load discover', err);
        elements.discoverContent.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div><p>Failed to load tracks</p></div>';
      }
    }

    function renderDiscoverTracks() {
      elements.discoverContent.innerHTML = '';

      // Show filter indicators
      if (state.selectedDecade || state.selectedGenre !== 'All') {
        const indicator = document.createElement('div');
        indicator.style.cssText = 'padding: 8px 16px; background: var(--bg-card); border-radius: 8px; margin-bottom: 16px;';

        let filterText = 'Filtered by: ';
        const filters = [];
        if (state.selectedDecade) filters.push(`<strong style="color: var(--accent);">${state.selectedDecade.label}</strong>`);
        if (state.selectedGenre !== 'All') filters.push(`<strong style="color: var(--accent);">${state.selectedGenre}</strong>`);
        filterText += filters.join(' + ');

        indicator.innerHTML = `
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
            <span style="font-size: 14px; color: var(--text-secondary);">${filterText}</span>
          </div>
          <div style="display: flex; gap: 8px;">
            ${state.selectedDecade ? '<button onclick="clearDecadeFilter()" style="padding: 4px 12px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 4px; color: var(--text-primary); font-size: 12px; cursor: pointer;">Clear Decade</button>' : ''}
            ${state.selectedGenre !== 'All' ? '<button onclick="clearGenreFilter()" style="padding: 4px 12px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 4px; color: var(--text-primary); font-size: 12px; cursor: pointer;">Clear Genre</button>' : ''}
            ${(state.selectedDecade || state.selectedGenre !== 'All') ? '<button onclick="clearAllFilters()" style="padding: 4px 12px; background: var(--accent); border: none; border-radius: 4px; color: white; font-size: 12px; cursor: pointer;">Clear All</button>' : ''}
          </div>
        `;
        elements.discoverContent.appendChild(indicator);
      }

      // Filter by valid audio AND valid artwork (genre filtering already done by API)
      const filteredTracks = state.randomTracks.filter(track => hasValidAudio(track) && hasValidArtwork(track));

      console.log('[Render Discover] Tracks with valid audio and artwork:', filteredTracks.length, 'out of', state.randomTracks.length);

      if (filteredTracks.length === 0) {
        const message = state.selectedGenre === 'All'
          ? 'No tracks with audio and artwork available'
          : `No ${state.selectedGenre} tracks with artwork found`;
        elements.discoverContent.innerHTML += `<div class="empty-state"><div class="empty-icon">🎵</div><p>${message}</p></div>`;
        return;
      }

      // Build album map so every track knows its siblings and total count
      const albumMap = new Map();
      filteredTracks.forEach(track => {
        const fields = track.fields || {};
        const albumTitle  = getAlbumField(fields);
        const albumArtist = getAlbumArtist(fields);
        const key = `${albumTitle}|||${albumArtist}`.toLowerCase();
        if (!albumMap.has(key)) {
          albumMap.set(key, {
            title:   albumTitle,
            artist:  albumArtist,
            artwork: getArtworkUrl(fields),
            tracks:  []
          });
        }
        albumMap.get(key).tracks.push(track);
      });

      // Deduplicate to one representative track per album (first track seen).
      // Decade and genre searches return every track, so without this the list
      // floods with duplicates from the same album.
      const seenAlbums = new Set();
      const deduped = [];
      filteredTracks.forEach(track => {
        const fields = track.fields || {};
        const key = `${getAlbumField(fields)}|||${getAlbumArtist(fields)}`.toLowerCase();
        if (!seenAlbums.has(key)) {
          seenAlbums.add(key);
          deduped.push(track);
        }
      });

      // Render one card per album (limit to 100). The rendered list is the
      // Discover "feed" — now-playing prev/next navigate it (see play handler).
      const displayLimit = 100;
      state.discoverFeed = deduped.slice(0, displayLimit);
      state.discoverFeed.forEach(track => {
        const fields = track.fields || {};
        const key = `${getAlbumField(fields)}|||${getAlbumArtist(fields)}`.toLowerCase();
        const albumCtx = albumMap.get(key);
        const card = createDiscoverTrackCard(track, albumCtx);
        elements.discoverContent.appendChild(card);
      });

      console.log('[Render Discover] Rendered', Math.min(displayLimit, deduped.length), 'cards from', filteredTracks.length, 'tracks');

      // Prefetch real album track counts in the background so badges update automatically
      prefetchDiscoverAlbums(albumMap);
    }

    // ── Background album prefetch — fills badge counts after discover renders ─
    async function prefetchDiscoverAlbums(albumMap) {
      const entries = Array.from(albumMap.entries()); // [key, albumCtx]
      const CONCURRENCY = 4; // gentle on the server

      async function fetchOne([key, albumCtx]) {
        if (state.discoverAlbumCache.has(key)) return; // already done
        try {
          const params = new URLSearchParams({ title: albumCtx.title, artist: albumCtx.artist });
          const res  = await fetch(`/api/album?${params}`);
          if (!res.ok) return;
          const data = await res.json();
          if (!data.ok || !data.items?.length) return;
          const fullAlbum = { ...albumCtx, tracks: data.items };
          state.discoverAlbumCache.set(key, fullAlbum);
          // Push the real count to any visible badge for this album
          updateDiscoverBadgeCounts(key, data.items.length);
        } catch { /* silent — badge stays at placeholder */ }
      }

      // Process in small parallel batches
      for (let i = 0; i < entries.length; i += CONCURRENCY) {
        await Promise.all(entries.slice(i, i + CONCURRENCY).map(fetchOne));
      }
    }

    function updateDiscoverBadgeCounts(albumKey, count) {
      document.querySelectorAll(`.album-count-btn[data-album-key="${CSS.escape(albumKey)}"] .album-badge-count`)
        .forEach(el => { el.textContent = count; });
    }

    // Field/format helpers delegate to the single canonical source in helpers.js
    // (window.MADHelpers). Kept as thin wrappers so mobile's many call sites are
    // unchanged. getArtworkUrl/getAudioUrl/getYearField/hasValidArtwork stay local
    // because they have mobile-specific behaviour (placeholder, raw-value for the
    // playTrack proxy, year/artwork rules).
    function getFieldValue(fields, fieldNames) {
      return window.MADHelpers.getFieldValue(fields, fieldNames);
    }

    function getArtworkUrl(fields) {
      const artworkFields = ['Artwork_S3_URL', 'Tape Files::Artwork_S3_URL', 'Artwork::Picture', 'Artwork Picture', 'Picture'];
      const artwork = getFieldValue(fields, artworkFields);
      if (!artwork) return '/img/placeholder.png';

      // Handle FileMaker container URLs
      if (artwork.startsWith('https://') || artwork.startsWith('http://')) {
        return artwork;
      }
      return artwork;
    }

    function getTitleField(fields) {
      return window.MADHelpers.getTitleField(fields);
    }

    function getArtistField(fields) {
      return window.MADHelpers.getArtistField(fields);
    }

    // Album-level artist for grouping keys/album cards (album-first). Using the
    // track-first getArtistField here would split a compilation album into one
    // card per track artist.
    function getAlbumArtist(fields) {
      return window.MADHelpers.getAlbumArtist(fields);
    }

    function getAlbumField(fields) {
      return window.MADHelpers.getAlbumField(fields);
    }

    function getYearField(fields) {
      const yearFields = ['Year', 'Year Recorded', 'Year_Recorded', 'Release Year', 'Release_Year', 'Date'];
      return getFieldValue(fields, yearFields) || '';
    }

    function getAudioUrl(fields) {
      const audioFields = ['S3_URL', 'mp3', 'MP3', 'Audio File', 'Audio::mp3'];
      return getFieldValue(fields, audioFields);
    }

    // Check if an item has valid audio. Delegates to the canonical 10-field
    // helper (was a 5-field copy here that wrongly hid tracks whose audio lives
    // in Tape Files::* fields — e.g. missing New Releases).
    function hasValidAudio(item) {
      return window.MADHelpers.hasValidAudio(item);
    }

    // Check if an item has valid artwork
    function hasValidArtwork(item) {
      if (!item || !item.fields) return false;
      const artworkFields = ['Artwork_S3_URL', 'Tape Files::Artwork_S3_URL', 'Artwork::Picture', 'Artwork Picture', 'Picture'];
      const artwork = getFieldValue(item.fields, artworkFields);

      // Must be a non-empty string that is a real HTTP/HTTPS URL
      if (!artwork || typeof artwork !== 'string') return false;
      const trimmed = artwork.trim();
      if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) return false;
      // Must look like an image URL (has some path/extension after the host)
      if (trimmed.length < 12) return false;

      return true;
    }

    // Group tracks by album
    function groupTracksByAlbum(tracks) {
      const albums = new Map();

      tracks.forEach(track => {
        const fields = track.fields || {};
        const albumTitle = getAlbumField(fields);
        const albumArtist = getAlbumArtist(fields);
        const albumKey = `${albumTitle}|||${albumArtist}`.toLowerCase();

        if (!albums.has(albumKey)) {
          albums.set(albumKey, {
            title: albumTitle,
            artist: albumArtist,
            artwork: getArtworkUrl(fields),
            tracks: []
          });
        }

        albums.get(albumKey).tracks.push(track);
      });

      // Convert to array, filter out albums with no real cover art, sort by track count
      return Array.from(albums.values())
        .filter(album => album.artwork && album.artwork !== '/img/placeholder.png')
        .sort((a, b) => b.tracks.length - a.tracks.length);
    }

    function createAlbumCard(album) {
      const card = document.createElement('div');
      card.className = 'track-card';

      const trackCount = album.tracks.length;
      const trackLabel = trackCount === 1 ? 'track' : 'tracks';

      card.innerHTML = `
        <img class="track-artwork" src="${album.artwork}" alt="${album.title}" loading="lazy" onerror="this.src='/img/placeholder.png'">
        <div class="track-info">
          <div class="track-title">${album.title}</div>
          <div class="track-artist">${album.artist} • ${trackCount} ${trackLabel}</div>
        </div>
        <div class="track-actions">
          <button class="btn-icon view-btn">📋</button>
          <button class="btn-icon play-btn">▶</button>
        </div>
      `;

      card.querySelector('.play-btn').addEventListener('click', () => {
        if (album.tracks.length > 0) {
          state.playlistContext = { tracks: album.tracks, currentIndex: 0, playFn: playTrack };
          playTrack(album.tracks[0]);
        }
      });

      card.querySelector('.view-btn').addEventListener('click', () => showAlbumTracksModal(album));

      return card;
    }

    function showAlbumTracksModal(album) {
      elements.bottomSheet.innerHTML = `
        <div class="bottom-sheet-header">${album.title}</div>
        <p style="text-align: center; color: var(--text-secondary); margin-bottom: 16px;">${album.artist}</p>
        ${album.tracks.map((track, index) => {
          const fields = track.fields || {};
          const trackTitle = getTitleField(fields);
          return `
            <button class="bottom-sheet-option" data-track-index="${index}">
              ${trackTitle}
            </button>
          `;
        }).join('')}
        <button class="btn btn-secondary" style="width: 100%; margin-top: 16px;" onclick="closeModal()">Close</button>
      `;

      elements.modalOverlay.classList.add('show');

      elements.bottomSheet.querySelectorAll('[data-track-index]').forEach(btn => {
        btn.addEventListener('click', () => {
          const trackIndex = parseInt(btn.dataset.trackIndex);
          state.playlistContext = { tracks: album.tracks, currentIndex: trackIndex, playFn: playTrack };
          playTrack(album.tracks[trackIndex]);
          closeModal();
        });
      });
    }

    // ── Discover individual track card with album badge ───────────────────────
    // albumCtx is the album object built in renderDiscoverTracks:
    //   { title, artist, artwork, tracks[] }
    function createDiscoverTrackCard(track, albumCtx) {
      const card = document.createElement('div');
      card.className = 'track-card';

      const fields    = track.fields || {};
      const artwork   = getArtworkUrl(fields);
      const title     = getTitleField(fields);
      const artist    = getArtistField(fields);
      const genre     = getGenreField(fields);
      // Discover returns one track per album — show placeholder count until prefetch completes
      const initCount = albumCtx ? albumCtx.tracks.length : 1;
      const albumKey  = albumCtx
        ? `${albumCtx.title}|||${albumCtx.artist}`.toLowerCase()
        : null;

      // Disc SVG (concentric circles — matches desktop card-album-btn)
      const discSVG = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>`;

      card.innerHTML = `
        <img class="track-artwork" src="${artwork}" alt="${title}" loading="lazy" onerror="this.src='/img/placeholder.png'">
        <div class="track-info">
          <div class="track-title">${title}</div>
          <div class="track-artist">${artist}</div>
          ${genre ? `<span class="track-genre-tag">${genre}</span>` : ''}
        </div>
        <div class="track-actions">
          <button class="album-count-btn" data-album-key="${albumKey || ''}" title="View full album">${discSVG}<span class="album-badge-count">…</span></button>
          <button class="btn-icon play-btn" title="Play">▶</button>
        </div>
      `;

      // Album badge → fetch full album (or use cache) then open modal
      card.querySelector('.album-count-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!albumCtx) return;
        const btn = e.currentTarget;

        // Use already-fetched data if available
        const cached = state.discoverAlbumCache.get(albumKey);
        if (cached) { showAlbumTracksModal(cached); return; }

        // First tap: fetch now (prefetch may not have reached this one yet)
        btn.disabled = true;
        btn.querySelector('.album-badge-count').textContent = '…';
        try {
          const params = new URLSearchParams({ title: albumCtx.title, artist: albumCtx.artist });
          const res  = await fetch(`/api/album?${params}`);
          const data = await res.json();
          if (data.ok && data.items?.length) {
            const fullAlbum = { ...albumCtx, tracks: data.items };
            state.discoverAlbumCache.set(albumKey, fullAlbum);
            btn.querySelector('.album-badge-count').textContent = data.items.length;
            showAlbumTracksModal(fullAlbum);
          } else {
            showAlbumTracksModal(albumCtx); // fallback to what we have
          }
        } catch {
          showAlbumTracksModal(albumCtx);
        } finally {
          btn.disabled = false;
        }
      });

      // Play → set the whole Discover feed as the queue so now-playing prev/next
      // move through the feed (each card is one album's representative track).
      card.querySelector('.play-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        const feed = state.discoverFeed || [];
        const idx = feed.findIndex(t => (t.recordId || t) === (track.recordId || track));
        state.playlistContext = {
          tracks: feed.length ? feed : [track],
          currentIndex: idx >= 0 ? idx : 0,
          playFn: playTrack
        };
        playTrack(track);
      });

      // Artwork tap → ask if user wants all albums by this artist
      card.querySelector('.track-artwork').addEventListener('click', (e) => {
        e.stopPropagation();
        if (!artist) return;
        showMobileArtistPrompt(artist);
      });

      return card;
    }

    function showMobileArtistPrompt(artistName) {
      document.getElementById('mobileArtistPrompt')?.remove();

      const overlay = document.createElement('div');
      overlay.id = 'mobileArtistPrompt';
      overlay.className = 'mobile-artist-prompt-overlay';
      overlay.innerHTML = `
        <div class="mobile-artist-prompt-box">
          <p class="mobile-artist-prompt-q">See all albums by</p>
          <p class="mobile-artist-prompt-name">${artistName.replace(/[<>]/g, '')}</p>
          <div class="mobile-artist-prompt-actions">
            <button class="mobile-artist-prompt-btn mobile-artist-yes">Yes, search</button>
            <button class="mobile-artist-prompt-btn mobile-artist-no">Dismiss</button>
          </div>
        </div>
      `;
      overlay.querySelector('.mobile-artist-yes').addEventListener('click', () => {
        overlay.remove();
        // Switch to search tab and pre-fill with artist name
        const searchInput = document.getElementById('search-input');
        if (searchInput) searchInput.value = artistName;
        switchTab('search');
        if (typeof search === 'function') search(artistName);
      });
      overlay.querySelector('.mobile-artist-no').addEventListener('click', () => overlay.remove());
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
      document.body.appendChild(overlay);
    }

    function createTrackCard(track) {
      const card = document.createElement('div');
      card.className = 'track-card';

      const fields = track.fields || {};
      const artwork = getArtworkUrl(fields);
      const title = getTitleField(fields);
      const artist = getArtistField(fields);

      card.innerHTML = `
        <img class="track-artwork" src="${artwork}" alt="${title}" loading="lazy" onerror="this.src='/img/placeholder.png'">
        <div class="track-info">
          <div class="track-title">${title}</div>
          <div class="track-artist">${artist}</div>
        </div>
        <div class="track-actions">
          <button class="btn-icon play-btn">▶</button>
          <button class="btn-icon add-btn">+</button>
        </div>
      `;

      card.querySelector('.play-btn').addEventListener('click', () => playTrack(track));
      card.querySelector('.add-btn').addEventListener('click', () => showAddToPlaylistModal(track));

      return card;
    }

    // ===== Search =====
    let searchTimeout;
    elements.searchInput.addEventListener('input', (e) => {
      const query = e.target.value.trim();
      if (!query) {
        elements.searchResults.innerHTML = '';
        return;
      }

      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => search(query), 500);
    });

    async function search(query) {
      try {
        elements.searchResults.innerHTML = '<div class="skeleton-card skeleton"></div><div class="skeleton-card skeleton"></div>';

        // Use 'q' parameter for general search across all fields
        const params = new URLSearchParams({
          q: query,
          limit: 100
        });

        console.log('[Search] Query:', query);
        const response = await fetch(`/api/search?${params}`);
        const data = await response.json();
        console.log('[Search] Results:', data.total || 0, 'tracks found');

        state.searchResults = data.items || [];
        renderSearchResults();
      } catch (err) {
        console.error('[Search] Failed:', err);
        elements.searchResults.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div><p>Search failed</p></div>';
      }
    }

    function renderSearchResults() {
      elements.searchResults.innerHTML = '';

      // Filter to only show tracks with valid audio AND valid artwork
      const validResults = state.searchResults.filter(track => hasValidAudio(track) && hasValidArtwork(track));

      if (validResults.length === 0) {
        if (state.searchResults.length > 0) {
          elements.searchResults.innerHTML = '<div class="empty-state"><p>No results with audio and artwork available</p></div>';
        } else {
          elements.searchResults.innerHTML = '<div class="empty-state"><p>No results found</p></div>';
        }
        return;
      }

      // Group search results by album
      const albums = groupTracksByAlbum(validResults);

      albums.forEach(album => {
        const card = createAlbumCard(album);
        elements.searchResults.appendChild(card);
      });
    }

    // ===== Playlists =====
    async function loadPlaylists() {
      try {
        const response = await fetch('/api/playlists');
        if (!response.ok) {
          console.error('Failed to load playlists:', response.status);
          if (response.status === 401) {
            elements.playlistsContent.innerHTML = '<div class="empty-state"><div class="empty-icon">🔒</div><p>Token not recognised by server. Try re-entering your access token.</p></div>';
          }
          return;
        }
        const data = await response.json();
        state.playlists = data.playlists || [];
        renderPlaylists();
      } catch (err) {
        console.error('Failed to load playlists', err);
      }
    }

    function renderPlaylists() {
      if (state.playlists.length === 0) {
        elements.playlistsContent.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div><p>No playlists yet. Create one!</p></div>';
        return;
      }

      elements.playlistsContent.innerHTML = '';
      state.playlists.forEach(playlist => {
        const trackCount = playlist.tracks?.length || 0;
        const card = document.createElement('div');
        card.className = 'track-card';
        card.style.cursor = 'pointer';
        card.innerHTML = `
          <div class="track-info">
            <div class="track-title">${playlist.name}</div>
            <div class="track-artist">${trackCount} track${trackCount !== 1 ? 's' : ''}</div>
          </div>
          <button class="btn-icon play-playlist-btn" title="Play playlist">▶</button>
        `;

        // Tap card body → show track list
        card.querySelector('.track-info').addEventListener('click', () => {
          showPlaylistTracks(playlist);
        });

        // Tap ▶ → play from first track
        card.querySelector('.play-playlist-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          if (trackCount === 0) { showToast('Playlist is empty', 'error'); return; }
          state.playlistContext = { tracks: playlist.tracks, currentIndex: 0, playFn: playPlaylistTrack };
          playPlaylistTrack(playlist.tracks[0]);
        });

        elements.playlistsContent.appendChild(card);
      });
    }

    function showPlaylistTracks(playlist) {
      const tracks = playlist.tracks || [];
      elements.bottomSheet.innerHTML = `
        <div class="bottom-sheet-header">${playlist.name}</div>
        ${tracks.length === 0 ? '<p style="text-align:center;color:var(--text-muted);padding:16px;">No tracks yet</p>' :
          tracks.map((t, i) => `
            <button class="bottom-sheet-option" data-index="${i}" style="display:flex;align-items:center;gap:10px;text-align:left;">
              <span style="flex:1;">${t.name || 'Unknown'}<br><small style="color:var(--text-muted)">${t.albumArtist || t.albumTitle || ''}</small></span>
              <span>▶</span>
            </button>
          `).join('')}
        <button class="btn btn-secondary" style="width:100%;margin-top:16px;" onclick="closeModal()">Close</button>
      `;
      elements.modalOverlay.classList.add('show');
      elements.bottomSheet.querySelectorAll('[data-index]').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.index);
          state.playlistContext = { tracks, currentIndex: idx, playFn: playPlaylistTrack };
          playPlaylistTrack(tracks[idx]);
          closeModal();
        });
      });
    }

    // Adapt a stored playlist track into the format playTrack() expects.
    // Saved playlist tracks store ABSOLUTE FileMaker streaming URLs that expire
    // (RCType=RCFileProcessor → 401), which left the now-playing artwork blank
    // and audio broken. Re-resolve fresh audio + artwork by recordId; the stored
    // URLs are only a fallback if the lookup fails.
    async function playPlaylistTrack(playlistTrack) {
      const recordId = playlistTrack.trackRecordId || playlistTrack.recordId || '';

      let freshAudio = '', freshArtwork = '';
      if (recordId) {
        try {
          const r = await fetch(`/api/track/${encodeURIComponent(recordId)}/container`);
          const d = await r.json();
          if (d && d.ok) { freshAudio = d.url || ''; freshArtwork = d.artworkUrl || ''; }
        } catch (e) { /* fall back to stored URLs */ }
      }

      const adapted = {
        recordId,
        fields: {
          'Track Name': playlistTrack.name || '',
          'Album Title': playlistTrack.albumTitle || '',
          'Album Artist': playlistTrack.albumArtist || playlistTrack.trackArtist || '',
          // Fresh S3 first; stored (possibly stale) only as fallback.
          'Artwork_S3_URL': freshArtwork || playlistTrack.artwork || '',
          'S3_URL': freshAudio || '',
          'mp3': playlistTrack.mp3 || ''
        }
      };
      playTrack(adapted);
    }

    document.getElementById('create-playlist-btn').addEventListener('click', () => {
      if (!state.currentUser) {
        showToast('Please log in to create playlists', 'error');
        switchTab('profile');
        return;
      }

      const name = prompt('Playlist name:');
      if (name) {
        createPlaylist(name);
      }
    });

    async function createPlaylist(name) {
      try {
        const response = await fetch('/api/playlists', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name })
        });

        if (response.ok) {
          showToast('Playlist created!');
          loadPlaylists();
        } else {
          showToast('Failed to create playlist', 'error');
        }
      } catch (err) {
        showToast('Failed to create playlist', 'error');
      }
    }

    function showAddToPlaylistModal(track) {
      if (!state.currentUser) {
        showToast('Please log in to add to playlists', 'error');
        switchTab('profile');
        return;
      }

      if (state.playlists.length === 0) {
        showToast('Create a playlist first', 'error');
        switchTab('playlists');
        return;
      }

      elements.bottomSheet.innerHTML = `
        <div class="bottom-sheet-header">Add to Playlist</div>
        ${state.playlists.map(playlist => `
          <button class="bottom-sheet-option" data-playlist-id="${playlist.id}">
            ${playlist.name}
          </button>
        `).join('')}
        <button class="btn btn-secondary" style="width: 100%; margin-top: 16px;" onclick="closeModal()">Cancel</button>
      `;

      elements.modalOverlay.classList.add('show');

      elements.bottomSheet.querySelectorAll('[data-playlist-id]').forEach(btn => {
        btn.addEventListener('click', () => {
          addTrackToPlaylist(btn.dataset.playlistId, track);
          closeModal();
        });
      });
    }

    async function addTrackToPlaylist(playlistId, track) {
      try {
        const fields = track.fields || {};

        // Transform FileMaker track to playlist format
        const playlistTrack = {
          recordId: track.recordId || '',
          name: getTitleField(fields),
          albumTitle: getAlbumField(fields),
          albumArtist: getAlbumArtist(fields),
          artwork: getArtworkUrl(fields),
          mp3: getAudioUrl(fields) || ''
        };

        const response = await fetch(`/api/playlists/${playlistId}/tracks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ track: playlistTrack })
        });

        if (response.ok) {
          showToast('Added to playlist!');
          loadPlaylists();
        } else {
          const error = await response.json();
          showToast(error.error || 'Failed to add track', 'error');
        }
      } catch (err) {
        console.error('Add to playlist error:', err);
        showToast('Failed to add track', 'error');
      }
    }

    function closeModal() {
      elements.modalOverlay.classList.remove('show');
    }

    elements.modalOverlay.addEventListener('click', (e) => {
      if (e.target === elements.modalOverlay) {
        closeModal();
      }
    });

    // ===== Audio Playback =====
    async function playTrack(track) {
      state.currentTrack = track;
      const fields = track.fields || {};

      // Get audio URL
      let audioUrl = null;
      const mp3Field = getAudioUrl(fields);

      if (mp3Field && (mp3Field.startsWith('http') || mp3Field.startsWith('https'))) {
        audioUrl = `/api/container?u=${encodeURIComponent(mp3Field)}`;
      } else {
        try {
          const response = await fetch(`/api/track/${track.recordId}/container`);
          const data = await response.json();
          if (data.url) {
            audioUrl = `/api/container?u=${encodeURIComponent(data.url)}`;
          }
        } catch (err) {
          console.error('Failed to get audio URL', err);
        }
      }

      if (!audioUrl) {
        showToast('Audio not available', 'error');
        return;
      }

      // Play audio
      elements.audio.src = audioUrl;
      elements.audio.play();

      // Update UI
      updateFloatingPlayer();
      updatePlayerModal();
      state.playerBubble.visible = true;
      elements.floatingPlayer.classList.add('visible', 'playing');

      // Generate a new session ID for this track — stream event fired by the audio 'play' listener
      state.streamSessionId = generateSessionId();
    }

    // Set an artwork <img> src with a placeholder fallback if it fails to load
    // (e.g. a track with no real cover — a malformed/empty S3 artwork URL).
    function setArtwork(imgId, url) {
      const img = document.getElementById(imgId);
      if (!img) return;
      img.onerror = () => { img.onerror = null; img.src = '/img/placeholder.png'; };
      img.src = url;
    }

    function updateFloatingPlayer() {
      if (!state.currentTrack) return;

      const fields = state.currentTrack.fields || {};
      setArtwork('floating-artwork', getArtworkUrl(fields));
    }

    function updatePlayerModal() {
      if (!state.currentTrack) return;

      const fields = state.currentTrack.fields || {};
      const artwork = getArtworkUrl(fields);
      const title = getTitleField(fields);
      const artist = getArtistField(fields);
      const album = getAlbumField(fields);
      const year = getYearField(fields);

      setArtwork('player-artwork', artwork);
      document.getElementById('player-title').textContent = title;
      document.getElementById('player-artist').textContent = artist;
      document.getElementById('player-album').textContent = album;

      const yearElement = document.getElementById('player-year');
      if (year) {
        yearElement.textContent = year;
        yearElement.style.display = 'block';
      } else {
        yearElement.style.display = 'none';
      }
    }

    // Floating player drag functionality
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragStartTime = 0;

    elements.floatingPlayer.addEventListener('touchstart', (e) => {
      isDragging = false;
      const touch = e.touches[0];
      dragStartX = touch.clientX;
      dragStartY = touch.clientY;
      dragStartTime = Date.now();
      elements.floatingPlayer.style.transition = 'none';
    });

    elements.floatingPlayer.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const touch = e.touches[0];
      const deltaX = Math.abs(touch.clientX - dragStartX);
      const deltaY = Math.abs(touch.clientY - dragStartY);

      // If moved more than 10px, it's a drag
      if (deltaX > 10 || deltaY > 10) {
        isDragging = true;
      }

      if (isDragging) {
        const newX = touch.clientX - 30; // Center of bubble
        const newY = touch.clientY - 30;

        // Constrain to viewport
        const maxX = window.innerWidth - 60;
        const maxY = window.innerHeight - 60 - 64; // Minus tab bar

        const constrainedX = Math.max(0, Math.min(newX, maxX));
        const constrainedY = Math.max(0, Math.min(newY, maxY));

        elements.floatingPlayer.style.left = `${constrainedX}px`;
        elements.floatingPlayer.style.top = `${constrainedY}px`;
        elements.floatingPlayer.style.right = 'auto';
        elements.floatingPlayer.style.bottom = 'auto';
      }
    });

    elements.floatingPlayer.addEventListener('touchend', (e) => {
      const touch = e.changedTouches[0];
      const deltaTime = Date.now() - dragStartTime;

      elements.floatingPlayer.style.transition = 'all 0.3s ease';

      if (isDragging) {
        // Snap to nearest corner
        const centerX = window.innerWidth / 2;
        const centerY = (window.innerHeight - 64) / 2;

        const currentLeft = parseInt(elements.floatingPlayer.style.left || 0);
        const currentTop = parseInt(elements.floatingPlayer.style.top || 0);

        const snapLeft = currentLeft < centerX ? '20px' : 'auto';
        const snapRight = currentLeft >= centerX ? '20px' : 'auto';
        const snapTop = currentTop < centerY ? '20px' : 'auto';
        const snapBottom = currentTop >= centerY ? `calc(${64}px + 20px + env(safe-area-inset-bottom))` : 'auto';

        elements.floatingPlayer.style.left = snapLeft;
        elements.floatingPlayer.style.right = snapRight;
        elements.floatingPlayer.style.top = snapTop;
        elements.floatingPlayer.style.bottom = snapBottom;
      } else {
        // It's a tap — let the click handler open the modal to avoid double-fire
      }

      isDragging = false;
    });

    // Open player modal on click (covers desktop and browsers where touchend alone is unreliable)
    elements.floatingPlayer.addEventListener('click', () => {
      state.playerModal.visible = true;
      elements.playerModal.classList.add('show');
      updatePlayerModal();
    });

    // Close player modal
    document.getElementById('player-close').addEventListener('click', () => {
      state.playerModal.visible = false;
      elements.playerModal.classList.remove('show');
    });

    // Play/pause
    document.getElementById('play-pause-btn').addEventListener('click', () => {
      if (elements.audio.paused) {
        elements.audio.play();
      } else {
        elements.audio.pause();
      }
    });

    // Prev / Next — step through playlist context if active
    document.getElementById('prev-btn').addEventListener('click', () => {
      const ctx = state.playlistContext;
      if (!ctx || !ctx.tracks || ctx.tracks.length === 0) return;
      const newIdx = Math.max(0, ctx.currentIndex - 1);
      if (newIdx !== ctx.currentIndex) {
        ctx.currentIndex = newIdx;
        (ctx.playFn || playTrack)(ctx.tracks[newIdx]);
      }
    });

    document.getElementById('next-btn').addEventListener('click', () => {
      const ctx = state.playlistContext;
      if (!ctx || !ctx.tracks || ctx.tracks.length === 0) return;
      const newIdx = Math.min(ctx.tracks.length - 1, ctx.currentIndex + 1);
      if (newIdx !== ctx.currentIndex) {
        ctx.currentIndex = newIdx;
        (ctx.playFn || playTrack)(ctx.tracks[newIdx]);
      }
    });

    // Auto-advance to next track on end (works for both album and playlist contexts)
    elements.audio.addEventListener('ended', () => {
      sendStreamEvent('END');
      const ctx = state.playlistContext;
      if (ctx && ctx.tracks && ctx.currentIndex < ctx.tracks.length - 1) {
        ctx.currentIndex += 1;
        (ctx.playFn || playTrack)(ctx.tracks[ctx.currentIndex]);
      }
    });

    // Audio events
    elements.audio.addEventListener('play', () => {
      document.getElementById('play-pause-btn').textContent = '⏸';
      elements.floatingPlayer.classList.add('playing');
      sendStreamEvent('PLAY');
    });

    elements.audio.addEventListener('pause', () => {
      document.getElementById('play-pause-btn').textContent = '▶';
      elements.floatingPlayer.classList.remove('playing');
      sendStreamEvent('PAUSE');
    });

    elements.audio.addEventListener('timeupdate', () => {
      updateProgress();

      const now = Date.now();
      if (now - state.lastProgressUpdate > 30000) {
        sendStreamEvent('PROGRESS');
        state.lastProgressUpdate = now;
      }
    });

    elements.audio.addEventListener('error', () => {
      sendStreamEvent('ERROR');
      showToast('Playback error', 'error');
    });

    function updateProgress() {
      const current = elements.audio.currentTime || 0;
      const total = elements.audio.duration || 0;

      if (total > 0) {
        const percent = (current / total) * 100;
        document.getElementById('progress-fill').style.width = `${percent}%`;
      }

      document.getElementById('current-time').textContent = formatTime(current);
      document.getElementById('total-time').textContent = formatTime(total);
    }

    // Progress bar seek
    document.getElementById('progress-bar').addEventListener('click', (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const percent = x / rect.width;
      elements.audio.currentTime = elements.audio.duration * percent;
    });

    // Stream events
    async function sendStreamEvent(eventType) {
      if (!state.currentTrack || !state.streamSessionId) return;

      const currentTime = Math.floor(elements.audio.currentTime || 0);
      const duration = Math.floor(elements.audio.duration || 0);

      try {
        await fetch('/api/access/stream-events', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-ID': state.streamSessionId
          },
          body: JSON.stringify({
            eventType: eventType,
            trackRecordId: state.currentTrack.recordId,
            trackISRC: (state.currentTrack?.fields?.['ISRC'] || '').trim(),
            positionSec: currentTime,
            durationSec: duration,
            deltaSec: 0
          })
        });
        console.log('[Stream Event]', eventType, 'at', currentTime, 'sec');
      } catch (err) {
        console.warn('[Stream Event] Failed:', err);
      }
    }

    // Add to playlist from player
    document.getElementById('add-to-playlist-btn').addEventListener('click', () => {
      if (state.currentTrack) {
        showAddToPlaylistModal(state.currentTrack);
      }
    });

    // Start app
    init();

    // Decade filtering functionality
    (function() {
      const discoverDecadeDropdown = document.getElementById('mobile-discover-decade');
      const searchDecadeDropdown = document.getElementById('mobile-search-decade');

      async function loadDecadeInDiscover(startYear) {
        try {
          const discoverContent = document.getElementById('discover-content');
          discoverContent.innerHTML = '<div class="skeleton-card skeleton"></div><div class="skeleton-card skeleton"></div>';

          const params = new URLSearchParams({
            start: startYear,
            end: startYear + 9,
            limit: 300
          });

          console.log('[Decade Discover] Loading:', startYear + 's');
          const response = await fetch(`/api/explore?${params}`);
          const data = await response.json();
          console.log('[Decade Discover] Results:', data.total || 0, 'tracks found');

          state.randomTracks = data.items || [];
          renderDiscoverTracks();
        } catch (err) {
          console.error('[Decade Discover] Failed:', err);
          const discoverContent = document.getElementById('discover-content');
          discoverContent.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div><p>Failed to load decade</p></div>';
        }
      }

      async function loadDecadeInSearch(startYear) {
        try {
          const searchResults = document.getElementById('search-results');
          searchResults.innerHTML = '<div class="skeleton-card skeleton"></div><div class="skeleton-card skeleton"></div>';

          const params = new URLSearchParams({
            start: startYear,
            end: startYear + 9,
            limit: 300
          });

          console.log('[Decade Search] Loading:', startYear + 's');
          const response = await fetch(`/api/explore?${params}`);
          const data = await response.json();
          console.log('[Decade Search] Results:', data.total || 0, 'tracks found');

          state.searchResults = data.items || [];
          renderSearchResults();
        } catch (err) {
          console.error('[Decade Search] Failed:', err);
          const searchResults = document.getElementById('search-results');
          searchResults.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div><p>Failed to load decade</p></div>';
        }
      }

      if (discoverDecadeDropdown) {
        discoverDecadeDropdown.addEventListener('change', function() {
          const selectedValue = discoverDecadeDropdown.value;
          if (!selectedValue) {
            loadDiscover(); // Reload default discover content
            return;
          }

          const match = selectedValue.match(/^(\d{4})s$/);
          if (match) {
            const startYear = parseInt(match[1], 10);
            loadDecadeInDiscover(startYear);
          }
        });
      }

      if (searchDecadeDropdown) {
        searchDecadeDropdown.addEventListener('change', function() {
          const selectedValue = searchDecadeDropdown.value;
          if (!selectedValue) {
            return;
          }

          const match = selectedValue.match(/^(\d{4})s$/);
          if (match) {
            const startYear = parseInt(match[1], 10);
            loadDecadeInSearch(startYear);
          }
        });
      }
    })();
