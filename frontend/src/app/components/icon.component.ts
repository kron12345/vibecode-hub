import {
  Component,
  input,
  effect,
  ElementRef,
  inject,
} from '@angular/core';
import { createElement, icons } from 'lucide';

@Component({
  selector: 'app-icon',
  template: '',
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
  `,
})
export class IconComponent {
  name = input.required<string>();
  size = input<number>(20);
  strokeWidth = input<number>(2);

  private el = inject(ElementRef);

  constructor() {
    effect(() => {
      const iconName = this.name();
      const iconSize = this.size();
      const sw = this.strokeWidth();

      // Convert kebab-case to PascalCase for lucide lookup
      const pascalName = iconName
        .split('-')
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join('');

      const iconData = (icons as any)[pascalName];
      if (iconData) {
        const svg = createElement(iconData);
        svg.setAttribute('width', String(iconSize));
        svg.setAttribute('height', String(iconSize));
        svg.setAttribute('stroke-width', String(sw));
        this.el.nativeElement.innerHTML = '';
        this.el.nativeElement.appendChild(svg);
      }
    });
  }
}
