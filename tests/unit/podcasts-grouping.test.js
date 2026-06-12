import { describe, it, expect } from 'vitest';
import { groupPodcastRecords } from '../../routes/podcasts.js';

const row = (overrides = {}, recordId = '1') => ({
  recordId,
  fieldData: {
    'Show Title': 'Vault Stories',
    'Host': 'Thandi M',
    'Artwork_S3_URL': 'https://bucket.s3.amazonaws.com/artwork/podcast-vault-stories.jpg',
    'Category': 'Music History',
    'Language Code': 'en',
    'Episode Title': 'Episode',
    'Episode Number': 1,
    'Description': 'notes',
    'S3_URL': 'https://bucket.s3.amazonaws.com/podcasts/audio/vault-stories/001.mp3',
    'DurationSec': 1800,
    'PublishDate': '01/15/2026',
    'Visibility': 'Show',
    'Featured': '',
    'Explicit': 0,
    'PodcastID': 'P1',
    ...overrides
  }
});

describe('groupPodcastRecords', () => {
  it('groups episode rows into one card per show', () => {
    const { shows } = groupPodcastRecords([
      row({ 'Episode Title': 'Ep 1', 'Episode Number': 1 }, '1'),
      row({ 'Episode Title': 'Ep 2', 'Episode Number': 2 }, '2'),
      row({ 'Show Title': 'Other Show', 'Episode Title': 'Solo' }, '3')
    ]);
    expect(shows).toHaveLength(2);
    const vault = shows.find((s) => s.showTitle === 'Vault Stories');
    expect(vault.episodes).toHaveLength(2);
    expect(vault.episodeCount).toBe(2);
  });

  it('show key is case-insensitive on title and ignores host variations', () => {
    const { shows } = groupPodcastRecords([
      row({ 'Show Title': 'Vault Stories', 'Host': 'Thandi M' }, '1'),
      row({ 'Show Title': 'VAULT STORIES', 'Host': '' }, '2')
    ]);
    expect(shows).toHaveLength(1);
    expect(shows[0].host).toBe('Thandi M'); // gap-filled, not blanked
  });

  it('excludes hidden and unplayable rows', () => {
    const { shows, skipped } = groupPodcastRecords([
      row({}, '1'),
      row({ Visibility: 'Hide' }, '2'),
      row({ S3_URL: '' }, '3'),
      row({ S3_URL: 'not-a-url' }, '4')
    ]);
    expect(shows[0].episodes).toHaveLength(1);
    expect(skipped).toBe(3);
  });

  it('treats empty visibility as visible (catalogue convention)', () => {
    const { shows } = groupPodcastRecords([row({ Visibility: '' }, '1')]);
    expect(shows).toHaveLength(1);
  });

  it('sorts episodes newest-first and stamps latestPublishDate', () => {
    const { shows } = groupPodcastRecords([
      row({ 'Episode Title': 'Old', PublishDate: '03/01/2025', 'Episode Number': 1 }, '1'),
      row({ 'Episode Title': 'New', PublishDate: '02/20/2026', 'Episode Number': 2 }, '2')
    ]);
    expect(shows[0].episodes.map((e) => e.title)).toEqual(['New', 'Old']);
    expect(shows[0].latestPublishDate).toBe('2026-02-20');
  });

  it('converts FM MM/DD/YYYY dates to ISO', () => {
    const { shows } = groupPodcastRecords([row({ PublishDate: '01/05/2026' }, '1')]);
    expect(shows[0].episodes[0].publishDate).toBe('2026-01-05');
  });

  it('marks a show featured if ANY of its rows is featured, and ranks it first', () => {
    const { shows } = groupPodcastRecords([
      row({ 'Show Title': 'Plain Show', PublishDate: '02/01/2026' }, '1'),
      row({ 'Show Title': 'Star Show', Featured: 'yes', PublishDate: '01/01/2020' }, '2'),
      row({ 'Show Title': 'Star Show', Featured: '', PublishDate: '01/02/2020' }, '3')
    ]);
    expect(shows[0].showTitle).toBe('Star Show');
    expect(shows[0].featured).toBe(true);
    expect(shows[1].featured).toBe(false);
  });

  it('parses explicit flag and numeric fields', () => {
    const { shows } = groupPodcastRecords([
      row({ Explicit: 1, DurationSec: '1234.5', 'Episode Number': '7' }, '1')
    ]);
    const ep = shows[0].episodes[0];
    expect(ep.explicit).toBe(true);
    expect(ep.durationSec).toBe(1234.5);
    expect(ep.episodeNumber).toBe(7);
  });
});
