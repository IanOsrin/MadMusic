// Tab navigation + genre/decade filters for the mobile app.

import { DECADES, GENRES } from './data.js?v=14';
import { state } from './state.js?v=14';
import { loadPlaylists } from './playlists.js?v=14';
import { loadDiscover } from './rails-discover.js?v=14';
import { loadG100, loadG100Playlists, loadScenes } from './rails-g100.js?v=14';
import { loadNewReleases } from './rails-newreleases.js?v=14';
import { pushTab, isRestoring } from './router.js?v=14';

// Tabs reached through the Browse hub rather than the bottom bar. They keep
// the bar at four thumb-reachable items — a new rail gets a Browse card, not a
// fifth, sixth, seventh bottom-bar slot.
export const BROWSE_TABS = ['g100', 'discover', 'genres', 'decades', 'scenes', 'madabout'];

export function switchTab(tabName) {
      const wasAlreadyActive = state.currentTab === tabName;
      state.currentTab = tabName;

      // Inside a Browse sub-tab the bar highlights Browse, so the user can see
      // where they are. 'profile' lights nothing — it lives in the header badge.
      const navTab = BROWSE_TABS.includes(tabName) ? 'browse' : tabName;
      document.querySelectorAll('.tab-button').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === navTab);
      });

      // …and the sub-tab gets an explicit way back up, so nobody is stranded
      // if they don't use the system back gesture.
      const back = document.getElementById('browse-back');
      if (back) back.hidden = !BROWSE_TABS.includes(tabName);

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
      } else if (tabName === 'scenes') {
        if (!state.scenesLoaded || wasAlreadyActive) loadScenes();
      } else if (tabName === 'madabout') {
        if (!state.g100PlaylistsLoaded || wasAlreadyActive) loadG100Playlists();
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

      // Record this tab switch in browser history so Back/Forward traverse tabs.
      // Skip during popstate restore, and when re-tapping the active tab (refresh only).
      if (!wasAlreadyActive && !isRestoring()) pushTab(tabName);
    }

// Genres come from /api/genres — distinct values scanned from ACTUAL catalogue
// records — so every button is guaranteed to have music behind it. The static
// GENRES list is only the instant first paint + offline fallback: it renders
// immediately, then the live list replaces it as soon as the fetch lands.
let _liveGenres = null;
async function fetchLiveGenres() {
      if (_liveGenres) return _liveGenres;
      try {
        const res = await fetch('/api/genres');
        const data = await res.json();
        if (Array.isArray(data.genres) && data.genres.length) {
          _liveGenres = ['All', ...data.genres];
        }
      } catch { /* keep fallback */ }
      return _liveGenres;
    }

export function renderGenres() {
      const container = document.getElementById('genres-content');

      const paint = (list) => {
        container.innerHTML = '';
        list.forEach(genre => {
          const btn = document.createElement('button');
          btn.className = 'genre-btn';
          btn.textContent = genre;
          if (state.selectedGenre === genre) {
            btn.classList.add('active');
          }
          btn.addEventListener('click', () => selectGenre(genre));
          container.appendChild(btn);
        });
      };

      paint(_liveGenres || GENRES);
      if (!_liveGenres) fetchLiveGenres().then(live => { if (live) paint(live); });
    }

window.selectGenre = function(genre) {
      state.selectedGenre = genre;
      renderGenres();

      // Switch to discover tab and filter
      switchTab('discover');
      loadDiscover();
    };

export function renderDecades() {
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

export function selectDecade(startYear) {
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
