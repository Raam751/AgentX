const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || './screenshots';

// ═════════════════════════════════════════════════════════════════════════════
// Annotator — Injects visual overlays onto the page, takes a screenshot,
//             then removes the overlays. Matches browser-use.com's approach.
// ═════════════════════════════════════════════════════════════════════════════

// Color scheme by element type
const COLORS = {
  input:    { border: '#3b82f6', bg: 'rgba(59,130,246,0.06)', pill: '#3b82f6' },
  textarea: { border: '#3b82f6', bg: 'rgba(59,130,246,0.06)', pill: '#3b82f6' },
  select:   { border: '#f59e0b', bg: 'rgba(245,158,11,0.06)', pill: '#f59e0b' },
  button:   { border: '#22c55e', bg: 'rgba(34,197,94,0.06)',  pill: '#22c55e' },
  a:        { border: '#a855f7', bg: 'rgba(168,85,247,0.06)', pill: '#a855f7' },
  default:  { border: '#f59e0b', bg: 'rgba(245,158,11,0.06)', pill: '#f59e0b' },
};

function getColor(tag) {
  return COLORS[tag] || COLORS.default;
}

/**
 * Inject annotation overlays onto the page, take a screenshot, then clean up.
 *
 * @param {import('playwright').Page} page - The Playwright page
 * @param {Array} elements - Elements from browser.getInteractiveElements()
 * @returns {{ annotatedImagePath: string, annotatedImageBase64: string }}
 */
async function annotate(page, elements) {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }

  // Build overlay HTML for all elements
  const overlayId = '__ai_agent_overlay__';
  const overlayDivs = elements.map(el => {
    const color = getColor(el.tag);
    const { x, y, width, height } = el.bbox;

    // Bounding box rectangle
    const box = `
      <div style="
        position: fixed;
        left: ${x}px;
        top: ${y}px;
        width: ${width}px;
        height: ${height}px;
        border: 2px solid ${color.border};
        background: ${color.bg};
        pointer-events: none;
        z-index: 2147483646;
        box-sizing: border-box;
      "></div>
    `;

    // Number label pill
    const pill = `
      <div style="
        position: fixed;
        left: ${x - 1}px;
        top: ${Math.max(y - 18, 0)}px;
        background: ${color.pill};
        color: white;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 11px;
        font-weight: 700;
        padding: 1px 5px;
        border-radius: 4px;
        pointer-events: none;
        z-index: 2147483647;
        line-height: 16px;
        white-space: nowrap;
      ">${el.id}</div>
    `;

    return box + pill;
  }).join('');

  // Inject overlay container (Trusted Types-safe for sites like YouTube)
  await page.evaluate(({ id, html }) => {
    // Remove existing overlay if any
    const existing = document.getElementById(id);
    if (existing) existing.remove();

    const container = document.createElement('div');
    container.id = id;
    container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483645;';

    // YouTube/Google enforce Trusted Types — create a policy to allow innerHTML
    try {
      if (window.trustedTypes && window.trustedTypes.createPolicy) {
        const policy = window.trustedTypes.createPolicy('aiAgentOverlay', {
          createHTML: (input) => input,
        });
        container.innerHTML = policy.createHTML(html);
      } else {
        container.innerHTML = html;
      }
    } catch (e) {
      // Policy name might already exist, fall back to DOM parsing
      const tmp = document.createElement('template');
      tmp.innerHTML = html;
      container.appendChild(tmp.content);
    }

    document.body.appendChild(container);
  }, { id: overlayId, html: overlayDivs });

  // Wait a brief moment for rendering
  await page.waitForTimeout(100);

  // Take screenshot with overlays visible
  const filename = `annotated_${Date.now()}.png`;
  const filePath = path.join(SCREENSHOT_DIR, filename);
  await page.screenshot({ path: filePath, fullPage: false });

  // Remove overlay
  await page.evaluate((id) => {
    const el = document.getElementById(id);
    if (el) el.remove();
  }, overlayId);

  // Read as base64
  const imageBuffer = fs.readFileSync(filePath);
  const base64 = imageBuffer.toString('base64');

  logger.info(`Annotated screenshot saved (${elements.length} elements labeled)`);

  return {
    annotatedImagePath: filePath,
    annotatedImageBase64: base64,
  };
}

/**
 * Build a text description of elements for the LLM prompt.
 * e.g., "[1] input 'Bug Title' (placeholder: 'Login button...') [value: '']"
 */
function buildElementListText(elements) {
  return elements.map(el => {
    const parts = [`[${el.id}]`, el.tag];
    if (el.type) parts.push(`type="${el.type}"`);
    if (el.label) parts.push(`"${el.label}"`);
    if (el.placeholder) parts.push(`(placeholder: "${el.placeholder}")`);
    if (el.text) parts.push(`text: "${el.text}"`);
    if (el.value) parts.push(`[value: "${el.value}"]`);
    if (el.href) parts.push(`→ ${el.href.substring(0, 60)}`);
    return parts.join(' ');
  }).join('\n');
}

module.exports = { annotate, buildElementListText };
