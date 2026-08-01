import React from 'react';
import ReactDOM from 'react-dom/client';
import { OverlayHud } from './OverlayHud';
import './overlay.css';

// The overlay renders into its own transparent, click-through BrowserWindow
// (overlay.html). It shares the same origin as the main window, so localStorage
// (libraryStore / customGameStore) is available for resolving game names.
ReactDOM.createRoot(document.getElementById('overlay-root')!).render(
  <React.StrictMode>
    <OverlayHud />
  </React.StrictMode>,
);
