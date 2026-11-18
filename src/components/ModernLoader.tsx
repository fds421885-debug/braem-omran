import React from 'react';

interface ModernLoaderProps {
  label?: string;
  fullScreen?: boolean;
}

export const ModernLoader: React.FC<ModernLoaderProps> = ({
  label = 'جاري التحديث والتحميل...',
  fullScreen = false,
}) => {
  const content = (
    <div className="flex flex-col items-center justify-center gap-4 p-6 text-center" role="status" aria-live="polite">
      <div className="relative w-16 h-16 flex items-center justify-center">
        {/* Outer soft cream track */}
        <div className="absolute inset-0 rounded-full border-4 border-[#F7EBDD]" />
        {/* Smooth rotating Fox-orange arc */}
        <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-[#F56900] border-r-[#FFA900] animate-spin" />
        {/* Inner counter-rotating subtle ring */}
        <div
          className="absolute inset-2.5 rounded-full border-[3px] border-transparent border-b-[#4A220D] animate-spin"
          style={{ animationDirection: 'reverse', animationDuration: '0.9s' }}
        />
        {/* Center emblem dot */}
        <div className="w-3.5 h-3.5 rounded-full bg-[#F56900]" />
      </div>

      <div className="space-y-1">
        <p className="font-display text-base sm:text-lg font-extrabold text-[#4A220D]">
          {label}
        </p>
      </div>
    </div>
  );

  if (fullScreen) {
    return (
      <div className="min-h-screen bg-[#FDF6EE] flex items-center justify-center p-4">
        <div className="bg-white border-2 border-[#EADBC8] rounded-3xl px-8 py-8 shadow-xs max-w-xs w-full">
          {content}
        </div>
      </div>
    );
  }

  return content;
};
