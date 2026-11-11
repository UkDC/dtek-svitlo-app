/**
 * Pure math for the pull-to-refresh gesture (kept apart from React so it can be unit-tested).
 *
 * The finger travel is damped so the indicator moves slower than the finger and never runs away:
 * at first it follows ~0.8:1, then it saturates towards PULL_MAX. The threshold is reached after
 * ~115 px of finger travel — close to the native iOS feel.
 */
export const PULL_THRESHOLD = 64; // px of indicator travel that arms the refresh
export const PULL_MAX = 110; // indicator never moves further than this
const PULL_SOFTNESS = 132; // larger = the indicator follows the finger longer before saturating

/** Maps raw finger travel (px, downwards) to the damped indicator offset. */
export function dampPull(rawDy: number): number {
  if (rawDy <= 0) return 0;
  return PULL_MAX * (1 - Math.exp(-rawDy / PULL_SOFTNESS));
}

/** True when releasing the finger at this indicator offset should start a refresh. */
export function isPullArmed(offset: number): boolean {
  return offset >= PULL_THRESHOLD;
}
