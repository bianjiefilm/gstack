/**
 * Session store — sidebar session CRUD, chat buffers, worktree management.
 *
 * Extracted from server.ts to make session logic independently testable.
 * All filesystem access goes through the injected `fs` (defaults to Node fs),
 * and subprocess spawning goes through `spawnSync` (defaults to Bun.spawnSync).
 */

import * as nodeFs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ─── Types ──────────────────────────────────────────────────────

export interface ChatEntry {
  id: number;
  ts: string;
  role: 'user' | 'assistant' | 'agent';
  message?: string;
  type?: string;
  tool?: string;
  input?: string;
  text?: string;
  error?: string;
  tabId?: number;
}

export interface SidebarSession {
  id: string;
  name: string;
  claudeSessionId: string | null;
  worktreePath: string | null;
  createdAt: string;
  lastActiveAt: string;
}

export interface SessionStoreOptions {
  sessionsDir: string;
  fs?: typeof nodeFs;
}

// ─── Session Store ──────────────────────────────────────────────

export class SessionStore {
  readonly sessionsDir: string;
  private readonly _fs: typeof nodeFs;

  // Chat state
  private _chatBuffers = new Map<number, ChatEntry[]>();
  private _legacyChatBuffer: ChatEntry[] = [];
  private _chatNextId = 0;

  // Current session
  private _session: SidebarSession | null = null;

  constructor(opts: SessionStoreOptions) {
    this.sessionsDir = opts.sessionsDir;
    this._fs = opts.fs ?? nodeFs;
    this._fs.mkdirSync(this.sessionsDir, { recursive: true });
  }

  get session(): SidebarSession | null { return this._session; }
  get legacyChatBuffer(): ChatEntry[] { return this._legacyChatBuffer; }
  get chatNextId(): number { return this._chatNextId; }

  // ─── Chat buffer operations ─────────────────────────────────

  getChatBuffer(tabId: number): ChatEntry[] {
    if (!this._chatBuffers.has(tabId)) this._chatBuffers.set(tabId, []);
    return this._chatBuffers.get(tabId)!;
  }

  addChatEntry(entry: Omit<ChatEntry, 'id'>, tabId: number): ChatEntry {
    const full: ChatEntry = { ...entry, id: this._chatNextId++, tabId };
    const buf = this.getChatBuffer(tabId);
    buf.push(full);
    // Legacy buffer for session persistence
    this._legacyChatBuffer.push(full);
    // Persist to disk (best-effort)
    if (this._session) {
      const chatFile = path.join(this.sessionsDir, this._session.id, 'chat.jsonl');
      try { this._fs.appendFileSync(chatFile, JSON.stringify(full) + '\n'); } catch {}
    }
    return full;
  }

  clearChat(): void {
    this._legacyChatBuffer = [];
    this._chatBuffers.clear();
    this._chatNextId = 0;
    if (this._session) {
      try {
        this._fs.writeFileSync(
          path.join(this.sessionsDir, this._session.id, 'chat.jsonl'), ''
        );
      } catch {}
    }
  }

  // ─── Session CRUD ───────────────────────────────────────────

  loadSession(): SidebarSession | null {
    try {
      const activeFile = path.join(this.sessionsDir, 'active.json');
      const activeData = JSON.parse(this._fs.readFileSync(activeFile, 'utf-8'));
      const sessionFile = path.join(this.sessionsDir, activeData.id, 'session.json');
      const session = JSON.parse(this._fs.readFileSync(sessionFile, 'utf-8')) as SidebarSession;

      // Validate worktree still exists
      if (session.worktreePath && !this._fs.existsSync(session.worktreePath)) {
        console.log(`[browse] Stale worktree path: ${session.worktreePath} — clearing`);
        session.worktreePath = null;
      }
      // Clear stale claude session ID — can't resume across server restarts
      if (session.claudeSessionId) {
        console.log(`[browse] Clearing stale claude session: ${session.claudeSessionId}`);
        session.claudeSessionId = null;
      }

      // Load chat history
      const chatFile = path.join(this.sessionsDir, session.id, 'chat.jsonl');
      try {
        const lines = this._fs.readFileSync(chatFile, 'utf-8').split('\n').filter(Boolean);
        this._legacyChatBuffer = lines.map(line => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);
        this._chatNextId = this._legacyChatBuffer.length > 0
          ? Math.max(...this._legacyChatBuffer.map(e => e.id)) + 1 : 0;
      } catch {}

      this._session = session;
      return session;
    } catch {
      return null;
    }
  }

  createSession(worktreePath: string | null = null): SidebarSession {
    const id = crypto.randomUUID();
    const session: SidebarSession = {
      id,
      name: 'Chrome sidebar',
      claudeSessionId: null,
      worktreePath,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    };
    const sessionDir = path.join(this.sessionsDir, id);
    this._fs.mkdirSync(sessionDir, { recursive: true });
    this._fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(session, null, 2));
    this._fs.writeFileSync(path.join(sessionDir, 'chat.jsonl'), '');
    this._fs.writeFileSync(path.join(this.sessionsDir, 'active.json'), JSON.stringify({ id }));

    this._legacyChatBuffer = [];
    this._chatBuffers.clear();
    this._chatNextId = 0;
    this._session = session;
    return session;
  }

  saveSession(): void {
    if (!this._session) return;
    this._session.lastActiveAt = new Date().toISOString();
    const sessionFile = path.join(this.sessionsDir, this._session.id, 'session.json');
    try { this._fs.writeFileSync(sessionFile, JSON.stringify(this._session, null, 2)); } catch {}
  }

  listSessions(): Array<SidebarSession & { chatLines: number }> {
    try {
      const dirs = this._fs.readdirSync(this.sessionsDir).filter(d => d !== 'active.json');
      return dirs.map(d => {
        try {
          const session = JSON.parse(
            this._fs.readFileSync(path.join(this.sessionsDir, d, 'session.json'), 'utf-8')
          );
          let chatLines = 0;
          try {
            chatLines = this._fs.readFileSync(
              path.join(this.sessionsDir, d, 'chat.jsonl'), 'utf-8'
            ).split('\n').filter(Boolean).length;
          } catch {}
          return { ...session, chatLines };
        } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  }

  /**
   * Initialize: load existing session or create a new one.
   */
  init(worktreeFactory?: () => string | null): void {
    this._session = this.loadSession();
    if (!this._session) {
      const worktreePath = worktreeFactory?.() ?? null;
      this._session = this.createSession(worktreePath);
    }
    console.log(`[browse] Sidebar session: ${this._session.id} (${this._legacyChatBuffer.length} chat entries loaded)`);
  }
}

// ─── Worktree helpers ───────────────────────────────────────────

/**
 * Create a git worktree for session isolation.
 * Falls back to null if not in a git repo or creation fails.
 */
export function createWorktree(sessionId: string): string | null {
  try {
    const gitCheck = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
      stdout: 'pipe', stderr: 'pipe', timeout: 3000,
    });
    if (gitCheck.exitCode !== 0) return null;
    const repoRoot = gitCheck.stdout.toString().trim();

    const worktreeDir = path.join(
      process.env.HOME || '/tmp', '.gstack', 'worktrees', sessionId.slice(0, 8)
    );

    // Clean up if dir exists from prior crash
    if (nodeFs.existsSync(worktreeDir)) {
      Bun.spawnSync(['git', 'worktree', 'remove', '--force', worktreeDir], {
        cwd: repoRoot, stdout: 'pipe', stderr: 'pipe', timeout: 5000,
      });
      try { nodeFs.rmSync(worktreeDir, { recursive: true, force: true }); } catch {}
    }

    const headCheck = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
      cwd: repoRoot, stdout: 'pipe', stderr: 'pipe', timeout: 3000,
    });
    if (headCheck.exitCode !== 0) return null;
    const head = headCheck.stdout.toString().trim();

    const result = Bun.spawnSync(['git', 'worktree', 'add', '--detach', worktreeDir, head], {
      cwd: repoRoot, stdout: 'pipe', stderr: 'pipe', timeout: 10000,
    });

    if (result.exitCode !== 0) {
      console.log(`[browse] Worktree creation failed: ${result.stderr.toString().trim()}`);
      return null;
    }

    console.log(`[browse] Created worktree: ${worktreeDir}`);
    return worktreeDir;
  } catch (err: any) {
    console.log(`[browse] Worktree creation error: ${err.message}`);
    return null;
  }
}

export function removeWorktree(worktreePath: string | null): void {
  if (!worktreePath) return;
  try {
    const gitCheck = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
      stdout: 'pipe', stderr: 'pipe', timeout: 3000,
    });
    if (gitCheck.exitCode === 0) {
      Bun.spawnSync(['git', 'worktree', 'remove', '--force', worktreePath], {
        cwd: gitCheck.stdout.toString().trim(), stdout: 'pipe', stderr: 'pipe', timeout: 5000,
      });
    }
    try { nodeFs.rmSync(worktreePath, { recursive: true, force: true }); } catch {}
  } catch {}
}
