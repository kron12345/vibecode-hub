import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { AppConfigService } from './app/services/app-config.service';

// Load runtime config BEFORE Angular bootstraps
// This ensures Keycloak URLs are available when provideKeycloak() runs
const configService = new AppConfigService();
configService.load().then(() => {
  // Store the loaded config globally so Angular DI can pick it up
  (window as any).__APP_CONFIG__ = configService;

  bootstrapApplication(App, appConfig).catch((err) => console.error(err));
});
