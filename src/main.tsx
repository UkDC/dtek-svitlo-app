import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Register Service Worker for offline blackout support and iOS 18.7+ Web Push
if ('serviceWorker' in navigator) {
  const checkAndRegisterSW = async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      if (reg.waiting) {
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      }

      // Actively trigger update check on initial open
      reg.update().catch(() => {});

      // Check on resume / visibility
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          reg.update().catch(() => {});
        }
      });
      window.addEventListener('pageshow', () => {
        reg.update().catch(() => {});
      });

      // Periodic check every 5 minutes
      setInterval(() => {
        reg.update().catch(() => {});
      }, 5 * 60_000);
    } catch {
      // ignore
    }
  };

  if (document.readyState === 'complete') {
    checkAndRegisterSW();
  } else {
    window.addEventListener('load', checkAndRegisterSW);
  }
}
