import { Injectable } from '@angular/core';

export interface AppConfig {
  apiUrl: string;
  keycloak: {
    url: string;
    realm: string;
    clientId: string;
  };
}

const DEFAULTS: AppConfig = {
  apiUrl: 'http://localhost:3100/api',
  keycloak: {
    url: 'http://localhost:8081',
    realm: 'vibcodehub',
    clientId: 'vibcodehub-frontend',
  },
};

/** Read config from window (set by main.ts before bootstrap) */
export function getAppConfig(): AppConfig {
  const raw = (window as any).__VIBCODE_CONFIG__;
  if (raw && typeof raw === 'object' && raw.apiUrl) {
    return raw as AppConfig;
  }
  return DEFAULTS;
}

@Injectable({ providedIn: 'root' })
export class AppConfigService {
  get apiUrl(): string {
    return getAppConfig().apiUrl;
  }

  get keycloak() {
    return getAppConfig().keycloak;
  }
}
