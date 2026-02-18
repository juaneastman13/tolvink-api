import { Injectable, Logger } from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from '../database/prisma.service';

interface SseClient {
  userId: string;
  companyIds: string[];
  res: Response;
  lastActivity: number;
}

const MAX_CLIENTS_PER_USER = 3;
const CLIENT_TIMEOUT_MS = 5 * 60 * 1000;

@Injectable()
export class SseService {
  private readonly logger = new Logger(SseService.name);
  // O(1) lookup indexes instead of flat array scan
  private byUser = new Map<string, Set<SseClient>>();
  private byCompany = new Map<string, Set<SseClient>>();
  private allClients = new Set<SseClient>();

  constructor(private prisma: PrismaService) {}

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
    for (const c of clients) c.res.write(payload);
  }

  /** Send event to all users of a company — O(k) where k = company clients */
  emitToCompany(companyId: string, event: string, data: any, excludeUserId?: string) {
    const clients = this.byCompany.get(companyId);
    if (!clients || clients.size === 0) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) {
      if (c.userId !== excludeUserId) c.res.write(payload);
    }
  }

  /** Broadcast freight update to all involved companies */
  async broadcastFreightUpdate(
    freightId: string,
    data: { id: string; code: string; status: string },
    excludeUserId?: string,
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
    for (const cid of companyIds) {
      const clients = this.byCompany.get(cid);
      if (!clients) continue;
      for (const c of clients) {
        if (c.userId !== excludeUserId && !sent.has(c)) {
          c.res.write(payload);
          sent.add(c);
        }
      }
    }
  }

  /** Broadcast to conversation participants — O(1) per user */
  async broadcastMessage(conversationId: string, senderId: string) {
    const participants = await this.prisma.conversationParticipant.findMany({
      where: { conversationId },
      select: { userId: true },
    });

    const data = { conversationId };
    const payload = `event: message:new\ndata: ${JSON.stringify(data)}\n\n`;
    for (const p of participants) {
      if (p.userId && p.userId !== senderId) {
        this.emitToUser(p.userId, 'message:new', data);
      }
    }
  }

  /** Heartbeat + timeout cleanup */
  heartbeat() {
    const payload = `: heartbeat\n\n`;
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
