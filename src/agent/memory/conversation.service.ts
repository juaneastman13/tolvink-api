import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ConversationSession {
  messages: ConversationMessage[];
  lastActivity: number; // timestamp
}

@Injectable()
export class ConversationService implements OnModuleDestroy {
  private readonly logger = new Logger(ConversationService.name);

  // In-memory storage: phone -> conversation messages
  private sessions = new Map<string, ConversationSession>();

  // Configuration
  private readonly MAX_MESSAGES_PER_CONV = 20;
  private readonly SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours (Meta session window)
  private readonly CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    // Periodic cleanup of expired sessions
    this.cleanupTimer = setInterval(() => this.cleanupExpiredSessions(), this.CLEANUP_INTERVAL_MS);
    // Initial cleanup after 1 minute
    setTimeout(() => this.cleanupExpiredSessions(), 60_000);
  }

  onModuleDestroy() {
    clearInterval(this.cleanupTimer);
  }

  /**
   * Get conversation history for a phone number.
   * Returns empty array if no history exists.
   */
  getHistory(phone: string): ConversationMessage[] {
    const session = this.sessions.get(phone);
    if (!session) {
      return [];
    }

    // Update last activity
    session.lastActivity = Date.now();

    // Return a copy to prevent external modification
    return [...session.messages];
  }

  /**
   * Append messages to a conversation.
   * Prunes old messages if history exceeds MAX_MESSAGES_PER_CONV.
   */
  appendMessages(phone: string, ...messages: ConversationMessage[]): void {
    let session = this.sessions.get(phone);

    if (!session) {
      session = {
        messages: [],
        lastActivity: Date.now(),
      };
      this.sessions.set(phone, session);
    }

    // Append new messages
    session.messages.push(...messages);
    session.lastActivity = Date.now();

    // Prune if over limit (remove oldest messages, keep newest)
    if (session.messages.length > this.MAX_MESSAGES_PER_CONV) {
      const numToRemove = session.messages.length - this.MAX_MESSAGES_PER_CONV;
      session.messages.splice(0, numToRemove);
      this.logger.debug(`Pruned ${numToRemove} messages for ${phone} (max: ${this.MAX_MESSAGES_PER_CONV})`);
    }
  }

  /**
   * Clear conversation history for a phone number.
   */
  clearHistory(phone: string): void {
    if (this.sessions.delete(phone)) {
      this.logger.debug(`Cleared history for ${phone}`);
    }
  }

  /**
   * Remove expired sessions (older than SESSION_TTL_MS).
   * Called periodically and on startup.
   */
  private cleanupExpiredSessions(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [phone, session] of this.sessions.entries()) {
      if (now - session.lastActivity > this.SESSION_TTL_MS) {
        this.sessions.delete(phone);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger.debug(`Cleaned up ${cleanedCount} expired sessions (TTL: ${this.SESSION_TTL_MS / 1000}s)`);
    }
  }

  /**
   * Get current session count (for debugging/monitoring)
   */
  getSessionCount(): number {
    return this.sessions.size;
  }
}
