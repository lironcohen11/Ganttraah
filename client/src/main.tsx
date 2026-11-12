import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/rubik';
// the stylesheet with both themes, generated from styles.css by scripts/make-dark.py
import './styles.themed.css';
import { initTheme } from './theme';
import { App } from './App';

initTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
