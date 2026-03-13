// public/js/genre-filters.js - Extracted from Script Block 3
// Auto-generated - do not edit manually

(function() {
  'use strict';

  // ---- CONSTANTS ----

      const MAX_GENRE_SELECTION = 5;
      // How many genre cards we want to show in the grid
      const GENRE_RESULT_LIMIT = 20;
  
      // Fetch just enough for quick display - reduced from 10x to 2.5x for speed
      const GENRE_FETCH_LIMIT = GENRE_RESULT_LIMIT * 2.5;
      const TRENDING_RESULT_LIMIT = 5;
      const TRENDING_FETCH_LIMIT = 25; // Fetch more to ensure 5 valid after filtering
      const GENRE_TITLE = 'Discover by Genre';

  // ---- STATE & GENRE OPTIONS ----

      let selectedGenres = loadStoredGenrePreferences();

      const GENRE_OPTIONS = [
        "50's",
        "50s",
        "60's",
        "60s",
        "70's",
        "80'",
        "80's",
        "90's",
        "Adult Contemporary",
        "Adult Contemporary (Singer/Songwriter",
        "Adult Contemporary (Singer/Songwriter)",
        "African",
        "African Jazz",
        "Amapiano",
        "Afro Beat",
        "Afro Dancehall",
        "Afro Folk",
        "Afro Fusion",
        "Afro House",
        "Afro Jazz",
        "Afro Pop",
        "Afro Pop ",
        "Afro Rock",
        "Afro Soul",
        "Afro-folk",
        "Afro-fusion",
        "Afro-Pop",
        "Big Band",
        "Blues",
        "Children",
        "Childrens Music",
        "Chillout",
        "Choral",
        "Christian",
        "Christmas",
        "Classic Lounge",
        "Classic Rock",
        "Classic Soul",
        "Classical",
        "Comedy",
        "Cool Jazz",
        "Country",
        "Country (Contemporary)",
        "Country (Traditional)",
        "Country Rock",
        "Dance",
        "Devotional",
        "Disco",
        "Easy Listening",
        "Electro Pop",
        "Electronic",
        "Film Scores",
        "Folk",
        "Folk (Singer/Songwriter)",
        "Funk",
        "Funky House",
        "Gospel",
        "Gqom",
        "Hip Hop",
        "Hip-Hop",
        "Inspirational",
        "Instrumental",
        "Isichathamiya",
        "Jazz",
        "Jazz (Contemporary)",
        "Jazz (Traditional)",
        "Jazz Fusion",
        "Jewish",
        "Jive 80s",
        "Kids",
        "Kwaito",
        "Latin",
        "Latin Music",
        "Live",
        "Live Recordings",
        "Maskandi",
        "Modern Classical",
        "Motswako",
        "Music Feature Films",
        "Musicals",
        "Oldies",
        "Other",
        "Pop",
        "Pop (Singer/Songwriter)",
        "Pop Rock",
        "Prog Rock",
        "R & B/Soul",
        "Reggae",
        "RnB",
        "Rock",
        "Smooth Jazz",
        "Soul",
        "Soul-Jazz",
        "Soundtrack",
        "Soundtracks",
        "Spoken Word",
        "Swing Music",
        "Traditional",
        "Vocal",
        "Volksmusik",
        "World",
        "World Music"
      ];

      let randomItems = [];
      let currentGenreRequestId = 0;
      let genreFetchController = null;
      let randomTitleDefault = 'Discover More';
      let randomSubtitleDefault = 'Find more fascinating picks from our archive';
      let genreResultOffset = 0;
      let genreResultTotal = 0;
      const genreRetryButton = document.getElementById('genreRetryButton');


  // ---- FUNCTIONS ----

      function cleanGenreLabel(value) {
        if (typeof value !== 'string') return '';
        return value.replace(/\s+/g, ' ').trim();
      }
  
      function normalizeGenreLabel(value) {
        if (!value && value !== 0) return '';
        return value
          .toString()
          .toLowerCase()
          .replace(/&/g, 'and')
          .replace(/[^a-z0-9]+/g, '')
          .trim();
      }
  
      function setGenreFeedback(message = '') {
        const feedbackEl = document.getElementById('genreFeedback');
        if (feedbackEl) {
          feedbackEl.textContent = message;
        }
      }
  
      function resetGenreSelect() {
        const selectEl = document.getElementById('genreSelect');
        if (!selectEl) return;
        selectEl.value = '';
        selectEl.classList.remove('has-value');
        if (selectEl.options.length) {
          selectEl.selectedIndex = 0;
        }
      }
  

      function loadStoredGenrePreferences() {
        try {
          const raw = localStorage.getItem(GENRE_PREF_STORAGE_KEY);
          if (!raw) return [];
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed)) return [];
          const cleaned = parsed
            .map((value) => (typeof value === 'string' ? value.trim() : ''))
            .filter(Boolean);
          if (cleaned.length > MAX_GENRE_SELECTION) {
            return cleaned.slice(0, MAX_GENRE_SELECTION);
          }
          return cleaned;
        } catch (err) {
          console.warn('[MADMusic] Failed to load genre preferences', err);
          return [];
        }
      }

      function persistGenrePreferences(genres) {
        try {
          const payload = Array.isArray(genres) ? genres : [];
          localStorage.setItem(GENRE_PREF_STORAGE_KEY, JSON.stringify(payload));
        } catch (err) {
          console.warn('[MADMusic] Failed to save genre preferences', err);
        }
      }

      function setGenreFeedback(message = '') {
        const feedbackEl = document.getElementById('genreFeedback');
        if (feedbackEl) {
          feedbackEl.textContent = message;
        }
      }
  

      function resetGenreSelect() {
        const selectEl = document.getElementById('genreSelect');
        if (!selectEl) return;
        selectEl.value = '';
        selectEl.classList.remove('has-value');
        if (selectEl.options.length) {
          selectEl.selectedIndex = 0;
        }
      }
  

      function updateGenreTags() {
        const container = document.getElementById('genreTags');
        const clearBtn = document.getElementById('clearGenres');
        if (!container) return;
  
        container.innerHTML = '';
  
        if (!selectedGenres.length) {
          if (clearBtn) clearBtn.classList.remove('visible');
          return;
        }
  
        const fragment = document.createDocumentFragment();
  
        selectedGenres.forEach((genre) => {
          const tag = document.createElement('span');
          tag.className = 'genre-tag';
  
          const label = document.createElement('span');
          label.textContent = genre;
  
          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.className = 'genre-tag-remove';
          removeBtn.setAttribute('aria-label', `Remove ${genre}`);
          removeBtn.textContent = '✕';
          removeBtn.addEventListener('click', () => {
            removeGenre(genre);
          });
  
          tag.appendChild(label);
          tag.appendChild(removeBtn);
          fragment.appendChild(tag);
        });
  
        container.appendChild(fragment);
        if (clearBtn) {
          clearBtn.classList.toggle('visible', selectedGenres.length > 0);
        }
      }
  
      function scrollToDiscoverSection() {
        const titleEl = document.getElementById('randomTitle');
        if (!titleEl) return;
  
        // Scroll to the discover section with smooth animation
        titleEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
  

      function handleGenreSelection(rawValue) {
        const label = cleanGenreLabel(rawValue);
        if (!label) {
          resetGenreSelect();
          return;
        }
  
        const normalized = normalizeGenreLabel(label);
        if (!normalized) {
          resetGenreSelect();
          return;
        }
  
        const alreadySelected = selectedGenres.some(
          (existing) => normalizeGenreLabel(existing) === normalized
        );
        if (alreadySelected) {
          setGenreFeedback(`${label} is already selected`);
          resetGenreSelect();
          return;
        }
  
        if (selectedGenres.length >= MAX_GENRE_SELECTION) {
          setGenreFeedback(`You can select up to ${MAX_GENRE_SELECTION} genres`);
          resetGenreSelect();
          return;
        }
  
        selectedGenres = [...selectedGenres, label];
        persistGenrePreferences(selectedGenres);
        resetGenrePagination();
        setGenreFeedback('');
        updateGenreTags();
        resetGenreSelect();
  
        // Scroll to discover section when genre is selected
        scrollToDiscoverSection();
  
        if (isSearching) {
          clearSearch();
        } else {
          syncGenreFilters();
        }
      }
  

      function removeGenre(label) {
        const normalized = normalizeGenreLabel(label);
        const nextGenres = selectedGenres.filter(
          (item) => normalizeGenreLabel(item) !== normalized
        );
        if (nextGenres.length === selectedGenres.length) return;
        selectedGenres = nextGenres;
        persistGenrePreferences(selectedGenres);
        resetGenrePagination();
        setGenreFeedback('');
        updateGenreTags();
        syncGenreFilters();
      }
  

      function clearSelectedGenres() {
        if (!selectedGenres.length) return;
        selectedGenres = [];
        persistGenrePreferences(selectedGenres);
        setGenreFeedback('');
        updateGenreTags();
        resetGenreSelect();
        resetGenrePagination();
        syncGenreFilters({ forceReloadRandom: true });
      }
  
      function resetGenrePagination() {
        genreResultOffset = 0;
        genreResultTotal = 0;
      }
  

      function updateGenreRetryButton() {
        if (!genreRetryButton) return;
        const hasGenres = selectedGenres.length > 0;
        if (!hasGenres) {
          genreRetryButton.hidden = true;
          genreRetryButton.disabled = false;
          genreRetryButton.textContent = 'Get More Songs';
          return;
        }
        genreRetryButton.hidden = false;
  
        const loading = Boolean(genreFetchController);
        genreRetryButton.disabled = loading;
        genreRetryButton.textContent = loading ? 'Searching…' : 'Get More Songs';
      }
  
      function setDiscoverTitle(isGenreMode) {
        const titleEl = document.getElementById('randomTitle');
        if (!titleEl) return;
        titleEl.textContent = isGenreMode ? GENRE_TITLE : randomTitleDefault;
      }
  
      function setDiscoverSubtitleDefault() {
        const subtitleEl = document.getElementById('randomSubtitle');
        if (subtitleEl) {
          subtitleEl.textContent = randomSubtitleDefault;
        }
      }
  
      function setGenreSubtitle(state, count = 0) {
        const subtitleEl = document.getElementById('randomSubtitle');
        if (!subtitleEl) return;
        const readableGenres = selectedGenres.join(', ');
        if (!readableGenres) {
          subtitleEl.textContent = randomSubtitleDefault;
          return;
        }
        if (state === 'loading') {
          subtitleEl.textContent = `Searching ${readableGenres}...`;
        } else if (state === 'error') {
          subtitleEl.textContent = `Could not load ${readableGenres}. Try again.`;
        } else if (state === 'empty') {
          subtitleEl.textContent = `No tracks found for ${readableGenres}`;
        } else {
          subtitleEl.textContent = `Showing ${count} track${count === 1 ? '' : 's'} for ${readableGenres}`;
        }
      }
  

      function syncGenreFilters(options = {}) {
        const { forceReloadRandom = false } = options;
        if (isSearching) return;
        updateGenreRetryButton();
        if (!selectedGenres.length) {
          if (genreFetchController) {
            genreFetchController.abort();
            genreFetchController = null;
          }
          resetGenrePagination();
          setDiscoverTitle(false);
          if (randomItems.length && !forceReloadRandom) {
            setDiscoverSubtitleDefault();
            renderRandom(randomItems);
          } else {
            loadRandom(true);
          }
          return;
        }
        loadGenreResults();
      }
  

      async function loadGenreResults() {
        if (!selectedGenres.length || isSearching) {
          return;
        }
  
        if (genreFetchController) {
          genreFetchController.abort();
        }
  
        setDiscoverTitle(true);
        setGenreSubtitle('loading');
  
        const container = document.getElementById('randomContainer');
        if (container) {
          container.innerHTML = `
            <div class="loading">
              <div class="spinner"></div>
              <p>Loading songs...</p>
            </div>
          `;
        }
  
        const params = new URLSearchParams();
  
        // Use random offset for variety when offset is 0 (initial load or after clearing genres)
        let effectiveOffset = genreResultOffset;
        if (effectiveOffset === 0) {
          // Random offset between 0 and 100 to get different results each time
          effectiveOffset = Math.floor(Math.random() * 100);
        }
  
        // Over-fetch so we can ensure 12 distinct albums after dedupe
        params.set('limit', String(GENRE_FETCH_LIMIT));
        params.set('offset', String(Math.max(0, effectiveOffset)));
        selectedGenres.forEach((genre) => {
          params.append('genre', genre);
        });
  
        const controller = new AbortController();
        genreFetchController = controller;
        const requestId = ++currentGenreRequestId;
        updateGenreRetryButton();
  
        try {
          const response = await apiFetch(`${API.search}?${params.toString()}`, { signal: controller.signal });
          const data = await response.json();
          if (requestId !== currentGenreRequestId) return;
  
          const items = Array.isArray(data.items) ? data.items : [];
  
          // Group results by album and only keep the first track per album
          const albums = groupByAlbum(items);
          const representativeTracks = albums
            .map((album) => album.tracks[0])
            .filter(Boolean);
  
          // Shuffle for additional randomness
          const shuffledTracks = shuffleArray(representativeTracks);
          const displayedTracks = shuffledTracks.slice(0, GENRE_RESULT_LIMIT);
  
          // Render all at once - faster with reduced fetch size
          renderRandom(displayedTracks);
  
          if (displayedTracks.length) {
            setGenreSubtitle('success', displayedTracks.length);
          } else {
            setGenreSubtitle('empty');
          }
  
          const parsedTotal = Number(data.total);
          genreResultTotal = Number.isFinite(parsedTotal) ? parsedTotal : representativeTracks.length;
          const rawReturned = Number.isFinite(Number(data.rawReturnedCount))
            ? Number(data.rawReturnedCount)
            : items.length;
          const responseOffset = Number.isFinite(Number(data.offset)) ? Number(data.offset) : 0;
          genreResultOffset = responseOffset + (rawReturned || 0);
          if (genreResultTotal && genreResultOffset >= genreResultTotal) {
            genreResultOffset = 0;
          }
        } catch (error) {
          if (requestId !== currentGenreRequestId) return;
          if (error?.name === 'AbortError') {
            return;
          }
          console.error('[Genre Filter] Failed to load:', error);
          if (container) {
            container.innerHTML = `
              <div class="empty-state">
                <div class="empty-state-icon">⚠️</div>
                <p>Failed to load genre results</p>
              </div>
            `;
          }
          setGenreSubtitle('error');
        } finally {
          if (requestId === currentGenreRequestId) {
            genreFetchController = null;
          }
          updateGenreRetryButton();
        }
      }
  

      function populateGenreDropdown(targetEl) {
        const selectEl = targetEl || document.getElementById('genreSelect');
        if (!selectEl) return;
        const seen = new Set();
        const fragment = document.createDocumentFragment();
        for (const rawGenre of GENRE_OPTIONS) {
          const label = cleanGenreLabel(rawGenre);
          const normalized = normalizeGenreLabel(label);
          if (!label || !normalized || seen.has(normalized)) continue;
          seen.add(normalized);
          const option = document.createElement('option');
          option.value = label;
          option.textContent = label;
          fragment.appendChild(option);
        }
        selectEl.appendChild(fragment);
      }
  
      // Stream Event Tracking Functions

  // ---- PUBLIC API ----

  window.MADGenre = {
    handleGenreSelection,
    removeGenre,
    clearSelectedGenres,
    loadGenreResults,
    syncGenreFilters,
    populateGenreDropdown,
    updateGenreTags,
    setGenreFeedback,
    loadStoredGenrePreferences
  };

  // Direct window assignments for onclick compatibility
  window.handleGenreSelection = handleGenreSelection;
  window.clearSelectedGenres = clearSelectedGenres;
  window.removeGenre = removeGenre;
  window.populateGenreDropdown = populateGenreDropdown;
  window.syncGenreFilters = syncGenreFilters;
})();