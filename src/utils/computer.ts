/**
 * Playwright-based Computer Use implementation for voice agents
 * Optimized for Phreesia form navigation during calls
 * Implements OpenAI Agents SDK Computer interface
 */

import { chromium, Browser, Page } from 'playwright';
import type { Computer } from '@openai/agents';

const CUA_KEY_TO_PLAYWRIGHT_KEY: Record<string, string> = {
  '/': 'Divide',
  '\\': 'Backslash',
  alt: 'Alt',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  arrowup: 'ArrowUp',
  backspace: 'Backspace',
  capslock: 'CapsLock',
  cmd: 'Meta',
  ctrl: 'Control',
  delete: 'Delete',
  end: 'End',
  enter: 'Enter',
  esc: 'Escape',
  home: 'Home',
  insert: 'Insert',
  option: 'Alt',
  pagedown: 'PageDown',
  pageup: 'PageUp',
  shift: 'Shift',
  space: ' ',
  super: 'Meta',
  tab: 'Tab',
  win: 'Meta',
};

export class PhreesiaComputer {
  private _browser: Browser | null = null;
  private _page: Page | null = null;

  readonly dimensions: [number, number] = [1280, 720];
  readonly environment: 'browser' = 'browser';

  get browser(): Browser {
    if (!this._browser) throw new Error('Browser not initialized');
    return this._browser;
  }

  get page(): Page {
    if (!this._page) throw new Error('Page not initialized');
    return this._page;
  }

  asComputer(): Computer {
    return this as unknown as Computer;
  }

  async init(url: string = 'https://phreesia.me/AzulVisionDRS'): Promise<this> {
    const [width, height] = this.dimensions;
    this._browser = await chromium.launch({
      headless: true,
      args: [`--window-size=${width},${height}`, '--no-sandbox'],
    });
    this._page = await this._browser.newPage();
    await this._page.setViewportSize({ width, height });
    await this._page.goto(url, { waitUntil: 'networkidle' });
    console.log(`[Computer] Navigated to ${url}`);
    return this;
  }

  async dispose(): Promise<void> {
    console.log('[Computer] Disposing browser');
    if (this._browser) {
      await this._browser.close();
    }
    this._browser = null;
    this._page = null;
  }

  async screenshot(): Promise<string> {
    if (!this._page) throw new Error('Page not initialized');
    await this._page.waitForLoadState('networkidle');
    const buf = await this._page.screenshot({ fullPage: false });
    return Buffer.from(buf).toString('base64');
  }

  async click(
    x: number,
    y: number,
    button: 'left' | 'right' | 'wheel' | 'back' | 'forward' = 'left'
  ): Promise<void> {
    console.log(`[Computer] Clicking at (${x}, ${y})`);
    const playwrightButton: 'left' | 'right' | 'middle' = 
      button === 'right' ? 'right' : 'left';
    await this.page.mouse.click(x, y, { button: playwrightButton });
  }

  async doubleClick(x: number, y: number): Promise<void> {
    console.log(`[Computer] Double clicking at (${x}, ${y})`);
    await this.page.mouse.dblclick(x, y);
  }

  async move(x: number, y: number): Promise<void> {
    console.log(`[Computer] Moving to (${x}, ${y})`);
    await this.page.mouse.move(x, y);
  }

  async drag(path: [number, number][]): Promise<void> {
    console.log(`[Computer] Dragging through ${path.length} points`);
    if (path.length === 0) return;
    
    const [startX, startY] = path[0];
    await this.page.mouse.move(startX, startY);
    await this.page.mouse.down();
    
    for (const [x, y] of path.slice(1)) {
      await this.page.mouse.move(x, y);
    }
    
    await this.page.mouse.up();
  }

  async type(text: string): Promise<void> {
    console.log(`[Computer] Typing: ${text.substring(0, 50)}...`);
    await this.page.keyboard.type(text, { delay: 50 });
  }

  async scroll(x: number, y: number, scrollX: number, scrollY: number): Promise<void> {
    await this.page.mouse.move(x, y);
    await this.page.evaluate(
      ([sx, sy]) => window.scrollBy(sx, sy),
      [scrollX, scrollY]
    );
  }

  async keypress(keys: string[]): Promise<void> {
    const mappedKeys = keys.map(
      (key) => CUA_KEY_TO_PLAYWRIGHT_KEY[key.toLowerCase()] || key
    );
    for (const key of mappedKeys) {
      await this.page.keyboard.down(key);
    }
    for (const key of mappedKeys.reverse()) {
      await this.page.keyboard.up(key);
    }
  }

  async wait(ms: number = 1000): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Helper methods specific to Phreesia forms
  async fillInput(selector: string, value: string): Promise<boolean> {
    try {
      await this.page.waitForSelector(selector, { timeout: 5000 });
      await this.page.fill(selector, value);
      console.log(`[Computer] Filled ${selector} with value`);
      return true;
    } catch (error) {
      console.error(`[Computer] Failed to fill ${selector}:`, error);
      return false;
    }
  }

  async clickButton(text: string): Promise<boolean> {
    try {
      const button = await this.page.getByRole('button', { name: text });
      await button.click();
      console.log(`[Computer] Clicked button: ${text}`);
      return true;
    } catch (error) {
      console.error(`[Computer] Failed to click button ${text}:`, error);
      return false;
    }
  }

  async getCurrentUrl(): Promise<string> {
    return this.page.url();
  }

  async getPageText(): Promise<string> {
    return await this.page.textContent('body') || '';
  }
}
