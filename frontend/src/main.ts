import { bootstrapApplication } from '@angular/platform-browser';
import { App } from './app/app';

// Load runtime config BEFORE Angular bootstraps.
fetch('/assets/config.json')
  .then((r) => (r.ok ? r.json() : null))
  .then(async (config) => {
    // Store config globally — must happen BEFORE any Angular code reads it
    (window as any).__VIBCODE_CONFIG__ = config ?? {};

    // Dynamic import so app.config.ts evaluates AFTER config is set
    const { appConfig } = await import('./app/app.config');
    return bootstrapApplication(App, appConfig);
  })
  .catch((err) => {
    console.error('Bootstrap failed:', err);
  });
