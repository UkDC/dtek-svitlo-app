import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { PULL_THRESHOLD, dampPull, isPullArmed } from '../services/pullToRefresh';

interface PullToRefreshProps {
  /** Off while a sheet/modal is open: those have their own scroll containers. */
  enabled: boolean;
  /** Resolves when the refresh is done; the spinner stays until then. */
  onRefresh: () => Promise<unknown>;
  /** The page content that slides down with the finger (keep modals outside: a transformed
   *  ancestor breaks their position: fixed). */
  children: React.ReactNode;
}

// A fast (cached) response should still visibly "do something".
const MIN_SPIN_MS = 600;

/**
 * Swipe down from the very top of the page to refresh the schedules.
 *
 * Listens on `window` (the page itself scrolls, not an inner container) and only starts when the
 * page is already scrolled to the top, so normal scrolling is never hijacked. touchmove must be
 * non-passive to cancel iOS' own rubber-band while we draw the indicator.
 */
export const PullToRefresh: React.FC<PullToRefreshProps> = ({ enabled, onRefresh, children }) => {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  // Only refreshes started by this gesture show the spinner here — background polls don't.
  const [isRefreshing, setIsRefreshing] = useState(false);
  const startY = useRef<number | null>(null);
  const offsetRef = useRef(0);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  const refreshingRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    const reset = () => {
      startY.current = null;
      offsetRef.current = 0;
      setDragging(false);
      setOffset(0);
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1 || window.scrollY > 0 || refreshingRef.current) return;
      startY.current = e.touches[0].clientY;
    };

    const onMove = (e: TouchEvent) => {
      if (startY.current === null) return;
      const dy = e.touches[0].clientY - startY.current;
      if (dy <= 0 || window.scrollY > 0) {
        // Finger went up or the page scrolled: this is a normal scroll, let go.
        if (offsetRef.current !== 0) reset();
        else startY.current = null;
        return;
      }
      if (e.cancelable) e.preventDefault();
      const next = dampPull(dy);
      offsetRef.current = next;
      setDragging(true);
      setOffset(next);
    };

    const onEnd = () => {
      if (startY.current === null) return;
      const armed = isPullArmed(offsetRef.current);
      reset();
      if (!armed) return;
      refreshingRef.current = true;
      setIsRefreshing(true);
      const started = Date.now();
      Promise.resolve()
        .then(() => onRefreshRef.current())
        .catch(() => {})
        .then(() => new Promise((r) => setTimeout(r, Math.max(0, MIN_SPIN_MS - (Date.now() - started)))))
        .then(() => {
          refreshingRef.current = false;
          setIsRefreshing(false);
        });
    };

    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', reset);
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', reset);
      reset();
    };
  }, [enabled]);

  // While refreshing, park the indicator at the threshold; otherwise follow the finger.
  const shown = isRefreshing ? PULL_THRESHOLD : offset;
  const armed = isPullArmed(offset);
  const visible = shown > 0;

  return (
    <>
      <div
        className={`ptr ${dragging ? 'ptr-dragging' : ''}`}
        style={{
          // Centred in the gap that opens above the content (20 px = .app-shell top padding).
          transform: `translate(-50%, ${visible ? (20 + shown) / 2 - 18 : -44}px)`,
          opacity: visible ? Math.min(1, shown / PULL_THRESHOLD) : 0,
        }}
        aria-hidden={!isRefreshing}
        role="status"
      >
        <RefreshCw
          size={18}
          strokeWidth={2.2}
          className={isRefreshing ? 'spin' : ''}
          style={isRefreshing ? undefined : { transform: `rotate(${(offset / PULL_THRESHOLD) * 270}deg)` }}
          aria-hidden="true"
        />
        <span className="ptr-sr">{isRefreshing ? 'Оновлюємо графік' : armed ? 'Відпустіть, щоб оновити' : ''}</span>
      </div>
      <div
        className={`ptr-content ${dragging ? 'ptr-dragging' : ''}`}
        style={{ transform: visible ? `translateY(${shown}px)` : undefined }}
      >
        {children}
      </div>
    </>
  );
};
