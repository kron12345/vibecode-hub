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
import { AppConfigService } from './services/app-config.service';

// Read pre-loaded config (loaded in main.ts before bootstrap)
const preloaded = (window as any).__APP_CONFIG__ as AppConfigService | undefined;
const keycloakConfig = preloaded?.keycloak ?? {
  url: 'http://localhost:8081',
  realm: 'vibcodehub',
  clientId: 'vibcodehub-frontend',
};

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideHttpClient(withInterceptors([includeBearerTokenInterceptor])),
    provideKeycloak({
      config: {
        url: keycloakConfig.url,
        realm: keycloakConfig.realm,
        clientId: keycloakConfig.clientId,
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
