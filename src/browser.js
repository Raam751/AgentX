const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || './screenshots';

// ═════════════════════════════════════════════════════════════════════════════
// Browser — Playwright wrapper with iframe-aware element extraction
// ═════════════════════════════════════════════════════════════════════════════

class Browser {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  async launch() {
    const headless = process.env.HEADLESS === 'true';
    this.browser = await chromium.launch({
      headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    this.page = await this.context.newPage();
    logger.info('Browser launched (1280×800 viewport)');
    return true;
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
      logger.info('Browser closed');
    }
  }

  // ─── Navigation ─────────────────────────────────────────────────────────

  async goto(url) {
    await this.page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    logger.action(`Navigated to ${url}`);
    return `Navigated to ${url}`;
  }

  // ─── Screenshots ────────────────────────────────────────────────────────

  async takeScreenshot() {
    if (!fs.existsSync(SCREENSHOT_DIR)) {
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }
    const filename = `step_${Date.now()}.png`;
    const filePath = path.join(SCREENSHOT_DIR, filename);
    await this.page.screenshot({ path: filePath, fullPage: false });
    return filePath;
  }

  // ─── Interactions ───────────────────────────────────────────────────────

  async clickElement(elementId, elements) {
    const element = elements.find(e => e.id === elementId);
    if (!element) {
      return `Error: Element [${elementId}] not found`;
    }

    const viewportHeight = 800;
    const viewportWidth = 1280;

    // Auto-scroll if element is near the edge or outside viewport
    if (element.center.y > viewportHeight - 50 || element.center.y < 50) {
      const scrollAmount = element.center.y - (viewportHeight / 2);
      await this.page.mouse.wheel(0, scrollAmount);
      await this.page.waitForTimeout(400);
      logger.info(`Auto-scrolled ${scrollAmount}px to bring element [${elementId}] into view`);

      // Re-read the element's position after scrolling (it moved)
      // We can't re-extract all elements, so click by scrolling to center and using updated position
      // The element should now be near the center of viewport
      const newY = element.center.y - scrollAmount;
      await this.page.mouse.click(element.center.x, Math.max(50, Math.min(newY, viewportHeight - 50)));
    } else {
      // Element is comfortably in viewport — click directly
      if (element.frameIndex > 0) {
        const frames = this.page.frames();
        const frame = frames[element.frameIndex];
        if (!frame) return `Error: Frame ${element.frameIndex} not found`;
      }
      await this.page.mouse.click(element.center.x, element.center.y);
    }

    await this.page.waitForTimeout(500);
    const desc = element.label || element.placeholder || element.tag;
    logger.action(`Clicked element [${elementId}] "${desc}" at (${element.center.x}, ${element.center.y})`);
    return `Clicked element [${elementId}] "${desc}"`;
  }

  async typeText(text) {
    await this.page.keyboard.type(text, { delay: 60 });
    logger.action(`Typed: "${text}"`);
    return `Typed: "${text}"`;
  }

  async clearAndType(text) {
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await this.page.keyboard.press(`${modifier}+a`);
    await this.page.waitForTimeout(100);
    await this.page.keyboard.press('Backspace');
    await this.page.waitForTimeout(100);
    await this.page.keyboard.type(text, { delay: 60 });
    logger.action(`Cleared field and typed: "${text}"`);
    return `Cleared and typed: "${text}"`;
  }

  async scroll(direction = 'down', amount = 400) {
    const delta = direction === 'down' ? Number(amount) : -Number(amount);
    await this.page.mouse.wheel(0, delta);
    await this.page.waitForTimeout(400);
    logger.action(`Scrolled ${direction} by ${amount}px`);
    return `Scrolled ${direction} by ${amount}px`;
  }

  async pressKey(key) {
    await this.page.keyboard.press(key);
    await this.page.waitForTimeout(200);
    return `Pressed key: ${key}`;
  }

  async wait(ms = 1000) {
    await this.page.waitForTimeout(ms);
    return `Waited ${ms}ms`;
  }

  async selectOption(elementId, elements, value) {
    const element = elements.find(e => e.id === elementId);
    if (!element) {
      return `Error: Element [${elementId}] not found`;
    }

    try {
      // Click the select/dropdown to open it
      await this.page.mouse.click(element.center.x, element.center.y);
      await this.page.waitForTimeout(500);

      // Try native <select> option selection
      if (element.tag === 'select') {
        // Use Playwright's selectOption on the nearest select element
        const frame = element.frameIndex > 0 ? this.page.frames()[element.frameIndex] : this.page;
        await frame.selectOption(`select`, { label: value }).catch(() => {});
      }

      // Also try clicking the visible option text (for custom dropdowns)
      try {
        const option = await this.page.locator(`text="${value}"`).first();
        if (await option.isVisible()) {
          await option.click();
        }
      } catch (e) { /* ignore if not found */ }

      await this.page.waitForTimeout(300);
      logger.action(`Selected option "${value}" in element [${elementId}]`);
      return `Selected option "${value}"`;
    } catch (err) {
      return `Error selecting option: ${err.message}`;
    }
  }

  // ─── Element Extraction (with iframe support) ──────────────────────────

  async getInteractiveElements() {
    const allElements = [];
    let nextId = 1;

    // Script to extract interactive elements from a document
    const extractScript = () => {
      const SELECTORS = [
        'input:not([type="hidden"])',
        'textarea',
        'select',
        'button',
        'a[href]',
        '[role="button"]',
        '[role="link"]',
        '[role="textbox"]',
        '[contenteditable="true"]',
      ];

      const elements = [];
      const seen = new Set();

      for (const selector of SELECTORS) {
        for (const el of document.querySelectorAll(selector)) {
          if (seen.has(el)) continue;
          seen.add(el);

          const rect = el.getBoundingClientRect();

          // Skip invisible or zero-size elements
          if (rect.width === 0 || rect.height === 0) continue;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

          // Check if element is in viewport
          const inViewport =
            rect.top < window.innerHeight &&
            rect.bottom > 0 &&
            rect.left < window.innerWidth &&
            rect.right > 0;

          if (!inViewport) continue;

          // Get label text
          let label = '';
          if (el.id) {
            const labelEl = document.querySelector(`label[for="${el.id}"]`);
            if (labelEl) label = labelEl.textContent.trim();
          }
          if (!label) label = el.getAttribute('aria-label') || '';
          if (!label) label = el.getAttribute('title') || '';
          if (!label && (el.tagName === 'BUTTON' || el.tagName === 'A')) {
            label = el.textContent.trim().substring(0, 50);
          }

          elements.push({
            tag: el.tagName.toLowerCase(),
            type: el.type || '',
            role: el.getAttribute('role') || '',
            label,
            placeholder: el.placeholder || '',
            value: el.value || '',
            text: (el.tagName === 'BUTTON' || el.tagName === 'A')
              ? el.textContent.trim().substring(0, 50) : '',
            bbox: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
            center: {
              x: Math.round(rect.x + rect.width / 2),
              y: Math.round(rect.y + rect.height / 2),
            },
            href: el.href || '',
          });
        }
      }

      return elements;
    };

    // Extract from main frame
    try {
      const mainElements = await this.page.evaluate(extractScript);
      for (const el of mainElements) {
        allElements.push({ ...el, id: nextId++, frameIndex: 0 });
      }
    } catch (err) {
      logger.error(`Error extracting main frame elements: ${err.message}`);
    }

    // Extract from iframes
    const frames = this.page.frames();
    for (let i = 1; i < frames.length; i++) {
      try {
        const frame = frames[i];
        // Get iframe element's position on the page for offset calculation
        const frameElement = await frame.frameElement();
        if (!frameElement) continue;

        const frameRect = await frameElement.boundingBox();
        if (!frameRect) continue;

        // Check if iframe is visible in viewport
        if (frameRect.y + frameRect.height < 0 || frameRect.y > 800) continue;
        if (frameRect.x + frameRect.width < 0 || frameRect.x > 1280) continue;

        const frameElements = await frame.evaluate(extractScript);
        for (const el of frameElements) {
          // Adjust coordinates by iframe's position on the page
          allElements.push({
            ...el,
            id: nextId++,
            frameIndex: i,
            bbox: {
              x: Math.round(el.bbox.x + frameRect.x),
              y: Math.round(el.bbox.y + frameRect.y),
              width: el.bbox.width,
              height: el.bbox.height,
            },
            center: {
              x: Math.round(el.center.x + frameRect.x),
              y: Math.round(el.center.y + frameRect.y),
            },
          });
        }
      } catch (err) {
        // Iframe might be cross-origin or inaccessible — skip silently
      }
    }

    // Limit to 30 most relevant elements (prioritize inputs/textareas/buttons)
    if (allElements.length > 30) {
      const priority = { input: 1, textarea: 1, select: 2, button: 3, a: 4 };
      allElements.sort((a, b) => (priority[a.tag] || 5) - (priority[b.tag] || 5));
      allElements.length = 30;
      // Re-assign IDs after sorting
      allElements.forEach((el, idx) => { el.id = idx + 1; });
    }

    logger.info(`Found ${allElements.length} interactive elements (across ${frames.length} frame(s))`);
    return allElements;
  }

  // ─── Value reading (for verification) ──────────────────────────────────

  async getElementValue(elementId, elements) {
    const element = elements.find(e => e.id === elementId);
    if (!element) return '';

    try {
      const frame = element.frameIndex > 0
        ? this.page.frames()[element.frameIndex]
        : this.page;

      if (!frame) return '';

      // Re-read the element's current value by finding it near its known coordinates
      const value = await frame.evaluate(({ center }) => {
        const el = document.elementFromPoint(center.x, center.y);
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) {
          return el.value;
        }
        // Try to find the nearest input
        const parent = el?.closest('div, form, fieldset');
        if (parent) {
          const input = parent.querySelector('input, textarea');
          if (input) return input.value;
        }
        return '';
      }, { center: { x: element.center.x - (element.frameIndex > 0 ? 0 : 0), y: element.center.y } });

      return value;
    } catch (err) {
      return '';
    }
  }

  // ─── Page URL ──────────────────────────────────────────────────────────

  getUrl() {
    return this.page ? this.page.url() : '';
  }
}

module.exports = Browser;
