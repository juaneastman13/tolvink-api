import {
  Controller, Get, Patch, Param, Body, UseGuards,
  BadRequestException, ForbiddenException, Injectable,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsOptional, IsIn } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../database/prisma.service';

// ── DTOs ──────────────────────────────────────────────────────────────

export class UpdatePreferredModuleDto {
  @IsString()
  @IsOptional()
  @IsIn(['logistics', 'mechanic', null])
  preferredModule: string | null;
}

// ── Service ───────────────────────────────────────────────────────────

@Injectable()
export class ModulesService {
  constructor(private prisma: PrismaService) {}

  async getCompanyModules(companyId: string, userId: string) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { enabledModules: true },
    });
    if (!company) throw new BadRequestException('Empresa no encontrada');

    const membership = await this.prisma.userCompany.findUnique({
      where: { userId_companyId: { userId, companyId } },
      select: { preferredModule: true },
    });

    return {
      enabledModules: company.enabledModules,
      preferredModule: membership?.preferredModule ?? null,
    };
  }

  async updatePreferredModule(userId: string, activeCompanyId: string, preferredModule: string | null) {
    // Validate module is within company's enabled modules
    if (preferredModule) {
      const company = await this.prisma.company.findUnique({
        where: { id: activeCompanyId },
        select: { enabledModules: true },
      });
      if (!company) throw new BadRequestException('Empresa no encontrada');
      if (!company.enabledModules.includes(preferredModule)) {
        throw new BadRequestException(`El módulo "${preferredModule}" no está habilitado para esta empresa`);
      }
    }

    await this.prisma.userCompany.updateMany({
      where: { userId, companyId: activeCompanyId },
      data: { preferredModule },
    });

    return { preferredModule };
  }
}

// ── Controller ────────────────────────────────────────────────────────

@ApiTags('Modules')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class ModulesController {
  constructor(private modulesService: ModulesService) {}

  @Get('companies/:companyId/modules')
  async getModules(
    @Param('companyId') companyId: string,
    @CurrentUser() user: any,
  ) {
    const activeId = user.activeCompanyId || user.companyId;
    if (companyId !== activeId) {
      throw new ForbiddenException('No tenés acceso a esta empresa');
    }
    return this.modulesService.getCompanyModules(companyId, user.sub);
  }

  @Patch('users/preferred-module')
  async updatePreferredModule(
    @Body() dto: UpdatePreferredModuleDto,
    @CurrentUser() user: any,
  ) {
    const activeId = user.activeCompanyId || user.companyId;
    return this.modulesService.updatePreferredModule(user.sub, activeId, dto.preferredModule);
  }
}
