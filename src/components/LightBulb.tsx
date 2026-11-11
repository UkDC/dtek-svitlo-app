import React, { useEffect, useRef, useState } from 'react';

interface LightBulbProps {
  isOn: boolean;
}

const GLASS =
  'M50 18c-14 0-24 10-24 23 0 8 4 14 9 19 3 3 4 6 4 9h22c0-3 1-6 4-9 5-5 9-11 9-19 0-13-10-23-24-23z';

/**
 * Status in the centre of the day ring, instead of the words «Світло є / Світла немає».
 * The two states differ by shape, not only colour: lit = yellow glass + pulsing rays,
 * unlit = grey glass, no rays. The words stay in aria-label for VoiceOver.
 * One-shot transitions (flicker on / filament cooling off) run only on a real state change,
 * never on first render.
 */
export const LightBulb: React.FC<LightBulbProps> = ({ isOn }) => {
  const prev = useRef(isOn);
  const [transition, setTransition] = useState<'' | 'is-igniting' | 'is-cooling'>('');

  useEffect(() => {
    if (prev.current === isOn) return;
    prev.current = isOn;
    setTransition(isOn ? 'is-igniting' : 'is-cooling');
    const t = setTimeout(() => setTransition(''), 1500);
    return () => clearTimeout(t);
  }, [isOn]);

  const label = isOn ? 'Світло є' : 'Світла немає';

  return (
    <svg
      className={`light-bulb ${isOn ? 'is-on' : 'is-off'} ${transition}`.trim()}
      viewBox="0 0 100 100"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <defs>
        <clipPath id="light-bulb-glass">
          <path d={GLASS} />
        </clipPath>
      </defs>
      <g className="light-bulb-rays light-bulb-lit">
        <line x1="50" y1="1" x2="50" y2="9" />
        <line x1="18" y1="13" x2="23.5" y2="18.5" />
        <line x1="82" y1="13" x2="76.5" y2="18.5" />
        <line x1="5" y1="41" x2="13" y2="41" />
        <line x1="95" y1="41" x2="87" y2="41" />
      </g>
      <path className="light-bulb-glass light-bulb-lit" d={GLASS} />
      <circle
        className="light-bulb-inner"
        cx="50"
        cy="44"
        r="16"
        clipPath="url(#light-bulb-glass)"
      />
      <path className="light-bulb-filament" d="M43 56l3.5-11 3.5 7 3.5-7 3.5 11" />
      <rect className="light-bulb-base" x="39" y="72" width="22" height="7" rx="2" />
      <rect className="light-bulb-base" x="42" y="81" width="16" height="6" rx="3" />
    </svg>
  );
};
