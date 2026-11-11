import { describe, expect, it } from 'vitest';
import { PULL_MAX, PULL_THRESHOLD, dampPull, isPullArmed } from '../src/services/pullToRefresh';

describe('pull-to-refresh damping', () => {
  it('ignores upward or zero travel', () => {
    expect(dampPull(0)).toBe(0);
    expect(dampPull(-40)).toBe(0);
  });

  it('moves slower than the finger and never exceeds the max', () => {
    expect(dampPull(30)).toBeLessThan(30);
    expect(dampPull(30)).toBeGreaterThan(20);
    expect(dampPull(5000)).toBeLessThanOrEqual(PULL_MAX);
  });

  it('is monotonic', () => {
    let prev = 0;
    for (let dy = 1; dy <= 400; dy += 7) {
      const v = dampPull(dy);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it('arms after a deliberate pull (~100–130 px), not after a small nudge', () => {
    expect(isPullArmed(dampPull(60))).toBe(false);
    expect(isPullArmed(dampPull(100))).toBe(false);
    expect(isPullArmed(dampPull(130))).toBe(true);
    expect(isPullArmed(PULL_THRESHOLD)).toBe(true);
  });
});
