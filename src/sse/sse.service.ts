import { Injectable, Logger } from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from '../database/prisma.service';

interface SseClient {
  userId: string;
  companyIds: string[];
  res: Response;
}

@Injectable()
export class SseService {
  private readonly logger = new Logger(SseService.name);
  private clients: SseClient[] = [];

  constructor(private prisma: PrismaService) {}

  addClient(userId: string, companyIds: string[], res: Response) {
    const client: SseClient = { userId, companyIds, res };
    this.clients.push(client);
    this.logger.log(`SSE client connected: user=${userId} (${this.clients.length} total)`);

    // Remove on disconnect
    res.on('close', () => {
      this.clients = this.clients.filter((c) => c !== client);
      this.logger.log(`SSE client disconnected: user=${userId} (${this.clients.length} total)`);
    });
  }

  /** Send event to a specific user (all their tabs) */
  emitToUser(userId: string, event: string, data: any) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      if (client.userId === userId) {
        client.res.write(payload);
      }
    }
  }

  /** Send event to all users of a company */
  emitToCompany(companyId: string, event: string, data: any, excludeUserId?: string) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      if (client.companyIds.includes(companyId) && client.userId !== excludeUserId) {
        client.res.write(payload);
      }
    }
  }

  /** Broadcast freight update to all involved companies */
  async broadcastFreightUpdate(
    freightId: string,
    data: { id: string; code: string; status: string },
    excludeUserId?: string,
  ) {
    // Find all companies involved in this freight
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
    for (const a of freight.assignments) {
      companyIds.add(a.transportCompanyId);
    }

    const payload = `event: freight:updated\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      if (client.userId !== excludeUserId && client.companyIds.some((id) => companyIds.has(id))) {
        client.res.write(payload);
      }
    }
  }

  /** Broadcast to conversation participants */
  async broadcastMessage(conversationId: string, senderId: string) {
    const participants = await this.prisma.conversationParticipant.findMany({
      where: { conversationId },
      select: { userId: true },
    });

    const data = { conversationId };
    const payload = `event: message:new\ndata: ${JSON.stringify(data)}\n\n`;
    for (const p of participants) {
      if (p.userId && p.userId !== senderId) {
        for (const client of this.clients) {
          if (client.userId === p.userId) {
            client.res.write(payload);
          }
        }
      }
    }
  }

  /** Send heartbeat to all clients (keep connections alive) */
  heartbeat() {
    const payload = `: heartbeat\n\n`;
    const dead: SseClient[] = [];
    for (const client of this.clients) {
      try {
        client.res.write(payload);
      } catch {
        dead.push(client);
      }
    }
    if (dead.length > 0) {
      this.clients = this.clients.filter((c) => !dead.includes(c));
      this.logger.log(`Cleaned ${dead.length} dead SSE clients`);
    }
  }

  getClientCount(): number {
    return this.clients.length;
  }
}
