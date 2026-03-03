import { Logger } from '@nestjs/common';

export interface PageCapture {
  route: string;
  screenshotBase64: string;
  domSnapshot: string;
  consoleErrors: string[];
}

export interface A11yViolation {
  id: string;
  impact: string;
  description: string;
  helpUrl: string;
  nodes: number;
}

export interface A11yResult {
  route: string;
  violations: A11yViolation[];
  passes: number;
}

export interface ResponsiveCapture {
  viewport: string;
  width: number;
  height: number;
  screenshotBase64: string;
}

export interface ResponsiveResult {
  route: string;
  captures: ResponsiveCapture[];
}

const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
];

const logger = new Logger('PlaywrightRunner');

/**
 * Utility class for Playwright browser automation.
 * Playwright is treated as an optional dependency — if not installed,
 * all methods return null and the UI Tester falls back to LLM-only analysis.
 */
export class PlaywrightRunner {
  private playwright: any = null;

  async init(): Promise<boolean> {
    try {
      this.playwright = await import('playwright');
      return true;
    } catch {
      logger.warn('Playwright not installed — UI tests will use LLM-only fallback');
      return false;
    }
  }

  /**
   * Capture screenshots + DOM + console errors for each route.
   */
  async capturePages(baseUrl: string, routes: string[]): Promise<PageCapture[]> {
    if (!this.playwright) return [];

    const browser = await this.playwright.chromium.launch({ headless: true });
    const captures: PageCapture[] = [];

    try {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        ignoreHTTPSErrors: true,
      });

      for (const route of routes) {
        const page = await context.newPage();
        const consoleErrors: string[] = [];

        page.on('console', (msg: any) => {
          if (msg.type() === 'error') {
            consoleErrors.push(msg.text());
          }
        });

        try {
          const url = `${baseUrl.replace(/\/$/, '')}${route}`;
          await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });

          const screenshot = await page.screenshot({ type: 'png' });
          const dom = await page.content();

          captures.push({
            route,
            screenshotBase64: screenshot.toString('base64'),
            domSnapshot: dom.substring(0, 50_000), // Limit DOM size
            consoleErrors,
          });
        } catch (err) {
          logger.warn(`Failed to capture ${route}: ${err.message}`);
          captures.push({
            route,
            screenshotBase64: '',
            domSnapshot: '',
            consoleErrors: [`Page load failed: ${err.message}`],
          });
        } finally {
          await page.close();
        }
      }
    } finally {
      await browser.close();
    }

    return captures;
  }

  /**
   * Check accessibility using axe-core (injected via Playwright).
   */
  async checkAccessibility(baseUrl: string, route: string): Promise<A11yResult | null> {
    if (!this.playwright) return null;

    const browser = await this.playwright.chromium.launch({ headless: true });

    try {
      const page = await browser.newPage();
      const url = `${baseUrl.replace(/\/$/, '')}${route}`;
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });

      // Inject axe-core
      await page.addScriptTag({
        url: 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js',
      });

      const results = await page.evaluate(() => {
        return (window as any).axe.run();
      });

      return {
        route,
        violations: results.violations.map((v: any) => ({
          id: v.id,
          impact: v.impact,
          description: v.description,
          helpUrl: v.helpUrl,
          nodes: v.nodes.length,
        })),
        passes: results.passes.length,
      };
    } catch (err) {
      logger.warn(`Accessibility check failed for ${route}: ${err.message}`);
      return null;
    } finally {
      await browser.close();
    }
  }

  /**
   * Capture screenshots at multiple viewports for responsive testing.
   */
  async checkResponsive(baseUrl: string, route: string): Promise<ResponsiveResult | null> {
    if (!this.playwright) return null;

    const browser = await this.playwright.chromium.launch({ headless: true });
    const captures: ResponsiveCapture[] = [];

    try {
      for (const vp of VIEWPORTS) {
        const context = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          ignoreHTTPSErrors: true,
        });
        const page = await context.newPage();

        try {
          const url = `${baseUrl.replace(/\/$/, '')}${route}`;
          await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });

          const screenshot = await page.screenshot({ type: 'png' });
          captures.push({
            viewport: vp.name,
            width: vp.width,
            height: vp.height,
            screenshotBase64: screenshot.toString('base64'),
          });
        } catch (err) {
          logger.warn(`Responsive check failed for ${route} @ ${vp.name}: ${err.message}`);
        } finally {
          await page.close();
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }

    return { route, captures };
  }
}
