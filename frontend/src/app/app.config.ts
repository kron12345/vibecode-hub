import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  provideKeycloak,
  withAutoRefreshToken,
  AutoRefreshTokenService,
  UserActivityService,
  INCLUDE_BEARER_TOKEN_INTERCEPTOR_CONFIG,
  includeBearerTokenInterceptor,
} from 'keycloak-angular';
import { routes } from './app.routes';
import { getAppConfig } from './services/app-config.service';

// This is called AFTER main.ts has loaded config.json and set window.__VIBCODE_CONFIG__
// because main.ts awaits the fetch before calling bootstrapApplication.
const cfg = getAppConfig();

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideHttpClient(withInterceptors([includeBearerTokenInterceptor])),
    provideKeycloak({
      config: {
        url: cfg.keycloak.url,
        realm: cfg.keycloak.realm,
        clientId: cfg.keycloak.clientId,
      },
      initOptions: {
        onLoad: 'login-required',
        pkceMethod: 'S256',
      },
      features: [withAutoRefreshToken({ sessionTimeout: 300000 })],
      providers: [AutoRefreshTokenService, UserActivityService],
    }),
    {
      provide: INCLUDE_BEARER_TOKEN_INTERCEPTOR_CONFIG,
      useValue: [{ urlPattern: /\/api\//, httpMethods: [] }],
    },
  ],
};
