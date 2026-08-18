import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationType } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { CompanyResolutionService } from '../common/services/company-resolution.service';
import { NotificationService } from '../notifications/notification.service';
import { BpsClient, BpsCaptchaError, BpsLoginError, BpsUnavailableError } from './bps-client';
import { decryptSecret, encryptSecret, loadBpsKey } from './bps-crypto';
import { ConectarCuentaDto, ConsultarCertificadoDto, MonitorearEmpresaDto, UpdateBpsConfigDto } from './bps.dto';

const TIPOS_DATO = ['OBSERVACIONES', 'OBLIGACIONES', 'NOMINA'] as const;
type TipoDato = (typeof TIPOS_DATO)[number];

/** RUT uruguayo: 12 dígitos con dígito verificador módulo 11. */
export function validarRut(rut: string): boolean {
  const d = String(rut || '').replace(/\D/g, '');
  if (d.length !== 12) return false;
  const pesos = [4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((s, p, i) => s + p * parseInt(d[i], 10), 0);
  const resto = suma % 11;
  const dv = resto === 0 ? 0 : 11 - resto;
  if (dv === 10) return false;
  return dv === parseInt(d[11], 10);
}

@Injectable()
export class BpsService {
  private readonly logger = new Logger(BpsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly companyRes: CompanyResolutionService,
    private readonly config: ConfigService,
    private readonly client: BpsClient,
    private readonly notifications: NotificationService,
  ) {}

  // ======================== CONTEXTO / GUARDS ==========================

  private async resolveBpsContext(user: any) {
    const companyId = user.activeCompanyId || user.companyId;
    if (!companyId) throw new ForbiddenException('No hay empresa activa seleccionada');

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { id: true, name: true, active: true },
    });
    if (!company?.active) throw new ForbiddenException('Empresa activa no disponible');

    const memberships = await this.companyRes.resolveAllCompanyIds(user);
    if (!memberships.includes(companyId) && user.role !== 'platform_admin') {
      throw new ForbiddenException('No tenés acceso a la empresa activa');
    }
    return { companyId, company };
  }

  private ensureEnabled() {
    if (this.config.get<string>('BPS_ENABLED') !== 'true') {
      throw new ServiceUnavailableException('La conexión con BPS no está habilitada en el servidor (falta BPS_ENABLED=true)');
    }
  }

  private cryptoKey(): Buffer {
    try {
      return loadBpsKey(this.config.get<string>('BPS_ENCRYPTION_KEY'));
    } catch (e: any) {
      this.logger.error(`Clave de cifrado BPS inválida: ${e.message}`);
      throw new ServiceUnavailableException('El servidor no tiene configurada la clave de cifrado de credenciales BPS');
    }
  }

  private mapBpsError(e: any): never {
    if (e instanceof BpsCaptchaError) throw new ServiceUnavailableException(e.message);
    if (e instanceof BpsLoginError) throw new BadRequestException(e.message);
    if (e instanceof BpsUnavailableError) throw new ServiceUnavailableException(e.message);
    throw e;
  }

  // ======================== CONSULTA PÚBLICA ===========================

  async consultarCertificado(user: any, dto: ConsultarCertificadoDto) {
    const { companyId } = await this.resolveBpsContext(user);
    if (!validarRut(dto.rut)) throw new BadRequestException('El dígito verificador del RUT no es válido');
    this.ensureEnabled();

    let resultado;
    try {
      resultado = await this.client.consultarVigencia(dto.rut);
    } catch (e) {
      this.mapBpsError(e);
    }

    const consultadoEn = new Date();
    // Si el RUT está monitoreado por esta empresa, registrar la consulta
    const empresa = await this.prisma.bpsEmpresaMonitoreada.findFirst({
      where: { companyId, rut: dto.rut, active: true },
    });
    if (empresa) {
      await this.registrarConsulta(empresa, resultado);
    }

    return {
      rut: dto.rut,
      razonSocial: resultado.razonSocial,
      estado: resultado.estado,
      vigenteHasta: resultado.vigenteHasta || null,
      consultadoEn,
      fuente: 'BPS consulta pública',
    };
  }

  /** Persiste una consulta de vigencia y notifica si el estado empeoró. */
  async registrarConsulta(empresa: any, resultado: { estado: string; vigenteHasta?: Date; rawExtracto?: string }) {
    await this.prisma.bpsConsulta.create({
      data: {
        empresaId: empresa.id,
        estado: resultado.estado,
        vigenteHasta: resultado.vigenteHasta || null,
        raw: resultado.rawExtracto ? { extracto: resultado.rawExtracto.slice(0, 500) } : undefined,
      },
    });
    await this.prisma.bpsEmpresaMonitoreada.update({
      where: { id: empresa.id },
      data: { estado: resultado.estado, vigenteHasta: resultado.vigenteHasta || null, ultimaConsulta: new Date() },
    });

    if (resultado.estado === 'NO_VIGENTE' && empresa.estado !== 'NO_VIGENTE') {
      const cfg = await this.prisma.bpsConfig.findUnique({ where: { companyId: empresa.companyId } });
      if (cfg?.alertasActivas !== false) {
        this.notifications.notifyCompany(
          empresa.companyId,
          NotificationType.bps_certificado,
          'Certificado BPS no vigente',
          `${empresa.nombre || `RUT ${empresa.rut}`} ya no tiene certificado común vigente en BPS`,
        ).catch((e) => this.logger.error(`Notificación BPS falló: ${e.message}`));
      }
    }
  }

  // ======================== MONITOREO ==================================

  async listEmpresas(user: any) {
    const { companyId } = await this.resolveBpsContext(user);
    const empresas = await this.prisma.bpsEmpresaMonitoreada.findMany({
      where: { companyId, active: true },
      orderBy: { createdAt: 'desc' },
    });
    return empresas.map((e) => ({
      id: e.id,
      rut: e.rut,
      nombre: e.nombre,
      estado: e.estado,
      vigenteHasta: e.vigenteHasta,
      ultimaConsulta: e.ultimaConsulta,
    }));
  }

  async monitorearEmpresa(user: any, dto: MonitorearEmpresaDto) {
    const { companyId } = await this.resolveBpsContext(user);
    if (!validarRut(dto.rut)) throw new BadRequestException('El dígito verificador del RUT no es válido');
    return this.prisma.bpsEmpresaMonitoreada.upsert({
      where: { companyId_rut: { companyId, rut: dto.rut } },
      create: { companyId, rut: dto.rut, nombre: dto.nombre, linkedCompanyId: dto.linkedCompanyId },
      update: { active: true, nombre: dto.nombre || undefined, linkedCompanyId: dto.linkedCompanyId || undefined },
    });
  }

  async quitarEmpresa(user: any, id: string) {
    const { companyId } = await this.resolveBpsContext(user);
    const empresa = await this.prisma.bpsEmpresaMonitoreada.findFirst({ where: { id, companyId, active: true } });
    if (!empresa) throw new NotFoundException('Empresa monitoreada no encontrada');
    return this.prisma.bpsEmpresaMonitoreada.update({ where: { id }, data: { active: false } });
  }

  async historial(user: any, id: string) {
    const { companyId } = await this.resolveBpsContext(user);
    const empresa = await this.prisma.bpsEmpresaMonitoreada.findFirst({ where: { id, companyId } });
    if (!empresa) throw new NotFoundException('Empresa monitoreada no encontrada');
    return this.prisma.bpsConsulta.findMany({
      where: { empresaId: id },
      orderBy: { consultadoEn: 'desc' },
      take: 100,
      select: { estado: true, vigenteHasta: true, consultadoEn: true },
    });
  }

  async getConfig(user: any) {
    const { companyId } = await this.resolveBpsContext(user);
    const cfg = await this.prisma.bpsConfig.findUnique({ where: { companyId } });
    return cfg || { companyId, frecuencia: 'diaria', alertasActivas: true, notificarDiasAntes: 7 };
  }

  async updateConfig(user: any, dto: UpdateBpsConfigDto) {
    const { companyId } = await this.resolveBpsContext(user);
    return this.prisma.bpsConfig.upsert({
      where: { companyId },
      create: { companyId, ...dto },
      update: { ...dto },
    });
  }

  // ======================== CUENTA AUTENTICADA =========================

  private maskUsuario(usuario: string) {
    if (!usuario) return '';
    return usuario.length <= 3 ? `${usuario[0]}•••` : `${usuario.slice(0, 2)}•••${usuario.slice(-1)}`;
  }

  private cuentaView(cuenta: any) {
    if (!cuenta || !cuenta.active) return { conectada: false };
    return {
      conectada: true,
      usuario: this.maskUsuario(cuenta.usuario),
      ultimaSync: cuenta.ultimaSync,
      ultimoError: cuenta.ultimoError,
    };
  }

  async getCuenta(user: any) {
    const { companyId } = await this.resolveBpsContext(user);
    const cuenta = await this.prisma.bpsCuenta.findUnique({ where: { companyId } });
    return this.cuentaView(cuenta);
  }

  async conectarCuenta(user: any, dto: ConectarCuentaDto) {
    const { companyId } = await this.resolveBpsContext(user);
    this.ensureEnabled();
    const key = this.cryptoKey();

    // Validar credenciales en vivo ANTES de persistir
    try {
      await this.client.login(dto.usuario, dto.password);
    } catch (e) {
      this.mapBpsError(e);
    }

    const cuenta = await this.prisma.bpsCuenta.upsert({
      where: { companyId },
      create: { companyId, usuario: dto.usuario, credencialCifrada: encryptSecret(dto.password, key) },
      update: { usuario: dto.usuario, credencialCifrada: encryptSecret(dto.password, key), active: true, ultimoError: null },
    });
    return this.cuentaView(cuenta);
  }

  async desconectarCuenta(user: any) {
    const { companyId } = await this.resolveBpsContext(user);
    // Borrado físico: elimina la credencial cifrada y sus datos asociados
    await this.prisma.bpsCuenta.deleteMany({ where: { companyId } });
    return { conectada: false };
  }

  async getDatosCuenta(user: any) {
    const { companyId } = await this.resolveBpsContext(user);
    const cuenta = await this.prisma.bpsCuenta.findUnique({ where: { companyId } });
    if (!cuenta || !cuenta.active) return { conectada: false, datos: [] };
    const datos = await Promise.all(TIPOS_DATO.map((tipo) =>
      this.prisma.bpsDatoCuenta.findFirst({
        where: { cuentaId: cuenta.id, tipo },
        orderBy: { obtenidoEn: 'desc' },
        select: { tipo: true, estado: true, resumen: true, detalle: true, obtenidoEn: true },
      }),
    ));
    return { ...this.cuentaView(cuenta), datos: datos.filter(Boolean) };
  }

  async sincronizarCuenta(user: any) {
    const { companyId } = await this.resolveBpsContext(user);
    this.ensureEnabled();
    const cuenta = await this.prisma.bpsCuenta.findUnique({ where: { companyId } });
    if (!cuenta || !cuenta.active) throw new NotFoundException('No hay cuenta BPS conectada para esta empresa');
    try {
      await this.syncCuenta(cuenta, { notificar: false });
    } catch (e) {
      this.mapBpsError(e);
    }
    return this.getDatosCuenta(user);
  }

  /**
   * Ejecuta las consultas autenticadas de una cuenta y persiste resultados.
   * Usado por la sincronización manual y por el job automático.
   */
  async syncCuenta(cuenta: any, opts: { notificar: boolean }) {
    const key = this.cryptoKey();
    let password: string;
    try {
      password = decryptSecret(cuenta.credencialCifrada, key);
    } catch {
      await this.prisma.bpsCuenta.update({
        where: { id: cuenta.id },
        data: { ultimoError: 'Credencial ilegible (cambió la clave de cifrado) — reconectar la cuenta' },
      });
      throw new BpsLoginError('La credencial guardada no se puede descifrar — reconectá la cuenta BPS');
    }

    try {
      const sesion = await this.client.login(cuenta.usuario, password);
      const resultados: Array<{ tipo: TipoDato; dato: any }> = [
        { tipo: 'OBSERVACIONES', dato: await this.client.obtenerObservaciones(sesion) },
        { tipo: 'OBLIGACIONES', dato: await this.client.obtenerObligaciones(sesion) },
        { tipo: 'NOMINA', dato: await this.client.obtenerNomina(sesion) },
      ];

      for (const { tipo, dato } of resultados) {
        const anterior = await this.prisma.bpsDatoCuenta.findFirst({
          where: { cuentaId: cuenta.id, tipo },
          orderBy: { obtenidoEn: 'desc' },
        });
        await this.prisma.bpsDatoCuenta.create({
          data: { cuentaId: cuenta.id, tipo, estado: dato.estado, resumen: dato.resumen?.slice(0, 500), detalle: dato.detalle },
        });
        if (opts.notificar && dato.estado === 'ATENCION' && anterior?.estado !== 'ATENCION') {
          const cfg = await this.prisma.bpsConfig.findUnique({ where: { companyId: cuenta.companyId } });
          if (cfg?.alertasActivas !== false) {
            this.notifications.notifyCompany(
              cuenta.companyId,
              NotificationType.bps_cuenta,
              `BPS: ${tipo === 'OBSERVACIONES' ? 'observaciones pendientes' : tipo === 'OBLIGACIONES' ? 'obligaciones pendientes' : 'nómina observada'}`,
              dato.resumen || 'Revisá el detalle en Tolvink o en el portal BPS',
            ).catch((e) => this.logger.error(`Notificación BPS falló: ${e.message}`));
          }
        }
      }

      // Retención: datos autenticados más viejos que 90 días
      await this.prisma.bpsDatoCuenta.deleteMany({
        where: { cuentaId: cuenta.id, obtenidoEn: { lt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } },
      });
      await this.prisma.bpsCuenta.update({
        where: { id: cuenta.id },
        data: { ultimaSync: new Date(), ultimoError: null },
      });
    } catch (e: any) {
      await this.prisma.bpsCuenta.update({
        where: { id: cuenta.id },
        data: { ultimoError: (e.message || 'Error desconocido').slice(0, 500) },
      }).catch(() => {});
      if (opts.notificar && e instanceof BpsLoginError) {
        this.notifications.notifyCompany(
          cuenta.companyId,
          NotificationType.bps_cuenta,
          'BPS: fallo de acceso',
          'La sincronización automática con BPS no pudo iniciar sesión. Verificá las credenciales en Tolvink.',
        ).catch(() => {});
      }
      throw e;
    }
  }
}
