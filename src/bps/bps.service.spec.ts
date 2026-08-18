import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { BpsService, validarRut } from './bps.service';
import { BpsClient, BpsLoginError } from './bps-client';
import { PrismaService } from '../database/prisma.service';
import { CompanyResolutionService } from '../common/services/company-resolution.service';
import { NotificationService } from '../notifications/notification.service';

// Mock @prisma/client enums + PrismaClient base class
jest.mock('@prisma/client', () => ({
  PrismaClient: class PrismaClient {},
  Prisma: { DbNull: 'DbNull' },
  NotificationType: {
    bps_certificado: 'bps_certificado',
    bps_cuenta: 'bps_cuenta',
  },
}));

// RUT con dígito verificador válido (módulo 11)
const RUT_VALIDO = '211234567897';
const RUT_INVALIDO = '211234567890';

describe('BpsService', () => {
  let service: BpsService;

  const user = { sub: 'user-1', activeCompanyId: 'comp-1', companyId: 'comp-1', role: 'gerente' };
  const intruso = { sub: 'user-2', activeCompanyId: 'comp-1', companyId: 'comp-1', role: 'gerente' };

  const mockPrisma: any = {
    company: { findUnique: jest.fn() },
    bpsToken: { findUnique: jest.fn(), upsert: jest.fn(), updateMany: jest.fn() },
    bpsEmpresaMonitoreada: { findFirst: jest.fn(), findMany: jest.fn(), upsert: jest.fn(), update: jest.fn() },
    bpsConsulta: { create: jest.fn(), findMany: jest.fn() },
    bpsConfig: { findUnique: jest.fn(), upsert: jest.fn() },
    bpsCuenta: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn(), deleteMany: jest.fn() },
    bpsDatoCuenta: { findFirst: jest.fn(), create: jest.fn(), deleteMany: jest.fn() },
  };
  const mockCompanyRes: any = { resolveAllCompanyIds: jest.fn() };
  const mockClient: any = {
    login: jest.fn(),
    consultarVigencia: jest.fn(),
    obtenerObservaciones: jest.fn(),
    obtenerObligaciones: jest.fn(),
    obtenerNomina: jest.fn(),
  };
  const mockNotifications: any = { notifyCompany: jest.fn().mockResolvedValue(undefined) };
  const envValues: Record<string, string> = {
    BPS_ENABLED: 'true',
    BPS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  };
  const mockConfig: any = { get: jest.fn((k: string) => envValues[k]) };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.company.findUnique.mockResolvedValue({ id: 'comp-1', name: 'Planta Uno', active: true });
    mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-1']);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BpsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CompanyResolutionService, useValue: mockCompanyRes },
        { provide: ConfigService, useValue: mockConfig },
        { provide: BpsClient, useValue: mockClient },
        { provide: NotificationService, useValue: mockNotifications },
      ],
    }).compile();

    service = module.get(BpsService);
  });

  describe('validarRut', () => {
    it('acepta RUT con dígito verificador válido', () => {
      expect(validarRut(RUT_VALIDO)).toBe(true);
    });
    it('rechaza dígito verificador inválido y largos incorrectos', () => {
      expect(validarRut(RUT_INVALIDO)).toBe(false);
      expect(validarRut('123')).toBe(false);
      expect(validarRut('')).toBe(false);
    });
  });

  describe('scoping por empresa', () => {
    it('rechaza usuario sin membresía en la empresa activa', async () => {
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['otra-empresa']);
      await expect(service.listEmpresas(intruso)).rejects.toThrow(ForbiddenException);
    });

    it('quitarEmpresa no encuentra registros de otra empresa', async () => {
      mockPrisma.bpsEmpresaMonitoreada.findFirst.mockResolvedValue(null);
      await expect(service.quitarEmpresa(user, 'emp-de-otro')).rejects.toThrow(NotFoundException);
      expect(mockPrisma.bpsEmpresaMonitoreada.findFirst).toHaveBeenCalledWith({
        where: { id: 'emp-de-otro', companyId: 'comp-1', active: true },
      });
    });
  });

  describe('consultarCertificado', () => {
    it('rechaza RUT con dígito verificador inválido sin llamar a BPS', async () => {
      await expect(service.consultarCertificado(user, { rut: RUT_INVALIDO })).rejects.toThrow(BadRequestException);
      expect(mockClient.consultarVigencia).not.toHaveBeenCalled();
    });

    it('rechaza cuando BPS_ENABLED no es true', async () => {
      const orig = envValues.BPS_ENABLED;
      envValues.BPS_ENABLED = 'false';
      await expect(service.consultarCertificado(user, { rut: RUT_VALIDO })).rejects.toThrow(ServiceUnavailableException);
      envValues.BPS_ENABLED = orig;
    });

    it('devuelve el resultado y registra la consulta si el RUT está monitoreado', async () => {
      mockClient.consultarVigencia.mockResolvedValue({ estado: 'VIGENTE', rawExtracto: 'ok' });
      mockPrisma.bpsEmpresaMonitoreada.findFirst.mockResolvedValue({ id: 'emp-1', companyId: 'comp-1', rut: RUT_VALIDO, estado: 'DESCONOCIDO' });
      const r = await service.consultarCertificado(user, { rut: RUT_VALIDO });
      expect(r.estado).toBe('VIGENTE');
      expect(mockPrisma.bpsConsulta.create).toHaveBeenCalled();
      expect(mockPrisma.bpsEmpresaMonitoreada.update).toHaveBeenCalled();
    });
  });

  describe('registrarConsulta', () => {
    it('notifica a la empresa cuando el estado pasa a NO_VIGENTE', async () => {
      mockPrisma.bpsConfig.findUnique.mockResolvedValue({ alertasActivas: true });
      await service.registrarConsulta(
        { id: 'emp-1', companyId: 'comp-1', rut: RUT_VALIDO, nombre: 'Transportes X', estado: 'VIGENTE' },
        { estado: 'NO_VIGENTE' },
      );
      expect(mockNotifications.notifyCompany).toHaveBeenCalledWith(
        'comp-1', 'bps_certificado', expect.any(String), expect.stringContaining('Transportes X'),
      );
    });

    it('no notifica si el estado no cambió', async () => {
      await service.registrarConsulta(
        { id: 'emp-1', companyId: 'comp-1', rut: RUT_VALIDO, estado: 'NO_VIGENTE' },
        { estado: 'NO_VIGENTE' },
      );
      expect(mockNotifications.notifyCompany).not.toHaveBeenCalled();
    });
  });

  describe('cuenta autenticada', () => {
    it('getCuenta enmascara el usuario y nunca expone la credencial', async () => {
      mockPrisma.bpsCuenta.findUnique.mockResolvedValue({
        companyId: 'comp-1', usuario: 'empresa123', credencialCifrada: 'iv.tag.enc', active: true, ultimaSync: null, ultimoError: null,
      });
      const r: any = await service.getCuenta(user);
      expect(r.conectada).toBe(true);
      expect(r.usuario).toBe('em•••3');
      expect(r.usuario).not.toContain('empresa123');
      expect(JSON.stringify(r)).not.toContain('iv.tag.enc');
    });

    it('getCuenta sin cuenta → conectada false', async () => {
      mockPrisma.bpsCuenta.findUnique.mockResolvedValue(null);
      expect(await service.getCuenta(user)).toEqual({ conectada: false });
    });

    it('conectarCuenta no persiste si el login BPS falla', async () => {
      mockClient.login.mockRejectedValue(new BpsLoginError('BPS rechazó el usuario o la contraseña'));
      await expect(service.conectarCuenta(user, { usuario: 'u', password: 'p' })).rejects.toThrow(BadRequestException);
      expect(mockPrisma.bpsCuenta.upsert).not.toHaveBeenCalled();
    });

    it('conectarCuenta guarda la credencial cifrada (no en texto plano)', async () => {
      mockClient.login.mockResolvedValue({ cookies: 'JSESSIONID=abc' });
      mockPrisma.bpsCuenta.upsert.mockImplementation(({ create }: any) => Promise.resolve({ ...create, active: true }));
      const r: any = await service.conectarCuenta(user, { usuario: 'empresa123', password: 'super-secreta' });
      expect(r.conectada).toBe(true);
      const args = mockPrisma.bpsCuenta.upsert.mock.calls[0][0];
      expect(args.create.credencialCifrada).not.toContain('super-secreta');
      expect(args.create.credencialCifrada.split('.')).toHaveLength(3);
    });

    it('sincronizarCuenta sin cuenta conectada → NotFound', async () => {
      mockPrisma.bpsCuenta.findUnique.mockResolvedValue(null);
      await expect(service.sincronizarCuenta(user)).rejects.toThrow(NotFoundException);
    });
  });

  describe('token de integración (Excel)', () => {
    it('crearToken devuelve el valor en claro pero persiste solo el hash', async () => {
      mockPrisma.bpsToken.upsert.mockResolvedValue({});
      const { token } = await service.crearToken(user);
      expect(token).toMatch(/^bps_[a-f0-9]{48}$/);
      const args = mockPrisma.bpsToken.upsert.mock.calls[0][0];
      expect(args.create.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(args)).not.toContain(token);
    });

    it('resolveToken acepta un token válido y devuelve su companyId', async () => {
      mockPrisma.bpsToken.upsert.mockResolvedValue({});
      const { token } = await service.crearToken(user);
      const hash = mockPrisma.bpsToken.upsert.mock.calls[0][0].create.tokenHash;
      mockPrisma.bpsToken.findUnique.mockImplementation(({ where }: any) =>
        Promise.resolve(where.tokenHash === hash ? { companyId: 'comp-1', active: true } : null));
      expect(await service.resolveToken(token)).toBe('comp-1');
    });

    it('resolveToken rechaza tokens inválidos, revocados o con formato incorrecto', async () => {
      await expect(service.resolveToken(undefined)).rejects.toThrow(ForbiddenException);
      await expect(service.resolveToken('cualquier-cosa')).rejects.toThrow(ForbiddenException);
      mockPrisma.bpsToken.findUnique.mockResolvedValue({ companyId: 'comp-1', active: false });
      await expect(service.resolveToken(`bps_${'a'.repeat(48)}`)).rejects.toThrow(ForbiddenException);
    });

    it('getTokenInfo nunca devuelve el hash', async () => {
      mockPrisma.bpsToken.findUnique.mockResolvedValue({ companyId: 'comp-1', tokenHash: 'h'.repeat(64), active: true, createdAt: new Date() });
      const info = await service.getTokenInfo(user);
      expect(info.existe).toBe(true);
      expect(JSON.stringify(info)).not.toContain('h'.repeat(64));
    });
  });

  describe('endpoints Excel', () => {
    it('excelVigencia sirve el snapshot fresco sin llamar a BPS', async () => {
      mockPrisma.bpsEmpresaMonitoreada.findFirst.mockResolvedValue({
        estado: 'VIGENTE', ultimaConsulta: new Date(Date.now() - 60_000),
      });
      expect(await service.excelVigencia('comp-1', RUT_VALIDO)).toBe('VIGENTE');
      expect(mockClient.consultarVigencia).not.toHaveBeenCalled();
    });

    it('excelVigencia re-consulta en vivo si el snapshot está vencido', async () => {
      mockPrisma.bpsEmpresaMonitoreada.findFirst.mockResolvedValue({
        id: 'emp-1', companyId: 'comp-1', estado: 'VIGENTE', ultimaConsulta: new Date(Date.now() - 24 * 60 * 60 * 1000),
      });
      mockClient.consultarVigencia.mockResolvedValue({ estado: 'NO_VIGENTE' });
      expect(await service.excelVigencia('comp-1', RUT_VALIDO)).toBe('NO_VIGENTE');
    });

    it('excelVigencia degrada a texto, nunca lanza', async () => {
      expect(await service.excelVigencia('comp-1', '123')).toBe('RUT_INVALIDO');
      mockPrisma.bpsEmpresaMonitoreada.findFirst.mockResolvedValue(null);
      mockClient.consultarVigencia.mockRejectedValue(new Error('BPS caído'));
      expect(await service.excelVigencia('comp-1', RUT_VALIDO)).toBe('DESCONOCIDO');
    });
  });
});
