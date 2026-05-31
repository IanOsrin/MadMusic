// Tab navigation + genre/decade filters for the mobile app.

import { DECADES, GENRES } from './data.js';
import { state } from './state.js';
import { loadPlaylists } from './playlists.js';
import { loadDiscover, loadG100, loadG100Playlists, loadNewReleases } from './rails.js';

export function switchTab(tabName) {
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

export function renderGenres() {
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
