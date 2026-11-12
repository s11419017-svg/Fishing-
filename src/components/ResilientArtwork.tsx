import { useState } from 'react';
import { Sparkles } from 'lucide-react';

interface ResilientArtworkProps {
  src: string;
  alt: string;
  fallbackLabel: string;
  fallbackGradient?: string;
  className?: string;
  imgClassName?: string;
}

/**
 * Resilient image slot implementing the Zero-Broken-Image Policy:
 * Renders high-fidelity artwork with `referrerPolicy="no-referrer"`, and falls back
 * gracefully to a themed painterly gradient + emblem if loading ever fails.
 */
export function ResilientArtwork({
  src,
  alt,
  fallbackLabel,
  fallbackGradient = 'from-teal-950 via-slate-900 to-slate-950',
  className = '',
  imgClassName = 'w-full h-full object-cover',
}: ResilientArtworkProps) {
  const [failed, setFailed] = useState(false);

  return (
    <div className={`relative overflow-hidden bg-gradient-to-br ${fallbackGradient} ${className}`}>
      {!failed ? (
        <img
          src={src}
          alt={alt}
          referrerPolicy="no-referrer"
          loading="lazy"
          onError={() => setFailed(true)}
          className={imgClassName}
        />
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 p-3 text-center select-none">
          <Sparkles className="w-5 h-5 text-teal-300/75" />
          <span className="font-display text-xs font-semibold text-slate-200/90 tracking-wide">
            {fallbackLabel}
          </span>
        </div>
      )}
    </div>
  );
}
