# 🤖 AI Browser Automation Agent

An AI-powered browser automation agent that **genuinely sees** web pages through annotated screenshots, makes autonomous decisions, and self-corrects when things go wrong. Watch it work in real-time through a sleek web dashboard.

> **Inspired by [browser-use.com](https://browser-use.com/)** — built from scratch as a learning project.

## ✨ Key Features

| Feature | Description |
|---------|-------------|
| **Vision-Based** | Agent sees numbered bounding boxes on screenshots — decisions are based on visual understanding, not DOM selectors |
| **Self-Correcting** | After each action, verifies it worked. If not, retries with contextual feedback |
| **Real-Time Dashboard** | Watch the agent work live — screenshots, action log, AI reasoning, all streamed via WebSocket |
| **Any Task** | Type any natural language task — "go to X and do Y" — the AI figures out how |
| **Multi-Provider** | Supports Groq (free) and OpenAI out of the box |

## 🚀 Quick Start

```bash
# 1. Clone and install
git clone <repo-url>
cd ai-browser-agent
npm install

# 2. Configure
cp .env.example .env
# Edit .env and add your Groq API key (free at https://console.groq.com/)

# 3. Run
npm start

# 4. Open dashboard
# → http://localhost:3000
```

## 🖥️ How It Works

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐     ┌──────────────┐
│  Screenshot  │────▶│   Annotate   │────▶│  LLM Vision │────▶│   Execute    │
│  (Playwright)│     │  (bounding   │     │  (Groq/GPT) │     │  (click/type)│
│              │     │   boxes)     │     │             │     │              │
└─────────────┘     └──────────────┘     └─────────────┘     └──────┬───────┘
       ▲                                                            │
       │                    ┌──────────────┐                        │
       └────────────────────│   Verify &   │◀───────────────────────┘
                            │ Self-Correct │
                            └──────────────┘
```

1. **Screenshot** — Captures the current browser viewport
2. **Annotate** — Extracts interactive elements, draws numbered bounding boxes on the screenshot
3. **LLM Vision** — Sends annotated screenshot to AI, which picks an element by number
4. **Execute** — Clicks/types/scrolls based on the AI's decision
5. **Verify** — Checks if the action worked (e.g., did the text actually appear in the field?)
6. **Self-Correct** — If verification fails, retries with feedback: "Element [3] is still empty, try again"

## 🏗️ Architecture

```
ai-browser-agent/
├── server.js              ← Express + Socket.IO entry point
├── src/
│   ├── agent.js           ← Agent loop with self-correction
│   ├── browser.js         ← Playwright wrapper (iframe-aware)
│   ├── annotator.js       ← Bounding box annotation via JS injection
│   ├── llm.js             ← Provider-agnostic LLM client
│   └── logger.js          ← Logging with real-time Socket.IO emission
├── public/
│   ├── index.html         ← Dashboard HTML
│   ├── styles.css         ← Dark glassmorphism theme
│   └── app.js             ← Socket.IO client + UI logic
└── screenshots/           ← Auto-saved screenshots
```

## ⚙️ Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_PROVIDER` | `groq` | LLM provider: `groq` or `openai` |
| `GROQ_API_KEY` | — | Groq API key (free at console.groq.com) |
| `OPENAI_API_KEY` | — | OpenAI API key (optional) |
| `LLM_MODEL` | auto | Model name (auto-selected if empty) |
| `HEADLESS` | `false` | Run browser in headless mode |
| `MAX_STEPS` | `20` | Maximum agent steps per task |
| `PORT` | `3000` | Dashboard server port |

## 🧠 Why This Can't Be Replaced by Playwright Selectors

The AI agent makes **genuinely visual decisions**:
- It sees the page as a human would — through annotated screenshots
- It interprets layout, context, and visual cues to decide what to click
- It handles unexpected page states, popups, and layout variations
- It self-corrects when actions don't produce the expected result

A Playwright script would need explicit selectors for every element. This agent adapts to **any page** it's never seen before.

## 📝 License

MIT
