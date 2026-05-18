import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { buildSyntheticUser } from '../../../common/build-synthetic-user';

export interface UserContext {
  userId: string;
  companyId: string;
  companyType: string;
  name?: string;
}

@Injectable()
export class UserContextService {
  private readonly logger = new Logger(UserContextService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Look up user by WhatsApp phone number.
   * WhatsApp delivers phone in E.164 format without +: "59899123456" (country 598 + local number)
   * DB stores in local format: "099123456"
   * Try both formats, return user context if found.
   */
  async getUserContext(waPhone: string): Promise<UserContext | null> {
    if (!waPhone) return null;

    // Normalize WhatsApp phone to DB format
    // WA: "59899123456" → DB: "099123456"
    const dbPhone = this.normalizeToDbFormat(waPhone);

    const dbUser = await this.prisma.user.findFirst({
      where: {
        active: true,
        OR: [{ phone: waPhone }, { phone: dbPhone }],
      },
      select: {
        id: true,
        name: true,
        role: true,
        activeCompanyId: true,
        companyId: true,
        userTypes: true,
        companyByType: true,
        company: { select: { type: true, types: true } },
        memberships: {
          where: { active: true },
          select: {
            companyId: true,
            company: { select: { type: true, types: true } },
          },
        },
      },
    });

    if (!dbUser) {
      this.logger.debug(`User not found for phone: ${waPhone.slice(-4)}`);
      return null;
    }

    // Build synthetic user (same as auth does for JWT-like objects)
    // Cast to bypass JSON type issues from Prisma
    const synthUser = buildSyntheticUser(dbUser as any);

    this.logger.debug(`Found user: ${dbUser.id.slice(0, 8)}... (${synthUser.companyType})`);

    return {
      userId: dbUser.id,
      companyId: synthUser.companyId,
      companyType: synthUser.companyType,
      name: dbUser.name,
    };
  }

  /**
   * Normalize WhatsApp phone to DB format.
   * WA: "59899123456" → DB: "099123456"
   * Strip "598" country code, add leading "0".
   */
  private normalizeToDbFormat(waPhone: string): string {
    let p = waPhone.replace(/[\s\-\(\)]/g, '');
    if (p.startsWith('598')) {
      // 598 + 9 digits (9 = first digit of local number 0-9)
      return '0' + p.slice(3);
    }
    return p;
  }
}
