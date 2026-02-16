import { Controller, Post, Body, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PrismaService } from '../database/prisma.service';

@ApiTags('Auth Debug')
@Controller('auth/debug')
export class AuthDebugController {
  constructor(private prisma: PrismaService) {}

  @Get('health')
  @ApiOperation({ summary: 'Health check con info del sistema' })
  async health() {
    try {
      // Test database connection
      await this.prisma.$queryRaw`SELECT 1`;

      // Get user count
      const userCount = await this.prisma.user.count();

      return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        database: 'connected',
        userCount,
        env: {
          nodeEnv: process.env.NODE_ENV,
          hasJwtSecret: !!process.env.JWT_SECRET,
          jwtSecretLength: process.env.JWT_SECRET?.length || 0,
        }
      };
    } catch (error) {
      return {
        status: 'error',
        timestamp: new Date().toISOString(),
        error: error.message,
        stack: error.stack,
      };
    }
  }

  @Post('test-user')
  @ApiOperation({ summary: 'Verificar si un usuario existe' })
  async testUser(@Body() body: { email: string }) {
    try {
      const user = await this.prisma.user.findFirst({
        where: { email: body.email },
        include: { company: true }
      });

      if (!user) {
        return {
          found: false,
          message: 'Usuario no encontrado',
        };
      }

      return {
        found: true,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          active: user.active,
          hasPassword: !!user.passwordHash,
          passwordHashLength: user.passwordHash?.length || 0,
          companyId: user.companyId,
          hasCompany: !!user.company,
          company: user.company ? {
            id: user.company.id,
            name: user.company.name,
            type: user.company.type,
          } : null,
          userTypes: user.userTypes,
          isSuperAdmin: user.isSuperAdmin,
          lastLogin: user.lastLogin,
        }
      };
    } catch (error) {
      return {
        found: false,
        error: error.message,
        stack: error.stack,
      };
    }
  }

  @Post('test-login')
  @ApiOperation({ summary: 'Simular login sin bcrypt' })
  async testLogin(@Body() body: { email: string }) {
    try {
      console.log('[DEBUG] Test login for:', body.email);

      // Step 1: Find user
      const user = await this.prisma.user.findFirst({
        where: { email: body.email },
        include: {
          company: {
            select: { id: true, name: true, type: true, hasInternalFleet: true }
          }
        },
      });

      console.log('[DEBUG] User found:', user ? 'yes' : 'no');

      if (!user) {
        return {
          step: 'find_user',
          success: false,
          message: 'Usuario no encontrado',
        };
      }

      if (!user.active) {
        return {
          step: 'check_active',
          success: false,
          message: 'Usuario inactivo',
        };
      }

      // Step 2: Check password hash
      if (!user.passwordHash) {
        return {
          step: 'check_password',
          success: false,
          message: 'Usuario sin passwordHash',
        };
      }

      console.log('[DEBUG] Password hash exists');

      // Step 3: Try to build response
      try {
        const userResponse = {
          id: user.id,
          name: user.name,
          email: user.email,
          phone: user.phone || null,
          role: user.role,
          userTypes: user.userTypes || [],
          isSuperAdmin: user.isSuperAdmin || false,
          company: user.company || null,
        };

        console.log('[DEBUG] User response built successfully');

        // Step 4: Try to build token payload
        const tokenPayload = {
          sub: user.id,
          role: user.role,
          companyId: user.companyId || user.company?.id || null,
          companyType: user.company?.type || null,
        };

        console.log('[DEBUG] Token payload:', tokenPayload);

        return {
          step: 'complete',
          success: true,
          message: 'Login simulation successful',
          userResponse,
          tokenPayload,
        };
      } catch (buildError) {
        console.error('[DEBUG] Error building response:', buildError);
        return {
          step: 'build_response',
          success: false,
          message: 'Error al construir respuesta',
          error: buildError.message,
          stack: buildError.stack,
        };
      }

    } catch (error) {
      console.error('[DEBUG] Test login error:', error);
      return {
        step: 'unknown',
        success: false,
        error: error.message,
        stack: error.stack,
      };
    }
  }
}
