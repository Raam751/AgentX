# Architecture — AI Browser Automation Agent v2

## Overview

This is a vision-first browser automation agent. Unlike traditional web scrapers that rely on CSS selectors or XPath, this agent **sees the page as a human would** — through annotated screenshots — and makes decisions based on visual understanding.

## Core Architecture

```
                    ┌──────────────────────────────────────────┐
                    │              Dashboard (Browser)          │
                    │  ┌──────────────┐  ┌──────────────────┐  │
                    │  │ Live Browser │  │    Action Log     │  │
                    │  │   Screenshot │  │  (color-coded)    │  │
                    │  │   (clean /   │  │                   │  │
                    │  │   AI vision) │  │  Navigate 🧭      │  │
                    │  └──────────────┘  │  Click [3]  👆     │  │
                    │                    │  Type "..."  ⌨️    │  │
                    │  Task: [________]  │  ✓ Verified  ✅    │  │
                    │         [Start]    └──────────────────┘  │
                    └──────────────┬───────────────────────────┘
                                  │ Socket.IO (WebSocket)
                    ┌─────────────▼───────────────────────────┐
                    │           server.js (Express)             │
                    │  - Serves dashboard static files          │
                    │  - Manages agent lifecycle                │
                    │  - Pipes events between agent & dashboard │
                    └─────────────┬───────────────────────────┘
                                  │
              ┌───────────────────▼───────────────────────────┐
              │                agent.js (Agent Loop)            │
              │                                                │
              │  for each step:                                │
              │    1. browser.takeScreenshot()                  │
              │    2. browser.getInteractiveElements()          │
              │    3. annotator.annotate(page, elements)        │
              │    4. llm.decide(annotatedImage, task, ...)     │
              │    5. Execute action (click/type/scroll/...)    │
              │    6. Verify & self-correct if needed           │
              │    7. Emit events to dashboard                  │
              └───────┬────────┬──────────┬──────────────────┘
                      │        │          │
        ┌─────────────▼─┐ ┌───▼──────┐ ┌─▼──────────┐
        │  browser.js    │ │annotator │ │  llm.js    │
        │  (Playwright)  │ │  .js     │ │  (Groq /   │
        │                │ │          │ │   OpenAI)  │
        │  - Launch      │ │ Inject   │ │            │
        │  - Navigate    │ │ CSS/JS   │ │ - System   │
        │  - Click       │ │ overlays │ │   prompt   │
        │  - Type        │ │ on page  │ │ - Parse    │
        │  - Extract     │ │ → take   │ │   JSON     │
        │    elements    │ │ screenshot│ │ - Retry    │
        │  - Read values │ │ → remove │ │   with     │
        │  - iframes     │ │ overlays │ │   feedback │
        └────────────────┘ └──────────┘ └────────────┘
```

## Vision-Based Approach (Set-of-Marks)

### Why Vision?

Traditional automation uses CSS selectors: `document.querySelector('#email-input')`. This:
- Requires knowing the exact selector ahead of time
- Breaks when the page structure changes
- Can't handle unknown pages
- Makes the AI component unnecessary (a simple script would do)

Our approach uses **Set-of-Marks (SoM)** — the same technique used by browser-use.com:
1. Extract all interactive elements and their bounding boxes from the DOM
2. Draw numbered labels on the screenshot at each element's position
3. Send the annotated screenshot + element list to the LLM
4. The LLM picks an element by number based on what it **sees**
5. We map the number back to DOM coordinates for precise clicking

The AI is genuinely irreplaceable here — it's making visual decisions a script can't.

### Annotation Pipeline

```
Page DOM ──► getInteractiveElements() ──► Element Array
                                              │
                                              ▼
                                    annotate(page, elements)
                                              │
                                    1. Inject overlay <div>
                                    2. Draw colored borders
                                    3. Add numbered pills
                                    4. Take screenshot
                                    5. Remove overlay
                                              │
                                              ▼
                                    Annotated Screenshot (PNG)
```

### Color Coding
| Element Type | Color | Hex |
|-------------|-------|-----|
| Input / Textarea | Blue | `#3b82f6` |
| Button | Green | `#22c55e` |
| Link | Purple | `#a855f7` |
| Select / Other | Amber | `#f59e0b` |

## Self-Correction Loop

The agent doesn't blindly trust that its actions worked. After critical actions (click, type), it:

```
Action executed
     │
     ▼
Take new screenshot
     │
     ▼
Was this a "type" action? ──► Read element value
     │                              │
     │                    Value matches? ──► ✅ Continue
     │                              │
     │                         No ──► Send failure context to LLM
     │                              │         "Element [3] still empty,
     │                              │          try clicking it first"
     │                              │
     │                              ▼
     │                        Retry (max 2x)
     │
     ▼
Continue to next step
```

## Iframe Support

The shadcn/ui docs page (our primary test target) renders form demos inside iframes for CSS isolation. The browser module handles this:

1. `page.frames()` — get all frames (main + iframes)
2. For each frame, run element extraction via `frame.evaluate()`
3. Compute absolute coordinates: element position + iframe offset on page
4. Store `frameIndex` on each element so clicks target the correct frame

## Real-Time Event Pipeline

```
Agent                    Server                  Dashboard
  │                        │                        │
  │── screenshot ─────────►│── screenshot ─────────►│ (update image)
  │── annotated_ss ───────►│── annotated_ss ───────►│ (AI vision)
  │── action ─────────────►│── action ─────────────►│ (add log entry)
  │── log ────────────────►│── log ────────────────►│ (add log entry)
  │── status ─────────────►│── status ─────────────►│ (update indicator)
  │── error ──────────────►│── error ──────────────►│ (show toast)
  │── task_complete ──────►│── task_complete ──────►│ (show success)
  │                        │                        │
  │                        │◄── start_task ─────────│ (user clicks Start)
  │                        │◄── stop_task ──────────│ (user clicks Stop)
```

## Provider Abstraction

`llm.js` abstracts away the provider differences:

```javascript
// Same interface regardless of provider
const llm = new LLMClient();     // reads LLM_PROVIDER from .env
const result = await llm.decide(image, task, history, elements);
// result = { action: 'click', elementId: 3, reasoning: '...' }
```

Supported: `groq` (free, LLaMA 4 Scout), `openai` (GPT-4o)

## Conversation History Management

To stay within token limits (especially with base64 screenshots):
- Keep only the last 3 exchanges (6 messages)
- Every message includes the full task as a reminder
- Screenshots are sent as base64 in the `image_url` content type
- The annotated screenshot (~10K tokens) is the dominant cost per step
