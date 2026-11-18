import React from 'react';
import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div
      role="status"
      className="fixed bottom-20 md:bottom-4 right-4 z-50 flex items-center gap-2 rounded-2xl bg-[#4A220D] text-[#FDF6EE] px-4 py-2.5 text-xs font-bold shadow-lg border border-[#F56900]"
    >
      <WifiOff className="w-4 h-4 text-[#FFA900] shrink-0" />
      <span>وضع عدم الاتصال — يتم عرض البيانات المحفوظة</span>
    </div>
  );
};
