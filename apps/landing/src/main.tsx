import './app-ui.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { LandingPage } from '@/components/landing/landing-page';

document.documentElement.classList.add('theme-dark');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LandingPage />
  </React.StrictMode>,
);
