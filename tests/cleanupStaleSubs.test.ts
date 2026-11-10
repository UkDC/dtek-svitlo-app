import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  pickSubscribersToRemove,
  removeSubscriber,
  KNOWN_STALE_IDS,
} from '../scripts/cleanup-stale-subs.ts';

describe('cleanup-stale-subs', () => {
  describe('pickSubscribersToRemove', () => {
    it('picks known stale subscriber IDs while preserving active subscriber', () => {
      const subs = [
        { id: 'ios_57139a8c90424dca9f54336c643cdc98', updatedAt: '2026-11-09T10:00:00Z' },
        { id: 'ios_8919081054764878abec8f4ba446fcf1', updatedAt: '2026-11-09T12:00:00Z' },
        { id: 'ios_e0e07afb544a45e389f99814ed33dc09', updatedAt: '2026-11-09T08:00:00Z' },
        { id: 'ios_29c5ee1ff9ea404d91d20f12463ff7cb', updatedAt: '2026-11-10T14:00:00Z' },
      ];

      const toRemove = pickSubscribersToRemove(subs);
      expect(toRemove.map((s) => s.id)).toEqual([
        'ios_57139a8c90424dca9f54336c643cdc98',
        'ios_8919081054764878abec8f4ba446fcf1',
        'ios_e0e07afb544a45e389f99814ed33dc09',
      ]);
    });

    it('honors custom target IDs when specified', () => {
      const subs = [
        { id: 'sub_1', updatedAt: '2026-11-10T01:00:00Z' },
        { id: 'sub_2', updatedAt: '2026-11-10T02:00:00Z' },
      ];

      const toRemove = pickSubscribersToRemove(subs, new Set(['sub_1']));
      expect(toRemove.map((s) => s.id)).toEqual(['sub_1']);
    });

    it('falls back to keeping the newest subscriber if unknown multiple subscribers exist', () => {
      const subs = [
        { id: 'older_1', updatedAt: '2026-11-01T00:00:00Z' },
        { id: 'older_2', updatedAt: '2026-11-05T00:00:00Z' },
        { id: 'newest', updatedAt: '2026-11-10T00:00:00Z' },
      ];

      const toRemove = pickSubscribersToRemove(subs);
      expect(toRemove.map((s) => s.id)).toEqual(['older_1', 'older_2']);
    });

    it('does not remove single subscriber when no known stale match exists', () => {
      const subs = [{ id: 'active_only', updatedAt: '2026-11-10T00:00:00Z' }];
      expect(pickSubscribersToRemove(subs)).toEqual([]);
    });
  });

  describe('removeSubscriber', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('calls internal remove API with authorization and returns success', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, removed: true }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await removeSubscriber(
        'https://example.com',
        'test-secret',
        'https://push.apple.com/endpoint123'
      );

      expect(result).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith('https://example.com/internal/remove', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ endpoint: 'https://push.apple.com/endpoint123' }),
        signal: expect.anything(),
      });
    });

    it('handles HTTP error gracefully', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await removeSubscriber(
        'https://example.com',
        'test-secret',
        'https://push.apple.com/endpoint123'
      );

      expect(result).toBe(false);
    });
  });
});
