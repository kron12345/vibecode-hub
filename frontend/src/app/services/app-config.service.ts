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

/**
 * Runtime configuration loaded from /assets/config.json.
 *
 * This file is NOT part of the build — it can be changed after deployment
 * without rebuilding the frontend. Config is loaded BEFORE Angular bootstraps
 * (in main.ts), so Keycloak and API URLs are available immediately.
 *
 * The config.json is in .gitignore — only config.example.json is committed.
 */
@Injectable({ providedIn: 'root' })
export class AppConfigService {
  private config: AppConfig | null = null;

  constructor() {
    // Pick up pre-loaded config from main.ts (loaded before Angular bootstrap)
    const preloaded = (window as any).__APP_CONFIG__;
    if (preloaded instanceof AppConfigService) {
      this.config = (preloaded as any).config;
    }
  }

  get apiUrl(): string {
    return this.config?.apiUrl ?? DEFAULTS.apiUrl;
  }

  get keycloak() {
    return this.config?.keycloak ?? DEFAULTS.keycloak;
  }

  /**
   * Load config from /assets/config.json.
   * Called in main.ts BEFORE Angular bootstrap.
   */
  async load(): Promise<void> {
    try {
      const response = await fetch('/assets/config.json');
      if (!response.ok) {
        console.warn(
          `Failed to load config.json (${response.status}) — using defaults`,
        );
        return;
      }
      this.config = await response.json();
    } catch (err) {
      console.warn('Could not load config.json — using defaults:', err);
    }
  }
}
