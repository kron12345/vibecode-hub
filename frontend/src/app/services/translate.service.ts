import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';

export const SUPPORTED_LOCALES = ['de', 'en', 'it', 'fr'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
const DEFAULT_LOCALE: Locale = 'de';

@Injectable({ providedIn: 'root' })
export class TranslateService {
  private http = inject(HttpClient);
  private translations = signal<Record<string, string>>({});

  /** Current locale as a signal — components can react to changes */
  readonly locale = signal<Locale>(DEFAULT_LOCALE);

  /** Revision counter — incremented on every language load to trigger pipe updates */
  readonly revision = signal(0);

  constructor() {
    this.loadLocale(DEFAULT_LOCALE);
  }

  /** Switch language at runtime */
  use(locale: Locale): void {
    if (!SUPPORTED_LOCALES.includes(locale)) return;
    this.locale.set(locale);
    this.loadLocale(locale);
  }

  /** Get a translation by dot-notation key, e.g. "dashboard.title" */
  t(key: string, params?: Record<string, string | number>): string {
    const value = this.translations()[key];
    if (!value) return key;
    if (!params) return value;

    // Replace {paramName} placeholders
    return value.replace(/\{(\w+)\}/g, (_, name) =>
      params[name] !== undefined ? String(params[name]) : `{${name}}`,
    );
  }

  /** Get the BCP-47 locale tag for date/number formatting */
  get dateLocale(): string {
    const map: Record<Locale, string> = {
      de: 'de-DE',
      en: 'en-US',
      it: 'it-IT',
      fr: 'fr-FR',
    };
    return map[this.locale()] ?? 'de-DE';
  }

  private loadLocale(locale: Locale): void {
    this.http
      .get<Record<string, unknown>>(`/assets/i18n/${locale}.json`)
      .subscribe({
        next: (data) => {
          this.translations.set(this.flatten(data));
          this.revision.update((r) => r + 1);
        },
        error: () => {
          // Fallback to default if locale file not found
          if (locale !== DEFAULT_LOCALE) {
            this.loadLocale(DEFAULT_LOCALE);
          }
        },
      });
  }

  /** Flatten nested JSON to dot-notation keys: { a: { b: "x" } } → { "a.b": "x" } */
  private flatten(
    obj: Record<string, unknown>,
    prefix = '',
  ): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        Object.assign(result, this.flatten(value as Record<string, unknown>, fullKey));
      } else {
        result[fullKey] = String(value);
      }
    }
    return result;
  }
}
