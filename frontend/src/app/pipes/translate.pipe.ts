import { Pipe, PipeTransform, inject } from '@angular/core';
import { TranslateService } from '../services/translate.service';

@Pipe({
  name: 'translate',
  pure: false, // Impure so it reacts to language changes
})
export class TranslatePipe implements PipeTransform {
  private i18n = inject(TranslateService);

  transform(key: string, params?: Record<string, string | number>): string {
    // Access revision signal to trigger re-evaluation on language change
    this.i18n.revision();
    return this.i18n.t(key, params);
  }
}
