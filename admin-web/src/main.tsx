import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { AppDialogProvider } from './components/AppDialog';

createRoot(document.getElementById('root')!).render(
  <AppDialogProvider>
    <App />
  </AppDialogProvider>,
);
