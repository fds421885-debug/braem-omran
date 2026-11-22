import {createRoot} from 'react-dom/client';
import {initPwaAndNotificationUpdater} from './services/pwaUpdateService';
import App from './App.tsx';
import './index.css';

initPwaAndNotificationUpdater();

createRoot(document.getElementById('root')!).render(<App />);
