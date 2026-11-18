import React, { useState } from 'react';

interface MascotImageProps {
  src: string;
  alt: string;
  className?: string;
}

export const MascotImage: React.FC<MascotImageProps> = ({ src, alt, className = '' }) => {
  const [hasError, setHasError] = useState(false);

  if (hasError) {
    return (
      <div
        className={`flex flex-col items-center justify-center bg-white rounded-3xl p-4 ${className}`}
        aria-label={alt}
      >
        <svg viewBox="0 0 128 128" className="w-32 h-32">
          <circle cx="64" cy="68" r="42" fill="#F56900" />
          <path d="M28 42 L46 18 L56 44 Z" fill="#F56900" />
          <path d="M100 42 L82 18 L72 44 Z" fill="#F56900" />
          <ellipse cx="64" cy="84" rx="26" ry="20" fill="#FDF6EE" />
          <circle cx="50" cy="60" r="6" fill="#4A220D" />
          <circle cx="78" cy="60" r="6" fill="#4A220D" />
          <ellipse cx="64" cy="70" rx="5" ry="3.5" fill="#4A220D" />
        </svg>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => setHasError(true)}
      className={`object-contain select-none ${className}`}
    />
  );
};
