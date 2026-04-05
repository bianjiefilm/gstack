/**
 * gstack browse server — persistent Chromium daemon
 *
 * Architecture:
 *   Bun.serve HTTP on localhost → routes commands to Playwright
 *   Console/network/dialog buffers: CircularBuffer in-memory + async disk flush
 *   Chromium crash → server EXITS with clear error (CLI auto-restarts)
 *   Auto-shutdown after BROWSE_IDLE_TIMEOUT (default 30 min)
 *
 * State:
 *   State file: <project-root>/.gstack/browse.json (set via BROWSE_STATE_FILE env)
 *   Log files:  <project-root>/.gstack/browse-{console,network,dialog}.log
 *   Port:       random 10000-60000 (or BROWSE_PORT env for debug override)
 */

import { BrowserManager } from './browser-manager';
import { handleReadCommand } from './read-commands';
import { handleWriteCommand } from './write-commands';
import { handleMetaCommand } from './meta-commands';
import { handleCookiePickerRoute } from './cookie-picker-routes';
import { COMMAND_DESCRIPTIONS, PAGE_CONTENT_COMMANDS, wrapUntrustedContent } from './commands';
import { handleSnapshot, SNAPSHOT_FLAGS } from './snapshot';
import { resolveConfig, ensureStateDir, readVersionHash } from './config';
import { emitActivity, subscribe, getActivityAfter, getActivityHistory, getSubscriberCount } from './activity';
import { inspectElement, modifyStyle, resetModifications, getModificationHistory, detachSession, type InspectorResult } from './cdp-inspector';
import { SessionStore, createWorktree, removeWorktree } from './session-store';
import { AgentManager, findBrowseBin } from './agent-manager';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as crypto from 'crypto';

// ─── Config ─────────────────────────────────────────────────────
const config = resolveConfig();
ensureStateDir(config);

// ─── Auth ───────────────────────────────────────────────────────
const AUTH_TOKEN = crypto.randomUUID();
const BROWSE_PORT = parseInt(process.env.BROWSE_PORT || '0', 10);
const IDLE_TIMEOUT_MS = parseInt(process.env.BROWSE_IDLE_TIMEOUT || '1800000', 10); // 30 min

function validateAuth(req: Request): boolean {
  const header = req.headers.get('authorization');
  return header === `Bearer ${AUTH_TOKEN}`;
}

// ─── Session Store + Agent Manager ──────────────────────────────
const SESSIONS_DIR = path.join(process.env.HOME || '/tmp', '.gstack', 'sidebar-sessions');
const BROWSE_BIN = findBrowseBin();
const sessionStore = new SessionStore({ sessionsDir: SESSIONS_DIR });

// ─── Help text (auto-generated from COMMAND_DESCRIPTIONS) ────────
function generateHelpText(): string {
  // Group commands by category
  const groups = new Map<string, string[]>();
  for (const [cmd, meta] of Object.entries(COMMAND_DESCRIPTIONS)) {
    const display = meta.usage || cmd;
    const list = groups.get(meta.category) || [];
    list.push(display);
    groups.set(meta.category, list);
  }

  const categoryOrder = [
    'Navigation', 'Reading', 'Interaction', 'Inspection',
    'Visual', 'Snapshot', 'Meta', 'Tabs', 'Server',
  ];

  const lines = ['gstack browse — headless browser for AI agents', '', 'Commands:'];
  for (const cat of categoryOrder) {
    const cmds = groups.get(cat);
    if (!cmds) continue;
    lines.push(`  ${(cat + ':').padEnd(15)}${cmds.join(', ')}`);
  }

  // Snapshot flags from source of truth
  lines.push('');
  lines.push('Snapshot flags:');
  const flagPairs: string[] = [];
  for (const flag of SNAPSHOT_FLAGS) {
    const label = flag.valueHint ? `${flag.short} ${flag.valueHint}` : flag.short;
    flagPairs.push(`${label}  ${flag.long}`);
  }
  // Print two flags per line for compact display
  for (let i = 0; i < flagPairs.length; i += 2) {
    const left = flagPairs[i].padEnd(28);
    const right = flagPairs[i + 1] || '';
    lines.push(`  ${left}${right}`);
  }

  return lines.join('\n');
}

// ─── Buffer (from buffers.ts) ────────────────────────────────────
import { consoleBuffer, networkBuffer, dialogBuffer, addConsoleEntry, addNetworkEntry, addDialogEntry, type LogEntry, type NetworkEntry, type DialogEntry } from './buffers';
export { consoleBuffer, networkBuffer, dialogBuffer, addConsoleEntry, addNetworkEntry, addDialogEntry, type LogEntry, type NetworkEntry, type DialogEntry };

const CONSOLE_LOG_PATH = config.consoleLog;
const NETWORK_LOG_PATH = config.networkLog;
const DIALOG_LOG_PATH = config.dialogLog;

// (Session, chat, agent, worktree logic moved to session-store.ts and agent-manager.ts)
let lastConsoleFlushed = 0;
let lastNetworkFlushed = 0;
let lastDialogFlushed = 0;
let flushInProgress = false;

async function flushBuffers() {
  if (flushInProgress) return; // Guard against concurrent flush
  flushInProgress = true;

  try {
    // Console buffer
    const newConsoleCount = consoleBuffer.totalAdded - lastConsoleFlushed;
    if (newConsoleCount > 0) {
      const entries = consoleBuffer.last(Math.min(newConsoleCount, consoleBuffer.length));
      const lines = entries.map(e =>
        `[${new Date(e.timestamp).toISOString()}] [${e.level}] ${e.text}`
      ).join('\n') + '\n';
      fs.appendFileSync(CONSOLE_LOG_PATH, lines);
      lastConsoleFlushed = consoleBuffer.totalAdded;
    }

    // Network buffer
    const newNetworkCount = networkBuffer.totalAdded - lastNetworkFlushed;
    if (newNetworkCount > 0) {
      const entries = networkBuffer.last(Math.min(newNetworkCount, networkBuffer.length));
      const lines = entries.map(e =>
        `[${new Date(e.timestamp).toISOString()}] ${e.method} ${e.url} → ${e.status || 'pending'} (${e.duration || '?'}ms, ${e.size || '?'}B)`
      ).join('\n') + '\n';
      fs.appendFileSync(NETWORK_LOG_PATH, lines);
      lastNetworkFlushed = networkBuffer.totalAdded;
    }

    // Dialog buffer
    const newDialogCount = dialogBuffer.totalAdded - lastDialogFlushed;
    if (newDialogCount > 0) {
      const entries = dialogBuffer.last(Math.min(newDialogCount, dialogBuffer.length));
      const lines = entries.map(e =>
        `[${new Date(e.timestamp).toISOString()}] [${e.type}] "${e.message}" → ${e.action}${e.response ? ` "${e.response}"` : ''}`
      ).join('\n') + '\n';
      fs.appendFileSync(DIALOG_LOG_PATH, lines);
      lastDialogFlushed = dialogBuffer.totalAdded;
    }
  } catch {
    // Flush failures are non-fatal — buffers are in memory
  } finally {
    flushInProgress = false;
  }
}

// Flush every 1 second
const flushInterval = setInterval(flushBuffers, 1000);

// ─── Idle Timer ────────────────────────────────────────────────
let lastActivity = Date.now();

function resetIdleTimer() {
  lastActivity = Date.now();
}

const idleCheckInterval = setInterval(() => {
  if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
    console.log(`[browse] Idle for ${IDLE_TIMEOUT_MS / 1000}s, shutting down`);
    shutdown();
  }
}, 60_000);

// ─── Command Sets (from commands.ts — single source of truth) ───
import { READ_COMMANDS, WRITE_COMMANDS, META_COMMANDS } from './commands';
export { READ_COMMANDS, WRITE_COMMANDS, META_COMMANDS };

// ─── Inspector State (in-memory) ──────────────────────────────
let inspectorData: InspectorResult | null = null;
let inspectorTimestamp: number = 0;

// Inspector SSE subscribers
type InspectorSubscriber = (event: any) => void;
const inspectorSubscribers = new Set<InspectorSubscriber>();

function emitInspectorEvent(event: any): void {
  for (const notify of inspectorSubscribers) {
    queueMicrotask(() => {
      try { notify(event); } catch {}
    });
  }
}

// ─── Server ────────────────────────────────────────────────────
const browserManager = new BrowserManager();
const agentManager = new AgentManager({
  sessionStore,
  getBrowseBin: () => BROWSE_BIN,
  getActiveTabId: () => browserManager?.getActiveTabId?.() ?? 0,
  getCurrentUrl: () => browserManager.getCurrentUrl() || '',
  getStateFile: () => config.stateFile,
});
let isShuttingDown = false;

// Test if a port is available by binding and immediately releasing.
// Uses net.createServer instead of Bun.serve to avoid a race condition
// in the Node.js polyfill where listen/close are async but the caller
// expects synchronous bind semantics. See: #486
function isPortAvailable(port: number, hostname: string = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, hostname, () => {
      srv.close(() => resolve(true));
    });
  });
}

// Find port: explicit BROWSE_PORT, or random in 10000-60000
async function findPort(): Promise<number> {
  // Explicit port override (for debugging)
  if (BROWSE_PORT) {
    if (await isPortAvailable(BROWSE_PORT)) {
      return BROWSE_PORT;
    }
    throw new Error(`[browse] Port ${BROWSE_PORT} (from BROWSE_PORT env) is in use`);
  }

  // Random port with retry
  const MIN_PORT = 10000;
  const MAX_PORT = 60000;
  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const port = MIN_PORT + Math.floor(Math.random() * (MAX_PORT - MIN_PORT));
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`[browse] No available port after ${MAX_RETRIES} attempts in range ${MIN_PORT}-${MAX_PORT}`);
}

/**
 * Translate Playwright errors into actionable messages for AI agents.
 */
function wrapError(err: any): string {
  const msg = err.message || String(err);
  // Timeout errors
  if (err.name === 'TimeoutError' || msg.includes('Timeout') || msg.includes('timeout')) {
    if (msg.includes('locator.click') || msg.includes('locator.fill') || msg.includes('locator.hover')) {
      return `Element not found or not interactable within timeout. Check your selector or run 'snapshot' for fresh refs.`;
    }
    if (msg.includes('page.goto') || msg.includes('Navigation')) {
      return `Page navigation timed out. The URL may be unreachable or the page may be loading slowly.`;
    }
    return `Operation timed out: ${msg.split('\n')[0]}`;
  }
  // Multiple elements matched
  if (msg.includes('resolved to') && msg.includes('elements')) {
    return `Selector matched multiple elements. Be more specific or use @refs from 'snapshot'.`;
  }
  // Pass through other errors
  return msg;
}

async function handleCommand(body: any): Promise<Response> {
  const { command, args = [], tabId } = body;

  if (!command) {
    return new Response(JSON.stringify({ error: 'Missing "command" field' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Pin to a specific tab if requested (set by BROWSE_TAB env var in sidebar agents).
  // This prevents parallel agents from interfering with each other's tab context.
  // Safe because Bun's event loop is single-threaded — no concurrent handleCommand.
  let savedTabId: number | null = null;
  if (tabId !== undefined && tabId !== null) {
    savedTabId = browserManager.getActiveTabId();
    // bringToFront: false — internal tab pinning must NOT steal window focus
    try { browserManager.switchTab(tabId, { bringToFront: false }); } catch {}
  }

  // Block mutation commands while watching (read-only observation mode)
  if (browserManager.isWatching() && WRITE_COMMANDS.has(command)) {
    return new Response(JSON.stringify({
      error: 'Cannot run mutation commands while watching. Run `$B watch stop` first.',
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Activity: emit command_start
  const startTime = Date.now();
  emitActivity({
    type: 'command_start',
    command,
    args,
    url: browserManager.getCurrentUrl(),
    tabs: browserManager.getTabCount(),
    mode: browserManager.getConnectionMode(),
  });

  try {
    let result: string;

    if (READ_COMMANDS.has(command)) {
      result = await handleReadCommand(command, args, browserManager);
      if (PAGE_CONTENT_COMMANDS.has(command)) {
        result = wrapUntrustedContent(result, browserManager.getCurrentUrl());
      }
    } else if (WRITE_COMMANDS.has(command)) {
      result = await handleWriteCommand(command, args, browserManager);
    } else if (META_COMMANDS.has(command)) {
      result = await handleMetaCommand(command, args, browserManager, shutdown);
      // Start periodic snapshot interval when watch mode begins
      if (command === 'watch' && args[0] !== 'stop' && browserManager.isWatching()) {
        const watchInterval = setInterval(async () => {
          if (!browserManager.isWatching()) {
            clearInterval(watchInterval);
            return;
          }
          try {
            const snapshot = await handleSnapshot(['-i'], browserManager);
            browserManager.addWatchSnapshot(snapshot);
          } catch {
            // Page may be navigating — skip this snapshot
          }
        }, 5000);
        browserManager.watchInterval = watchInterval;
      }
    } else if (command === 'help') {
      const helpText = generateHelpText();
      return new Response(helpText, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    } else {
      return new Response(JSON.stringify({
        error: `Unknown command: ${command}`,
        hint: `Available commands: ${[...READ_COMMANDS, ...WRITE_COMMANDS, ...META_COMMANDS].sort().join(', ')}`,
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Activity: emit command_end (success)
    emitActivity({
      type: 'command_end',
      command,
      args,
      url: browserManager.getCurrentUrl(),
      duration: Date.now() - startTime,
      status: 'ok',
      result: result,
      tabs: browserManager.getTabCount(),
      mode: browserManager.getConnectionMode(),
    });

    browserManager.resetFailures();
    // Restore original active tab if we pinned to a specific one
    if (savedTabId !== null) {
      try { browserManager.switchTab(savedTabId, { bringToFront: false }); } catch {}
    }
    return new Response(result, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  } catch (err: any) {
    // Restore original active tab even on error
    if (savedTabId !== null) {
      try { browserManager.switchTab(savedTabId, { bringToFront: false }); } catch {}
    }

    // Activity: emit command_end (error)
    emitActivity({
      type: 'command_end',
      command,
      args,
      url: browserManager.getCurrentUrl(),
      duration: Date.now() - startTime,
      status: 'error',
      error: err.message,
      tabs: browserManager.getTabCount(),
      mode: browserManager.getConnectionMode(),
    });

    browserManager.incrementFailures();
    let errorMsg = wrapError(err);
    const hint = browserManager.getFailureHint();
    if (hint) errorMsg += '\n' + hint;
    return new Response(JSON.stringify({ error: errorMsg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log('[browse] Shutting down...');
  // Clean up CDP inspector sessions
  try { detachSession(); } catch {}
  inspectorSubscribers.clear();
  // Stop watch mode if active
  if (browserManager.isWatching()) browserManager.stopWatch();
  agentManager.dispose();
  sessionStore.saveSession();
  if (sessionStore.session?.worktreePath) removeWorktree(sessionStore.session.worktreePath);
  clearInterval(flushInterval);
  clearInterval(idleCheckInterval);
  await flushBuffers(); // Final flush (async now)

  await browserManager.close();

  // Clean up Chromium profile locks (prevent SingletonLock on next launch)
  const profileDir = path.join(process.env.HOME || '/tmp', '.gstack', 'chromium-profile');
  for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try { fs.unlinkSync(path.join(profileDir, lockFile)); } catch {}
  }

  // Clean up state file
  try { fs.unlinkSync(config.stateFile); } catch {}

  process.exit(0);
}

// Handle signals
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
// Windows: taskkill /F bypasses SIGTERM, but 'exit' fires for some shutdown paths.
// Defense-in-depth — primary cleanup is the CLI's stale-state detection via health check.
if (process.platform === 'win32') {
  process.on('exit', () => {
    try { fs.unlinkSync(config.stateFile); } catch {}
  });
}

// Emergency cleanup for crashes (OOM, uncaught exceptions, browser disconnect)
function emergencyCleanup() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  try { agentManager.dispose(); } catch {}
  try { sessionStore.saveSession(); } catch {}
  // Clean Chromium profile locks
  const profileDir = path.join(process.env.HOME || '/tmp', '.gstack', 'chromium-profile');
  for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try { fs.unlinkSync(path.join(profileDir, lockFile)); } catch {}
  }
  try { fs.unlinkSync(config.stateFile); } catch {}
}
process.on('uncaughtException', (err) => {
  console.error('[browse] FATAL uncaught exception:', err.message);
  emergencyCleanup();
  process.exit(1);
});
process.on('unhandledRejection', (err: any) => {
  console.error('[browse] FATAL unhandled rejection:', err?.message || err);
  emergencyCleanup();
  process.exit(1);
});

// ─── Start ─────────────────────────────────────────────────────
async function start() {
  // Clear old log files
  try { fs.unlinkSync(CONSOLE_LOG_PATH); } catch {}
  try { fs.unlinkSync(NETWORK_LOG_PATH); } catch {}
  try { fs.unlinkSync(DIALOG_LOG_PATH); } catch {}

  const port = await findPort();

  // Launch browser (headless or headed with extension)
  // BROWSE_HEADLESS_SKIP=1 skips browser launch entirely (for HTTP-only testing)
  const skipBrowser = process.env.BROWSE_HEADLESS_SKIP === '1';
  if (!skipBrowser) {
    const headed = process.env.BROWSE_HEADED === '1';
    if (headed) {
      await browserManager.launchHeaded(AUTH_TOKEN);
      console.log(`[browse] Launched headed Chromium with extension`);
    } else {
      await browserManager.launch();
    }
  }

  const startTime = Date.now();
  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const url = new URL(req.url);

      // Cookie picker routes — HTML page unauthenticated, data/action routes require auth
      if (url.pathname.startsWith('/cookie-picker')) {
        return handleCookiePickerRoute(url, req, browserManager, AUTH_TOKEN);
      }

      // Health check — no auth required, does NOT reset idle timer
      if (url.pathname === '/health') {
        const healthy = await browserManager.isHealthy();
        return new Response(JSON.stringify({
          status: healthy ? 'healthy' : 'unhealthy',
          mode: browserManager.getConnectionMode(),
          uptime: Math.floor((Date.now() - startTime) / 1000),
          tabs: browserManager.getTabCount(),
          currentUrl: browserManager.getCurrentUrl(),
          // token removed — see .auth.json for extension bootstrap
          chatEnabled: true,
          agent: {
            status: agentManager.agentStatus,
            runningFor: agentManager.agentStartTime ? Date.now() - agentManager.agentStartTime : null,
            currentMessage: agentManager.currentMessage,
            queueLength: 0,
          },
          session: sessionStore.session ? { id: sessionStore.session.id, name: sessionStore.session.name } : null,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Refs endpoint — auth required, does NOT reset idle timer
      if (url.pathname === '/refs') {
        if (!validateAuth(req)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const refs = browserManager.getRefMap();
        return new Response(JSON.stringify({
          refs,
          url: browserManager.getCurrentUrl(),
          mode: browserManager.getConnectionMode(),
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Activity stream — SSE, auth required, does NOT reset idle timer
      if (url.pathname === '/activity/stream') {
        // Inline auth: accept Bearer header OR ?token= query param (EventSource can't send headers)
        const streamToken = url.searchParams.get('token');
        if (!validateAuth(req) && streamToken !== AUTH_TOKEN) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const afterId = parseInt(url.searchParams.get('after') || '0', 10);
        const encoder = new TextEncoder();

        const stream = new ReadableStream({
          start(controller) {
            // 1. Gap detection + replay
            const { entries, gap, gapFrom, availableFrom } = getActivityAfter(afterId);
            if (gap) {
              controller.enqueue(encoder.encode(`event: gap\ndata: ${JSON.stringify({ gapFrom, availableFrom })}\n\n`));
            }
            for (const entry of entries) {
              controller.enqueue(encoder.encode(`event: activity\ndata: ${JSON.stringify(entry)}\n\n`));
            }

            // 2. Subscribe for live events
            const unsubscribe = subscribe((entry) => {
              try {
                controller.enqueue(encoder.encode(`event: activity\ndata: ${JSON.stringify(entry)}\n\n`));
              } catch {
                unsubscribe();
              }
            });

            // 3. Heartbeat every 15s
            const heartbeat = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(`: heartbeat\n\n`));
              } catch {
                clearInterval(heartbeat);
                unsubscribe();
              }
            }, 15000);

            // 4. Cleanup on disconnect
            req.signal.addEventListener('abort', () => {
              clearInterval(heartbeat);
              unsubscribe();
              try { controller.close(); } catch {}
            });
          },
        });

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          },
        });
      }

      // Activity history — REST, auth required, does NOT reset idle timer
      if (url.pathname === '/activity/history') {
        if (!validateAuth(req)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
        const { entries, totalAdded } = getActivityHistory(limit);
        return new Response(JSON.stringify({ entries, totalAdded, subscribers: getSubscriberCount() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // ─── Sidebar endpoints (auth required — token from /health) ────

      // Sidebar routes are always available in headed mode (ungated in v0.12.0)

      // Browser tab list for sidebar tab bar
      if (url.pathname === '/sidebar-tabs') {
        if (!validateAuth(req)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        try {
          // Sync active tab from Chrome extension — detects manual tab switches
          const activeUrl = url.searchParams.get('activeUrl');
          if (activeUrl) {
            browserManager.syncActiveTabByUrl(activeUrl);
          }
          const tabs = await browserManager.getTabListWithTitles();
          return new Response(JSON.stringify({ tabs }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          });
        } catch (err: any) {
          return new Response(JSON.stringify({ tabs: [], error: err.message }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          });
        }
      }

      // Switch browser tab from sidebar
      if (url.pathname === '/sidebar-tabs/switch' && req.method === 'POST') {
        if (!validateAuth(req)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        const body = await req.json();
        const tabId = parseInt(body.id, 10);
        if (isNaN(tabId)) {
          return new Response(JSON.stringify({ error: 'Invalid tab id' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        try {
          browserManager.switchTab(tabId);
          return new Response(JSON.stringify({ ok: true, activeTab: tabId }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          });
        } catch (err: any) {
          return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
      }

      // Sidebar chat history — read from in-memory buffer
      if (url.pathname === '/sidebar-chat') {
        if (!validateAuth(req)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        const afterId = parseInt(url.searchParams.get('after') || '0', 10);
        const tabId = url.searchParams.get('tabId') ? parseInt(url.searchParams.get('tabId')!, 10) : null;
        const buf = tabId !== null ? sessionStore.getChatBuffer(tabId) : sessionStore.legacyChatBuffer;
        const entries = buf.filter(e => e.id >= afterId);
        const activeTab = browserManager?.getActiveTabId?.() ?? 0;
        const tabAgentStatus = tabId !== null ? agentManager.getTabAgentStatus(tabId) : agentManager.agentStatus;
        return new Response(JSON.stringify({ entries, total: sessionStore.chatNextId, agentStatus: tabAgentStatus, activeTabId: activeTab }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }

      // Sidebar → server: user message → queue or process immediately
      if (url.pathname === '/sidebar-command' && req.method === 'POST') {
        if (!validateAuth(req)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        const body = await req.json();
        const msg = body.message?.trim();
        if (!msg) {
          return new Response(JSON.stringify({ error: 'Empty message' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        // The Chrome extension sends the active tab's URL — prefer it over
        // Playwright's page.url() which can be stale in headed mode when
        // the user navigates manually.
        const extensionUrl = body.activeTabUrl || null;
        // Sync active tab BEFORE reading the ID — the user may have switched
        // tabs manually and the server's activeTabId is stale.
        if (extensionUrl) {
          browserManager.syncActiveTabByUrl(extensionUrl);
        }
        const msgTabId = browserManager?.getActiveTabId?.() ?? 0;
        const ts = new Date().toISOString();
        sessionStore.addChatEntry({ ts, role: 'user', message: msg }, msgTabId);
        if (sessionStore.session) { sessionStore.session.lastActiveAt = ts; sessionStore.saveSession(); }

        // Per-tab agent: each tab can run its own agent concurrently
        const tabState = agentManager.getTabAgent(msgTabId);
        if (tabState.status === 'idle') {
          agentManager.spawnClaude(msg, extensionUrl, msgTabId);
          return new Response(JSON.stringify({ ok: true, processing: true }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          });
        } else if (tabState.queue.length < agentManager.maxQueue) {
          tabState.queue.push({ message: msg, ts, extensionUrl });
          return new Response(JSON.stringify({ ok: true, queued: true, position: tabState.queue.length }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          });
        } else {
          return new Response(JSON.stringify({ error: 'Queue full (max 5)' }), {
            status: 429, headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      // Clear sidebar chat
      if (url.pathname === '/sidebar-chat/clear' && req.method === 'POST') {
        if (!validateAuth(req)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        sessionStore.clearChat();
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // Kill hung agent
      if (url.pathname === '/sidebar-agent/kill' && req.method === 'POST') {
        if (!validateAuth(req)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        agentManager.killAgent();
        const activeTabId = browserManager?.getActiveTabId?.() ?? 0;
        sessionStore.addChatEntry({ ts: new Date().toISOString(), role: 'agent', type: 'agent_error', error: 'Killed by user' }, activeTabId);
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // Stop agent (user-initiated)
      if (url.pathname === '/sidebar-agent/stop' && req.method === 'POST') {
        if (!validateAuth(req)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        agentManager.killAgent();
        const activeTabId = browserManager?.getActiveTabId?.() ?? 0;
        sessionStore.addChatEntry({ ts: new Date().toISOString(), role: 'agent', type: 'agent_error', error: 'Stopped by user' }, activeTabId);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }

      // Session info
      if (url.pathname === '/sidebar-session') {
        if (!validateAuth(req)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          session: sessionStore.session,
          agent: {
            status: agentManager.agentStatus,
            runningFor: agentManager.agentStartTime ? Date.now() - agentManager.agentStartTime : null,
            currentMessage: agentManager.currentMessage,
            queueLength: 0,
            queue: [],
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // Create new session
      if (url.pathname === '/sidebar-session/new' && req.method === 'POST') {
        if (!validateAuth(req)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        agentManager.killAgent();
        // Clean up old session's worktree before creating new one
        if (sessionStore.session?.worktreePath) removeWorktree(sessionStore.session.worktreePath);
        sessionStore.createSession(createWorktree(crypto.randomUUID()));
        return new Response(JSON.stringify({ ok: true, session: sessionStore.session }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }

      // List all sessions
      if (url.pathname === '/sidebar-session/list') {
        if (!validateAuth(req)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({ sessions: sessionStore.listSessions(), activeId: sessionStore.session?.id }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }

      // Agent event relay — sidebar-agent.ts POSTs events here
      if (url.pathname === '/sidebar-agent/event' && req.method === 'POST') {
        if (!validateAuth(req)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        const body = await req.json();
        const eventTabId = body.tabId ?? agentManager.agentTabId ?? 0;
        agentManager.processAgentEvent(body);
        if (body.type === 'agent_done' || body.type === 'agent_error') {
          agentManager.handleAgentComplete(eventTabId, body.type);
        }
        // Capture claude session ID for --resume
        if (body.claudeSessionId && sessionStore.session && !sessionStore.session.claudeSessionId) {
          sessionStore.session.claudeSessionId = body.claudeSessionId;
          sessionStore.saveSession();
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // ─── Auth-required endpoints ──────────────────────────────────

      if (!validateAuth(req)) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // ─── Inspector endpoints ──────────────────────────────────────

      // POST /inspector/pick — receive element pick from extension, run CDP inspection
      if (url.pathname === '/inspector/pick' && req.method === 'POST') {
        const body = await req.json();
        const { selector, activeTabUrl } = body;
        if (!selector) {
          return new Response(JSON.stringify({ error: 'Missing selector' }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
          });
        }
        try {
          const page = browserManager.getPage();
          const result = await inspectElement(page, selector);
          inspectorData = result;
          inspectorTimestamp = Date.now();
          // Also store on browserManager for CLI access
          (browserManager as any)._inspectorData = result;
          (browserManager as any)._inspectorTimestamp = inspectorTimestamp;
          emitInspectorEvent({ type: 'pick', selector, timestamp: inspectorTimestamp });
          return new Response(JSON.stringify(result), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          });
        } catch (err: any) {
          return new Response(JSON.stringify({ error: err.message }), {
            status: 500, headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      // GET /inspector — return latest inspector data
      if (url.pathname === '/inspector' && req.method === 'GET') {
        if (!inspectorData) {
          return new Response(JSON.stringify({ data: null }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          });
        }
        const stale = inspectorTimestamp > 0 && (Date.now() - inspectorTimestamp > 60000);
        return new Response(JSON.stringify({ data: inspectorData, timestamp: inspectorTimestamp, stale }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }

      // POST /inspector/apply — apply a CSS modification
      if (url.pathname === '/inspector/apply' && req.method === 'POST') {
        const body = await req.json();
        const { selector, property, value } = body;
        if (!selector || !property || value === undefined) {
          return new Response(JSON.stringify({ error: 'Missing selector, property, or value' }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
          });
        }
        try {
          const page = browserManager.getPage();
          const mod = await modifyStyle(page, selector, property, value);
          emitInspectorEvent({ type: 'apply', modification: mod, timestamp: Date.now() });
          return new Response(JSON.stringify(mod), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          });
        } catch (err: any) {
          return new Response(JSON.stringify({ error: err.message }), {
            status: 500, headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      // POST /inspector/reset — clear all modifications
      if (url.pathname === '/inspector/reset' && req.method === 'POST') {
        try {
          const page = browserManager.getPage();
          await resetModifications(page);
          emitInspectorEvent({ type: 'reset', timestamp: Date.now() });
          return new Response(JSON.stringify({ ok: true }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          });
        } catch (err: any) {
          return new Response(JSON.stringify({ error: err.message }), {
            status: 500, headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      // GET /inspector/history — return modification list
      if (url.pathname === '/inspector/history' && req.method === 'GET') {
        return new Response(JSON.stringify({ history: getModificationHistory() }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }

      // GET /inspector/events — SSE for inspector state changes
      if (url.pathname === '/inspector/events' && req.method === 'GET') {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            // Send current state immediately
            if (inspectorData) {
              controller.enqueue(encoder.encode(
                `event: state\ndata: ${JSON.stringify({ data: inspectorData, timestamp: inspectorTimestamp })}\n\n`
              ));
            }

            // Subscribe for live events
            const notify: InspectorSubscriber = (event) => {
              try {
                controller.enqueue(encoder.encode(
                  `event: inspector\ndata: ${JSON.stringify(event)}\n\n`
                ));
              } catch {
                inspectorSubscribers.delete(notify);
              }
            };
            inspectorSubscribers.add(notify);

            // Heartbeat every 15s
            const heartbeat = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(`: heartbeat\n\n`));
              } catch {
                clearInterval(heartbeat);
                inspectorSubscribers.delete(notify);
              }
            }, 15000);

            // Cleanup on disconnect
            req.signal.addEventListener('abort', () => {
              clearInterval(heartbeat);
              inspectorSubscribers.delete(notify);
              try { controller.close(); } catch {}
            });
          },
        });

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          },
        });
      }

      // ─── Command endpoint ──────────────────────────────────────────

      if (url.pathname === '/command' && req.method === 'POST') {
        resetIdleTimer();  // Only commands reset idle timer
        const body = await req.json();
        return handleCommand(body);
      }

      return new Response('Not found', { status: 404 });
    },
  });

  // Write state file (atomic: write .tmp then rename)
  const state: Record<string, unknown> = {
    pid: process.pid,
    port,
    token: AUTH_TOKEN,
    startedAt: new Date().toISOString(),
    serverPath: path.resolve(import.meta.dir, 'server.ts'),
    binaryVersion: readVersionHash() || undefined,
    mode: browserManager.getConnectionMode(),
  };
  const tmpFile = config.stateFile + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmpFile, config.stateFile);

  browserManager.serverPort = port;

  // Clean up stale state files (older than 7 days)
  try {
    const stateDir = path.join(config.stateDir, 'browse-states');
    if (fs.existsSync(stateDir)) {
      const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
      for (const file of fs.readdirSync(stateDir)) {
        const filePath = path.join(stateDir, file);
        const stat = fs.statSync(filePath);
        if (Date.now() - stat.mtimeMs > SEVEN_DAYS) {
          fs.unlinkSync(filePath);
          console.log(`[browse] Deleted stale state file: ${file}`);
        }
      }
    }
  } catch {}

  console.log(`[browse] Server running on http://127.0.0.1:${port} (PID: ${process.pid})`);
  console.log(`[browse] State file: ${config.stateFile}`);
  console.log(`[browse] Idle timeout: ${IDLE_TIMEOUT_MS / 1000}s`);

  // Initialize sidebar session (load existing or create new)
  sessionStore.init(() => createWorktree(crypto.randomUUID()));
  agentManager.startHealthCheck();
}

start().catch((err) => {
  console.error(`[browse] Failed to start: ${err.message}`);
  // Write error to disk for the CLI to read — on Windows, the CLI can't capture
  // stderr because the server is launched with detached: true, stdio: 'ignore'.
  try {
    const errorLogPath = path.join(config.stateDir, 'browse-startup-error.log');
    fs.mkdirSync(config.stateDir, { recursive: true });
    fs.writeFileSync(errorLogPath, `${new Date().toISOString()} ${err.message}\n${err.stack || ''}\n`);
  } catch {
    // stateDir may not exist — nothing more we can do
  }
  process.exit(1);
});
