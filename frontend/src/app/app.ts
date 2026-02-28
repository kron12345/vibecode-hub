import { Component } from '@angular/core';
import { RouterOutlet, RouterLink } from '@angular/router';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink],
  template: `
    <nav class="navbar">
      <a routerLink="/" class="logo">VibCode Hub</a>
    </nav>
    <main class="content">
      <router-outlet />
    </main>
  `,
  styles: `
    .navbar {
      display: flex;
      align-items: center;
      padding: 0 1.5rem;
      height: 56px;
      background: #1a1a2e;
      border-bottom: 1px solid #16213e;
    }
    .logo {
      color: #e94560;
      font-size: 1.25rem;
      font-weight: 700;
      text-decoration: none;
    }
    .content {
      padding: 1.5rem;
      max-width: 1400px;
      margin: 0 auto;
    }
  `,
})
export class App {}
