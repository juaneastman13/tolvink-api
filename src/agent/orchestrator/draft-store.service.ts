import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';

export interface FreightDraft {
  draftId: string;
  phone: string;
  slots: Record<string, any>;
  createdAt: number;
}

/**
 * In-memory store for pending freight confirmations.
 * TTL: 15 min. Cleaned periodically.
 */
@Injectable()
export class DraftStore {
  private readonly logger = new Logger(DraftStore.name);
  private readonly drafts = new Map<string, FreightDraft>();
  private readonly TTL_MS = 15 * 60 * 1000;

  constructor() {
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  create(phone: string, slots: Record<string, any>): FreightDraft {
    const draftId = randomUUID();
    const draft: FreightDraft = { draftId, phone, slots, createdAt: Date.now() };
    this.drafts.set(draftId, draft);
    this.logger.debug(`Draft created: ${draftId} (phone ${phone.slice(-4)})`);
    return draft;
  }

  get(draftId: string): FreightDraft | null {
    const d = this.drafts.get(draftId);
    if (!d) return null;
    if (Date.now() - d.createdAt > this.TTL_MS) {
      this.drafts.delete(draftId);
      return null;
    }
    return d;
  }

  delete(draftId: string): void {
    this.drafts.delete(draftId);
  }

  /** Find the most recent active draft for a phone (used as fallback for stale button clicks). */
  findLatestByPhone(phone: string): FreightDraft | null {
    let latest: FreightDraft | null = null;
    for (const d of this.drafts.values()) {
      if (d.phone !== phone) continue;
      if (Date.now() - d.createdAt > this.TTL_MS) continue;
      if (!latest || d.createdAt > latest.createdAt) latest = d;
    }
    return latest;
  }

  private cleanup(): void {
    const now = Date.now();
    let removed = 0;
    for (const [id, d] of this.drafts.entries()) {
      if (now - d.createdAt > this.TTL_MS) {
        this.drafts.delete(id);
        removed++;
      }
    }
    if (removed > 0) this.logger.debug(`Cleaned ${removed} expired drafts`);
  }
}
