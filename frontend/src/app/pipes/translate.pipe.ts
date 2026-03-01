import { Pipe, PipeTransform, inject, ChangeDetectorRef } from '@angular/core';
import { TranslateService } from '../services/translate.service';
import { effect } from '@angular/core';

@Pipe({
  name: 'translate',
  pure: false, // Impure so it re-evaluates on every CD cycle
})
export class TranslatePipe implements PipeTransform {
  private i18n = inject(TranslateService);
  private cdr = inject(ChangeDetectorRef);

  constructor() {
    // When language changes (revision signal updates), force change detection
    effect(() => {
      this.i18n.revision();
      this.cdr.markForCheck();
    });
  }

  transform(key: string, params?: Record<string, string | number>): string {
    // Read revision to ensure we get latest translations
    this.i18n.revision();
    return this.i18n.t(key, params);
  }
}
