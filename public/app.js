// ═════════════════════════════════════════════════════════════════════════════
// AI Browser Agent — Dashboard Client
// Socket.IO-powered real-time UI for watching the agent work
// ═════════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ─── DOM Elements ────────────────────────────────────────────────────────
  const $taskInput     = document.getElementById('task-input');
  const $btnStart      = document.getElementById('btn-start');
  const $btnStop       = document.getElementById('btn-stop');
  const $btnClean      = document.getElementById('btn-clean');
  const $btnVision     = document.getElementById('btn-vision');
  const $btnClearLog   = document.getElementById('btn-clear-log');
  const $statusDot     = document.querySelector('.status-dot');
  const $statusText    = document.querySelector('.status-text');
  const $screenshotImg = document.getElementById('screenshot-img');
  const $screenshotBox = document.getElementById('screenshot-container');
  const $emptyState    = document.getElementById('empty-state');
  const $logContainer  = document.getElementById('log-container');
  const $stepText      = document.getElementById('step-text');
  const $toastBox      = document.getElementById('toast-container');

  // ─── State ───────────────────────────────────────────────────────────────
  let currentView = 'clean';       // 'clean' or 'vision'
  let cleanScreenshot = null;      // base64 of clean screenshot
  let visionScreenshot = null;     // base64 of annotated screenshot
  let isRunning = false;

  // ─── Socket.IO Connection ────────────────────────────────────────────────
  const socket = io();

  socket.on('connect', () => {
    console.log('Connected to server');
  });

  socket.on('disconnect', () => {
    console.log('Disconnected from server');
    showToast('Disconnected from server', 'error');
  });

  // ─── Event Handlers ─────────────────────────────────────────────────────

  // Screenshot (clean)
  socket.on('screenshot', (data) => {
    cleanScreenshot = data.base64;
    if (currentView === 'clean') {
      showScreenshot(cleanScreenshot);
    }
  });

  // Annotated screenshot (AI vision)
  socket.on('annotated_screenshot', (data) => {
    visionScreenshot = data.base64;
    if (currentView === 'vision') {
      showScreenshot(visionScreenshot);
    }
  });

  // Action event
  socket.on('action', (data) => {
    addLogEntry(data);
    if (data.step && data.maxSteps) {
      $stepText.textContent = `Step ${data.step} / ${data.maxSteps}`;
    }
  });

  // Log event
  socket.on('log', (data) => {
    // Only show important logs (skip INFO noise)
    if (['ACTION', 'ERROR', 'SUCCESS', 'AI'].includes(data.level)) {
      addSimpleLogEntry(data);
    }
  });

  // Status event
  socket.on('status', (data) => {
    setStatus(data.state);
  });

  // Error event
  socket.on('error', (data) => {
    showToast(data.message, 'error');
  });

  // Task complete
  socket.on('task_complete', (data) => {
    showToast(`Task completed in ${data.steps} steps!`, 'success');
    $stepText.textContent = `Done in ${data.steps} steps`;
  });

  // Pause for user (file upload, captcha, etc.)
  socket.on('pause_for_user', (data) => {
    showPauseBanner(data.message);
    addLogEntry({
      action: 'pause_for_user',
      elementId: null,
      params: { message: data.message },
      reasoning: data.reasoning,
      step: data.step,
      timestamp: data.timestamp,
    });
  });

  // ─── UI Actions ──────────────────────────────────────────────────────────

  // Start task
  $btnStart.addEventListener('click', startTask);

  // Stop task
  $btnStop.addEventListener('click', () => {
    socket.emit('stop_task');
  });

  // View toggles
  $btnClean.addEventListener('click', () => switchView('clean'));
  $btnVision.addEventListener('click', () => switchView('vision'));

  // Clear log
  $btnClearLog.addEventListener('click', () => {
    $logContainer.innerHTML = '<div class="log-empty"><p>Actions will appear here as the agent works...</p></div>';
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !isRunning && document.activeElement === $taskInput) {
      e.preventDefault();
      startTask();
    }
    if (e.key === 'Escape' && isRunning) {
      socket.emit('stop_task');
    }
  });

  // ─── Helper Functions ────────────────────────────────────────────────────

  function startTask() {
    const task = $taskInput.value.trim();
    if (!task) {
      showToast('Please enter a task first', 'error');
      return;
    }
    // Clear previous state
    cleanScreenshot = null;
    visionScreenshot = null;
    $logContainer.innerHTML = '';
    $stepText.textContent = 'Starting...';
    socket.emit('start_task', { task });
  }

  function setStatus(state) {
    isRunning = state === 'running' || state === 'paused';

    // Update dot
    $statusDot.className = 'status-dot ' + state;

    // Update text
    const labels = { idle: 'Idle', running: 'Running', paused: 'Waiting for you', error: 'Error', complete: 'Complete' };
    $statusText.textContent = labels[state] || state;

    // Update buttons
    $btnStart.disabled = isRunning;
    $btnStop.disabled = !isRunning;
    $taskInput.disabled = isRunning;

    // Screenshot glow
    if (state === 'running') {
      $screenshotBox.classList.add('active');
    } else {
      $screenshotBox.classList.remove('active');
    }

    // Remove pause banner if we're running again
    if (state === 'running') {
      removePauseBanner();
    }

    // Update step text
    if (state === 'idle') {
      $stepText.textContent = 'Ready';
    } else if (state === 'error') {
      $stepText.textContent = 'Error';
    } else if (state === 'paused') {
      $stepText.textContent = 'Paused — waiting for you';
    }
  }

  function showScreenshot(base64) {
    if (!base64) return;
    $emptyState.style.display = 'none';
    $screenshotImg.style.display = 'block';
    $screenshotImg.src = 'data:image/png;base64,' + base64;
  }

  function switchView(view) {
    currentView = view;
    $btnClean.classList.toggle('active', view === 'clean');
    $btnVision.classList.toggle('active', view === 'vision');

    if (view === 'clean' && cleanScreenshot) {
      showScreenshot(cleanScreenshot);
    } else if (view === 'vision' && visionScreenshot) {
      showScreenshot(visionScreenshot);
    }
  }

  // Action type → icon + CSS class
  const ACTION_META = {
    navigate:       { icon: '🧭', cls: 'navigate', label: 'Navigate' },
    click:          { icon: '👆', cls: 'click',    label: 'Click' },
    type:           { icon: '⌨️', cls: 'type',     label: 'Type' },
    scroll:         { icon: '📜', cls: 'scroll',   label: 'Scroll' },
    wait:           { icon: '⏳', cls: 'wait',     label: 'Wait' },
    TASK_COMPLETE:  { icon: '✅', cls: 'success',  label: 'Complete' },
    verify_success: { icon: '✓',  cls: 'verify',   label: 'Verified' },
    verify_failed:  { icon: '✗',  cls: 'error',    label: 'Verify Failed' },
    loop_detected:  { icon: '🔄', cls: 'error',    label: 'Loop Detected' },
    pause_for_user: { icon: '⏸',  cls: 'scroll',   label: 'Paused' },
    select_option:  { icon: '📋', cls: 'click',    label: 'Select' },
  };

  function addLogEntry(data) {
    // Remove empty state
    const empty = $logContainer.querySelector('.log-empty');
    if (empty) empty.remove();

    const meta = ACTION_META[data.action] || { icon: '❓', cls: 'wait', label: data.action };
    const time = data.timestamp ? new Date(data.timestamp).toLocaleTimeString() : '';

    // Build description
    let desc = meta.label;
    if (data.action === 'click' && data.elementId) {
      desc = `Click element [${data.elementId}]`;
    } else if (data.action === 'type' && data.params?.text) {
      desc = `Type: "${data.params.text.substring(0, 60)}${data.params.text.length > 60 ? '...' : ''}"`;
    } else if (data.action === 'navigate' && data.params?.url) {
      desc = `Navigate to ${data.params.url.substring(0, 50)}...`;
    } else if (data.action === 'scroll') {
      desc = `Scroll ${data.params?.direction || 'down'} ${data.params?.amount || 400}px`;
    } else if (data.action === 'verify_success') {
      desc = `✓ Verified text entered correctly`;
    } else if (data.action === 'verify_failed') {
      desc = `✗ Text verification failed — retrying`;
    } else if (data.action === 'pause_for_user') {
      desc = `⏸ ${data.params?.message || 'Waiting for user action'}`;
    } else if (data.action === 'select_option') {
      desc = `Select "${data.params?.value || ''}" in element [${data.elementId}]`;
    }

    const entry = document.createElement('div');
    entry.className = `log-entry ${meta.cls}`;
    entry.innerHTML = `
      <span class="log-icon">${meta.icon}</span>
      <div class="log-body">
        <div class="log-action">${desc}</div>
        ${data.reasoning ? `<div class="log-reasoning">${data.reasoning}</div>` : ''}
      </div>
      <span class="log-time">${time}</span>
    `;

    $logContainer.appendChild(entry);
    $logContainer.scrollTop = $logContainer.scrollHeight;
  }

  function addSimpleLogEntry(data) {
    const empty = $logContainer.querySelector('.log-empty');
    if (empty) empty.remove();

    const levelMeta = {
      ACTION:  { icon: '⚡', cls: 'click' },
      ERROR:   { icon: '❌', cls: 'error' },
      SUCCESS: { icon: '✅', cls: 'success' },
      AI:      { icon: '🧠', cls: 'ai' },
    };

    const meta = levelMeta[data.level] || { icon: 'ℹ️', cls: 'wait' };
    const time = data.timestamp ? new Date(data.timestamp).toLocaleTimeString() : '';

    const entry = document.createElement('div');
    entry.className = `log-entry ${meta.cls}`;
    entry.innerHTML = `
      <span class="log-icon">${meta.icon}</span>
      <div class="log-body">
        <div class="log-action">${data.message.substring(0, 120)}</div>
      </div>
      <span class="log-time">${time}</span>
    `;

    $logContainer.appendChild(entry);
    $logContainer.scrollTop = $logContainer.scrollHeight;
  }

  function showToast(message, type = 'error') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    $toastBox.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = 'toastOut 0.3s ease-in forwards';
      setTimeout(() => toast.remove(), 300);
    }, 5000);
  }

  // ─── Pause Banner ──────────────────────────────────────────────────────

  function showPauseBanner(message) {
    removePauseBanner();
    const banner = document.createElement('div');
    banner.id = 'pause-banner';
    banner.className = 'pause-banner';
    banner.innerHTML = `
      <div class="pause-content">
        <span class="pause-icon">⏸</span>
        <div class="pause-text">
          <strong>Agent paused — needs your help</strong>
          <p>${message}</p>
        </div>
        <button id="btn-resume" class="btn btn-start" onclick="document.getElementById('pause-banner').remove()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Resume
        </button>
      </div>
    `;
    $screenshotBox.prepend(banner);

    // Wire up the resume button
    banner.querySelector('#btn-resume').addEventListener('click', () => {
      socket.emit('resume_task');
      removePauseBanner();
    });
  }

  function removePauseBanner() {
    const existing = document.getElementById('pause-banner');
    if (existing) existing.remove();
  }

})();
