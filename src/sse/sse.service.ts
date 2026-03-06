import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from '../database/prisma.service';

interface SseClient {
  userId: string;
  companyIds: string[];
  res: Response;
  lastActivity: number;
}

const MAX_CLIENTS_PER_USER = 3;
const MAX_CLIENTS_GLOBAL = 500;
const CLIENT_TIMEOUT_MS = 5 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds

@Injectable()
export class SseService implements OnModuleDestroy {
  private readonly logger = new Logger(SseService.name);
  // O(1) lookup indexes instead of flat array scan
  private byUser = new Map<string, Set<SseClient>>();
  private byCompany = new Map<string, Set<SseClient>>();
  private allClients = new Set<SseClient>();
  private heartbeatTimer: ReturnType<typeof setInterval>;

  // In-memory cache for conversation participants (avoids repeated DB queries)
  private participantsCache = new Map<string, { userIds: string[]; ts: number }>();
  private readonly PARTICIPANTS_CACHE_TTL = 30_000; // 30 seconds

  constructor(private prisma: PrismaService) {
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);
  }

  onModuleDestroy() {
    clearInterval(this.heartbeatTimer);
    for (const client of this.allClients) {
      try { client.res.end(); } catch {}
    }
    this.allClients.clear();
    this.byUser.clear();
    this.byCompany.clear();
    this.logger.log('SSE clients drained on shutdown');
  }

  private async getParticipantIds(conversationId: string): Promise<string[]> {
    const cached = this.participantsCache.get(conversationId);
    if (cached && Date.now() - cached.ts < this.PARTICIPANTS_CACHE_TTL) return cached.userIds;
    const participants = await this.prisma.conversationParticipant.findMany({
      where: { conversationId },
      select: { userId: true },
    });
    const userIds = participants.map(p => p.userId).filter(Boolean);
    this.participantsCache.set(conversationId, { userIds, ts: Date.now() });
    // Always cleanup stale entries
    const pcNow = Date.now();
    for (const [k, v] of this.participantsCache) {
      if (pcNow - v.ts > this.PARTICIPANTS_CACHE_TTL) this.participantsCache.delete(k);
    }
    return userIds;
  }

  private addToIndex(client: SseClient) {
    // User index
    let userSet = this.byUser.get(client.userId);
    if (!userSet) { userSet = new Set(); this.byUser.set(client.userId, userSet); }
    userSet.add(client);
    // Company index
    for (const cid of client.companyIds) {
      let coSet = this.byCompany.get(cid);
      if (!coSet) { coSet = new Set(); this.byCompany.set(cid, coSet); }
      coSet.add(client);
    }
    this.allClients.add(client);
  }

  private removeFromIndex(client: SseClient) {
    const userSet = this.byUser.get(client.userId);
    if (userSet) { userSet.delete(client); if (userSet.size === 0) this.byUser.delete(client.userId); }
    for (const cid of client.companyIds) {
      const coSet = this.byCompany.get(cid);
      if (coSet) { coSet.delete(client); if (coSet.size === 0) this.byCompany.delete(cid); }
    }
    this.allClients.delete(client);
  }

  addClient(userId: string, companyIds: string[], res: Response) {
    // Reject if global limit reached
    if (this.allClients.size >= MAX_CLIENTS_GLOBAL) {
      this.logger.warn(`SSE global limit reached (${MAX_CLIENTS_GLOBAL}), rejecting user=${userId}`);
      res.status(503).end();
      return;
    }

    // Evict oldest if user exceeds max
    const userSet = this.byUser.get(userId);
    if (userSet && userSet.size >= MAX_CLIENTS_PER_USER) {
      const oldest = userSet.values().next().value;
      try { oldest.res.end(); } catch {}
      this.removeFromIndex(oldest);
      this.logger.log(`SSE evicted oldest client for user=${userId}`);
    }

    const client: SseClient = { userId, companyIds, res, lastActivity: Date.now() };
    this.addToIndex(client);
    this.logger.log(`SSE client connected: user=${userId} (${this.allClients.size} total)`);

    res.on('close', () => {
      this.removeFromIndex(client);
      this.logger.log(`SSE client disconnected: user=${userId} (${this.allClients.size} total)`);
    });
  }

  /** Send event to a specific user — O(1) lookup */
  emitToUser(userId: string, event: string, data: any) {
    const clients = this.byUser.get(userId);
    if (!clients || clients.size === 0) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const dead: SseClient[] = [];
    for (const c of clients) {
      try { c.res.write(payload); c.lastActivity = Date.now(); } catch { dead.push(c); }
    }
    for (const c of dead) { try { c.res.end(); } catch {} this.removeFromIndex(c); }
  }

  /** Send event to all users of a company — O(k) where k = company clients */
  emitToCompany(companyId: string, event: string, data: any, excludeUserId?: string) {
    const clients = this.byCompany.get(companyId);
    if (!clients || clients.size === 0) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const dead: SseClient[] = [];
    for (const c of clients) {
      if (c.userId !== excludeUserId) {
        try { c.res.write(payload); c.lastActivity = Date.now(); } catch { dead.push(c); }
      }
    }
    for (const c of dead) { try { c.res.end(); } catch {} this.removeFromIndex(c); }
  }

  /** Broadcast freight update to all involved companies (including actor) */
  async broadcastFreightUpdate(
    freightId: string,
    data: { id: string; code: string; status: string },
    _excludeUserId?: string, // kept for API compat, no longer used
  ) {
    const freight = await this.prisma.freight.findUnique({
      where: { id: freightId },
      select: {
        originCompanyId: true,
        destCompanyId: true,
        assignments: {
          where: { status: { in: ['active', 'accepted'] } },
          select: { transportCompanyId: true },
        },
      },
    });
    if (!freight) return;

    const companyIds = new Set<string>();
    companyIds.add(freight.originCompanyId);
    if (freight.destCompanyId) companyIds.add(freight.destCompanyId);
    for (const a of freight.assignments) companyIds.add(a.transportCompanyId);

    const payload = `event: freight:updated\ndata: ${JSON.stringify(data)}\n\n`;
    const sent = new Set<SseClient>();
    const dead: SseClient[] = [];
    for (const cid of companyIds) {
      const clients = this.byCompany.get(cid);
      if (!clients) continue;
      for (const c of clients) {
        if (!sent.has(c)) {
          try { c.res.write(payload); } catch { dead.push(c); }
          sent.add(c);
        }
      }
    }
    for (const c of dead) { try { c.res.end(); } catch {} this.removeFromIndex(c); }
  }

  /** Broadcast to conversation participants — O(1) per user, cached */
  async broadcastMessage(conversationId: string, senderId: string) {
    const userIds = await this.getParticipantIds(conversationId);

    const data = { conversationId };
    for (const uid of userIds) {
      if (uid && uid !== senderId) {
        this.emitToUser(uid, 'message:new', data);
      }
    }
  }

  /** Broadcast typing indicator to conversation participants — cached */
  async broadcastTyping(conversationId: string, userId: string, userName: string) {
    const userIds = await this.getParticipantIds(conversationId);
    const data = { conversationId, userId, userName };
    for (const uid of userIds) {
      if (uid && uid !== userId) {
        this.emitToUser(uid, 'typing', data);
      }
    }
  }

  /** Notify other participants that user read the conversation — cached */
  async broadcastRead(conversationId: string, readByUserId: string) {
    const userIds = await this.getParticipantIds(conversationId);
    const data = { conversationId, readByUserId, readAt: new Date().toISOString() };
    for (const uid of userIds) {
      if (uid && uid !== readByUserId) {
        this.emitToUser(uid, 'read', data);
      }
    }
  }

  /** Invalidate cached participant list for a conversation */
  invalidateParticipantsCache(conversationId: string) {
    this.participantsCache.delete(conversationId);
  }

  /** Heartbeat + timeout cleanup */
  heartbeat() {
    const payload = `event: ping\ndata: {}\n\n`;
    const now = Date.now();
    const dead: SseClient[] = [];
    for (const client of this.allClients) {
      if (now - client.lastActivity > CLIENT_TIMEOUT_MS) {
        dead.push(client);
        try { client.res.end(); } catch {}
        continue;
      }
      try {
        client.res.write(payload);
        client.lastActivity = now;
      } catch {
        dead.push(client);
      }
    }
    if (dead.length > 0) {
      for (const c of dead) this.removeFromIndex(c);
      this.logger.log(`Cleaned ${dead.length} dead SSE clients (${this.allClients.size} remaining)`);
    }
  }

  getClientCount(): number {
    return this.allClients.size;
  }
}
