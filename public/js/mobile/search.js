// Catalogue search for the mobile app.

import { elements, state } from './state.js';
import { groupTracksByAlbum, hasValidArtwork, hasValidAudio } from './fields.js';
import { createAlbumCard } from './cards.js';

export async function search(query) {
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

export function renderSearchResults() {
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
