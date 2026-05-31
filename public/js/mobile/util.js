// Small stateless UI/format helpers for the mobile app.

import { elements } from './state.js';

export function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  elements.toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

export function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function generateSessionId() {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
