import React from 'react';

interface EmptyStateProps {
  onAdd: () => void;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ onAdd }) => (
  <section className="empty-state">
    <div className="empty-ring">
      <svg width="220" height="220" viewBox="0 0 260 260" role="img" aria-label="Порожнє кільце доби">
        <circle
          cx="130"
          cy="130"
          r="100"
          fill="none"
          className="ring-empty"
          strokeWidth="26"
          strokeDasharray="6 10"
        />
      </svg>
      <svg
        className="empty-bulb"
        width="56"
        height="56"
        viewBox="0 0 24 24"
        fill="none"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M9 18h6" />
        <path d="M10 21h4" />
        <path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z" />
      </svg>
    </div>

    <h1 className="empty-title">Додайте адресу</h1>
    <p className="empty-text">
      Ми самі визначимо вашу групу відключень і сповістимо за 30 хвилин до змін.
    </p>

    <div className="empty-actions">
      <button type="button" className="cta-btn" onClick={onAdd}>
        Додати адресу
      </button>
      <p className="empty-foot">Київ і Київська область · дані ДТЕК</p>
    </div>
  </section>
);
