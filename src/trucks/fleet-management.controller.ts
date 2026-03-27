// =====================================================================
// TOLVINK — Fleet Management Controller + Service
// CRUD for truck incomes, expenses, movements, documents, economic summary
// =====================================================================

import {
  Controller, Get, Post, Patch, Param, Body, Query,
  UseGuards, ParseUUIDPipe, Injectable, BadRequestException,
  NotFoundException, ForbiddenException, Logger,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { PrismaService } from '../database/prisma.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { OcrService } from '../ocr/ocr.service';

// ======================== SERVICE ====================================

@Injectable()
export class FleetManagementService {
  private readonly logger = new Logger(FleetManagementService.name);

  constructor(private prisma: PrismaService, private ocr: OcrService) {}

  /** Verify truck belongs to user's company (own or linked) */
  private async assertTruckAccess(truckId: string, user: any): Promise<any> {
    const cid = user.activeCompanyId || user.companyId;
    const truck = await this.prisma.truck.findFirst({
      where: {
        id: truckId, active: true,
        OR: [{ companyId: cid }, { ownerCompanyId: cid }],
      },
    });
    if (!truck && user.role !== 'platform_admin') {
      // Try CompanyAccess fallback (plant viewing linked transporter truck)
      const anyTruck = await this.prisma.truck.findUnique({ where: { id: truckId } });
      if (!anyTruck) throw new NotFoundException('Camión no encontrado');
      const access = await this.prisma.companyAccess.findFirst({
        where: { grantorCompanyId: cid, granteeCompanyId: anyTruck.companyId, isActive: true },
      });
      if (!access) throw new ForbiddenException('Sin acceso a este camión');
      return anyTruck;
    }
    if (!truck) {
      const t = await this.prisma.truck.findUnique({ where: { id: truckId } });
      if (!t) throw new NotFoundException('Camión no encontrado');
      return t;
    }
    return truck;
  }

  // ======================== TRUCK DETAIL ================================

  async getDetail(truckId: string, user: any) {
    const truck = await this.assertTruckAccess(truckId, user);
    const cid = user.activeCompanyId || user.companyId;
    const isOwn = truck.companyId === cid || truck.ownerCompanyId === cid;

    // Active freights
    const activeAssignments = await this.prisma.freightAssignment.findMany({
      where: { truckId, status: { in: ['active', 'accepted'] }, freight: { status: { notIn: ['finished', 'canceled'] } } },
      include: {
        freight: { select: { id: true, code: true, status: true, originName: true, destName: true } },
        driver: { select: { id: true, name: true } },
      },
    });

    // Docs summary
    const docs = await this.prisma.truckDocument.findMany({
      where: { truckId },
      select: { id: true, type: true, expiresAt: true },
    });
    const now = new Date();
    const soon = new Date(now.getTime() + 30 * 86400000);
    const docsSummary = {
      total: docs.length,
      expired: docs.filter(d => d.expiresAt && new Date(d.expiresAt) < now).length,
      expiring_soon: docs.filter(d => d.expiresAt && new Date(d.expiresAt) >= now && new Date(d.expiresAt) <= soon).length,
    };

    const assignedUser = truck.assignedUserId
      ? await this.prisma.user.findUnique({ where: { id: truck.assignedUserId }, select: { id: true, name: true, phone: true } })
      : null;

    return {
      ...truck, isOwn, assignedUser, docsSummary,
      activeFreights: activeAssignments.map(a => ({
        id: a.freight.id, code: a.freight.code, status: a.freight.status,
        tripStatus: a.tripStatus, originName: a.freight.originName, destName: a.freight.destName,
        driverName: a.driver?.name,
      })),
    };
  }

  // ======================== INCOMES ====================================

  async listIncomes(truckId: string, user: any, from?: string, to?: string, status?: string) {
    await this.assertTruckAccess(truckId, user);
    const where: any = { truckId, active: { not: false } };
    if (from) where.date = { ...(where.date || {}), gte: new Date(from) };
    if (to) where.date = { ...(where.date || {}), lte: new Date(to) };
    if (status) where.status = status;
    return this.prisma.truckIncome.findMany({
      where, orderBy: { date: 'desc' },
      include: {
        freight: { select: { id: true, code: true, originName: true, destName: true, status: true } },
      },
    });
  }

  async addIncome(truckId: string, body: any, user: any) {
    const truck = await this.assertTruckAccess(truckId, user);
    if (!body.concept?.trim()) throw new BadRequestException('Concepto obligatorio');
    if (!body.amount) throw new BadRequestException('Monto obligatorio');
    if (!body.date) throw new BadRequestException('Fecha obligatoria');
    return this.prisma.truckIncome.create({
      data: {
        truckId, companyId: truck.companyId,
        concept: body.concept.trim(),
        amount: body.amount,
        currency: body.currency || 'UYU',
        exchangeRate: body.exchangeRate ?? 40,
        date: new Date(body.date),
        status: body.status || 'PENDING',
        freightId: body.freightId || null,
        invoiceNumber: body.invoiceNumber || null,
        invoiceUrl: body.invoiceUrl || null,
        notes: body.notes || null,
        createdById: user.sub,
      },
    });
  }

  async updateIncome(truckId: string, incId: string, body: any, user: any) {
    await this.assertTruckAccess(truckId, user);
    const inc = await this.prisma.truckIncome.findFirst({ where: { id: incId, truckId, active: { not: false } } });
    if (!inc) throw new NotFoundException('Ingreso no encontrado');
    const data: any = {};
    if (body.concept !== undefined) data.concept = body.concept;
    if (body.amount !== undefined) data.amount = body.amount;
    if (body.currency !== undefined) data.currency = body.currency;
    if (body.exchangeRate !== undefined) data.exchangeRate = body.exchangeRate;
    if (body.date !== undefined) data.date = new Date(body.date);
    if (body.status !== undefined) data.status = body.status;
    if (body.freightId !== undefined) data.freightId = body.freightId || null;
    if (body.invoiceNumber !== undefined) data.invoiceNumber = body.invoiceNumber || null;
    if (body.invoiceUrl !== undefined) data.invoiceUrl = body.invoiceUrl || null;
    if (body.notes !== undefined) data.notes = body.notes || null;
    return this.prisma.truckIncome.update({ where: { id: incId }, data });
  }

  async deleteIncome(truckId: string, incId: string, user: any) {
    await this.assertTruckAccess(truckId, user);
    const inc = await this.prisma.truckIncome.findFirst({ where: { id: incId, truckId, active: { not: false } } });
    if (!inc) throw new NotFoundException('Ingreso no encontrado');
    return this.prisma.truckIncome.update({ where: { id: incId }, data: { active: false } });
  }

  // ======================== EXPENSES ===================================

  async listExpenses(truckId: string, user: any, from?: string, to?: string) {
    await this.assertTruckAccess(truckId, user);
    const where: any = { truckId, active: { not: false } };
    if (from) where.date = { ...(where.date || {}), gte: new Date(from) };
    if (to) where.date = { ...(where.date || {}), lte: new Date(to) };
    return this.prisma.truckExpense.findMany({
      where, orderBy: { date: 'desc' },
      include: {
        freight: { select: { id: true, code: true, originName: true, destName: true, status: true } },
      },
    });
  }

  async addExpense(truckId: string, body: any, user: any) {
    const truck = await this.assertTruckAccess(truckId, user);
    if (!body.amount) throw new BadRequestException('Monto obligatorio');
    if (!body.date) throw new BadRequestException('Fecha obligatoria');
    return this.prisma.truckExpense.create({
      data: {
        truckId, companyId: truck.companyId,
        type: body.type || 'OTHER',
        amount: body.amount,
        currency: body.currency || 'UYU',
        exchangeRate: body.exchangeRate ?? 40,
        date: new Date(body.date),
        description: body.description || null,
        freightId: body.freightId || null,
        receiptUrl: body.receiptUrl || null,
        receiptName: body.receiptName || null,
        createdById: user.sub,
      },
    });
  }

  async updateExpense(truckId: string, expId: string, body: any, user: any) {
    await this.assertTruckAccess(truckId, user);
    const exp = await this.prisma.truckExpense.findFirst({ where: { id: expId, truckId, active: { not: false } } });
    if (!exp) throw new NotFoundException('Gasto no encontrado');
    const data: any = {};
    if (body.type !== undefined) data.type = body.type;
    if (body.amount !== undefined) data.amount = body.amount;
    if (body.currency !== undefined) data.currency = body.currency;
    if (body.exchangeRate !== undefined) data.exchangeRate = body.exchangeRate;
    if (body.date !== undefined) data.date = new Date(body.date);
    if (body.description !== undefined) data.description = body.description || null;
    if (body.freightId !== undefined) data.freightId = body.freightId || null;
    if (body.receiptUrl !== undefined) data.receiptUrl = body.receiptUrl || null;
    if (body.receiptName !== undefined) data.receiptName = body.receiptName || null;
    return this.prisma.truckExpense.update({ where: { id: expId }, data });
  }

  async deleteExpense(truckId: string, expId: string, user: any) {
    await this.assertTruckAccess(truckId, user);
    const exp = await this.prisma.truckExpense.findFirst({ where: { id: expId, truckId, active: { not: false } } });
    if (!exp) throw new NotFoundException('Gasto no encontrado');
    return this.prisma.truckExpense.update({ where: { id: expId }, data: { active: false } });
  }

  async getExpenseSummary(truckId: string, user: any) {
    await this.assertTruckAccess(truckId, user);
    const expenses = await this.prisma.truckExpense.findMany({
      where: { truckId, active: { not: false } },
      select: { type: true, amount: true, currency: true, exchangeRate: true },
    });
    const byType: Record<string, number> = {};
    let total = 0;
    for (const e of expenses) {
      const amtUYU = e.currency === 'USD' ? Number(e.amount) * Number(e.exchangeRate) : Number(e.amount);
      byType[e.type] = (byType[e.type] || 0) + amtUYU;
      total += amtUYU;
    }
    return {
      total,
      byType: Object.entries(byType).map(([type, tot]) => ({ type, total: tot })),
    };
  }

  // ======================== MOVEMENTS ==================================

  async listMovements(truckId: string, user: any, from?: string, to?: string, type?: string) {
    await this.assertTruckAccess(truckId, user);
    const where: any = { truckId, active: { not: false } };
    if (from) where.departureAt = { ...(where.departureAt || {}), gte: new Date(from) };
    if (to) where.departureAt = { ...(where.departureAt || {}), lte: new Date(to) };
    if (type) where.type = type;
    return this.prisma.truckMovement.findMany({ where, orderBy: { createdAt: 'desc' } });
  }

  async addMovement(truckId: string, body: any, user: any) {
    const truck = await this.assertTruckAccess(truckId, user);
    return this.prisma.truckMovement.create({
      data: {
        truckId, companyId: truck.companyId,
        type: body.type || 'OTHER',
        description: body.description || null,
        originName: body.originName || null,
        originFieldId: body.originFieldId || null,
        originLat: body.originLat ?? null,
        originLng: body.originLng ?? null,
        destName: body.destName || null,
        destFieldId: body.destFieldId || null,
        destLat: body.destLat ?? null,
        destLng: body.destLng ?? null,
        departureAt: body.departureAt ? new Date(body.departureAt) : null,
        arrivalAt: body.arrivalAt ? new Date(body.arrivalAt) : null,
        kmDriven: body.kmDriven ?? null,
        fuelLiters: body.fuelLiters ?? null,
        fuelCost: body.fuelCost ?? null,
        tollCost: body.tollCost ?? null,
        notes: body.notes || null,
        createdById: user.sub,
      },
    });
  }

  async updateMovement(truckId: string, movId: string, body: any, user: any) {
    await this.assertTruckAccess(truckId, user);
    const mov = await this.prisma.truckMovement.findFirst({ where: { id: movId, truckId, active: { not: false } } });
    if (!mov) throw new NotFoundException('Movimiento no encontrado');
    const data: any = {};
    for (const k of ['type', 'description', 'originName', 'originFieldId', 'destName', 'destFieldId', 'notes']) {
      if (body[k] !== undefined) data[k] = body[k] || null;
    }
    for (const k of ['originLat', 'originLng', 'destLat', 'destLng', 'kmDriven', 'fuelLiters', 'fuelCost', 'tollCost']) {
      if (body[k] !== undefined) data[k] = body[k] ?? null;
    }
    if (body.departureAt !== undefined) data.departureAt = body.departureAt ? new Date(body.departureAt) : null;
    if (body.arrivalAt !== undefined) data.arrivalAt = body.arrivalAt ? new Date(body.arrivalAt) : null;
    return this.prisma.truckMovement.update({ where: { id: movId }, data });
  }

  async deleteMovement(truckId: string, movId: string, user: any) {
    await this.assertTruckAccess(truckId, user);
    const mov = await this.prisma.truckMovement.findFirst({ where: { id: movId, truckId, active: { not: false } } });
    if (!mov) throw new NotFoundException('Movimiento no encontrado');
    return this.prisma.truckMovement.update({ where: { id: movId }, data: { active: false } });
  }

  // ======================== DOCUMENTS ==================================

  async listDocuments(truckId: string, user: any) {
    await this.assertTruckAccess(truckId, user);
    return this.prisma.truckDocument.findMany({
      where: { truckId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async addDocument(truckId: string, body: any, user: any) {
    const truck = await this.assertTruckAccess(truckId, user);
    if (!body.fileUrl) throw new BadRequestException('fileUrl obligatorio');
    return this.prisma.truckDocument.create({
      data: {
        truckId, companyId: truck.companyId,
        type: body.type || 'OTHER',
        name: body.name || null,
        fileUrl: body.fileUrl,
        fileName: body.fileName || 'documento',
        mimeType: body.mimeType || null,
        issuedAt: body.issuedAt ? new Date(body.issuedAt) : null,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        notes: body.notes || null,
        expenseId: body.expenseId || null,
        incomeId: body.incomeId || null,
        freightId: body.freightId || null,
        movementId: body.movementId || null,
        uploadedById: user.sub,
      },
    });
  }

  async updateDocument(truckId: string, docId: string, body: any, user: any) {
    await this.assertTruckAccess(truckId, user);
    const doc = await this.prisma.truckDocument.findFirst({ where: { id: docId, truckId } });
    if (!doc) throw new NotFoundException('Documento no encontrado');
    const data: any = {};
    for (const k of ['type', 'name', 'fileUrl', 'fileName', 'mimeType', 'notes', 'expenseId', 'incomeId', 'freightId', 'movementId']) {
      if (body[k] !== undefined) data[k] = body[k] || null;
    }
    if (body.issuedAt !== undefined) data.issuedAt = body.issuedAt ? new Date(body.issuedAt) : null;
    if (body.expiresAt !== undefined) data.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    return this.prisma.truckDocument.update({ where: { id: docId }, data });
  }

  async deleteDocument(truckId: string, docId: string, user: any) {
    await this.assertTruckAccess(truckId, user);
    const doc = await this.prisma.truckDocument.findFirst({ where: { id: docId, truckId } });
    if (!doc) throw new NotFoundException('Documento no encontrado');
    return this.prisma.truckDocument.delete({ where: { id: docId } });
  }

  // ======================== DOC OCR ====================================

  async processDocOcr(truckId: string, docId: string, user: any) {
    await this.assertTruckAccess(truckId, user);
    const doc = await this.prisma.truckDocument.findFirst({ where: { id: docId, truckId } });
    if (!doc) throw new NotFoundException('Documento no encontrado');
    await this.prisma.truckDocument.update({ where: { id: docId }, data: { ocrStatus: 'processing' } });
    // Fire-and-forget OCR
    this.ocr.analyzeFromUrl(doc.fileUrl, doc.type as any).then(async (result) => {
      await this.prisma.truckDocument.update({ where: { id: docId }, data: { ocrStatus: 'completed', ocrData: result as any } });
    }).catch(async (err) => {
      this.logger.error(`OCR failed for doc ${docId}: ${err.message}`);
      await this.prisma.truckDocument.update({ where: { id: docId }, data: { ocrStatus: 'failed' } });
    });
    return { ok: true, status: 'processing' };
  }

  async getDocOcr(truckId: string, docId: string, user: any) {
    await this.assertTruckAccess(truckId, user);
    const doc = await this.prisma.truckDocument.findFirst({
      where: { id: docId, truckId },
      select: { ocrStatus: true, ocrData: true },
    });
    if (!doc) throw new NotFoundException('Documento no encontrado');
    return doc;
  }

  async updateDocOcr(truckId: string, docId: string, ocrData: any, user: any) {
    await this.assertTruckAccess(truckId, user);
    const doc = await this.prisma.truckDocument.findFirst({ where: { id: docId, truckId } });
    if (!doc) throw new NotFoundException('Documento no encontrado');
    return this.prisma.truckDocument.update({ where: { id: docId }, data: { ocrData: ocrData as any } });
  }

  async clearDocOcr(truckId: string, docId: string, user: any) {
    await this.assertTruckAccess(truckId, user);
    const doc = await this.prisma.truckDocument.findFirst({ where: { id: docId, truckId } });
    if (!doc) throw new NotFoundException('Documento no encontrado');
    return this.prisma.truckDocument.update({ where: { id: docId }, data: { ocrStatus: null, ocrData: null } });
  }

  // ======================== FREIGHTS (history) =========================

  async listFreights(truckId: string, user: any, take = 20, skip = 0) {
    await this.assertTruckAccess(truckId, user);
    const assignments = await this.prisma.freightAssignment.findMany({
      where: { truckId },
      include: {
        freight: {
          select: {
            id: true, code: true, status: true, originName: true, destName: true,
            loadDate: true, finishedAt: true,
            items: { select: { grain: true, tons: true } },
          },
        },
        driver: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take, skip,
    });
    return assignments.map(a => ({
      freightId: a.freight.id,
      assignmentId: a.id,
      code: a.freight.code,
      status: a.freight.status,
      tripStatus: a.tripStatus,
      originName: a.freight.originName,
      destName: a.freight.destName,
      loadDate: a.freight.loadDate,
      finishedAt: a.freight.finishedAt,
      driverName: a.driver?.name,
      items: a.freight.items,
      tons: a.tons, loadedTons: a.loadedTons,
    }));
  }

  // ======================== TRIP DATA ==================================

  async updateTripData(freightId: string, assignmentId: string, body: any, user: any) {
    const assignment = await this.prisma.freightAssignment.findFirst({
      where: { id: assignmentId, freightId },
    });
    if (!assignment) throw new NotFoundException('Asignación no encontrada');
    if (assignment.truckId) await this.assertTruckAccess(assignment.truckId, user);
    const data: any = {};
    if (body.tons !== undefined) data.tons = body.tons;
    if (body.loadedTons !== undefined) data.loadedTons = body.loadedTons;
    return this.prisma.freightAssignment.update({ where: { id: assignmentId }, data });
  }

  // ======================== ECONOMIC SUMMARY ===========================

  async getEconomicSummary(truckId: string, user: any, from?: string, to?: string) {
    await this.assertTruckAccess(truckId, user);

    const dateFilter = (field: string) => {
      const f: any = {};
      if (from) f.gte = new Date(from);
      if (to) f.lte = new Date(to);
      return Object.keys(f).length > 0 ? { [field]: f } : {};
    };

    // Incomes
    const incomes = await this.prisma.truckIncome.findMany({
      where: { truckId, active: { not: false }, ...dateFilter('date') },
      select: { amount: true, currency: true, exchangeRate: true, status: true },
    });
    // Safe rate: fallback to 40 if null/undefined/0/NaN
    const safeRate = (rate: any) => { const r = Number(rate); return r > 0 ? r : 40; };
    // Convert to UYU: USD * rate, UYU stays as-is
    const toUYU = (amt: any, cur: string, rate: any) => cur === 'USD' ? Number(amt) * safeRate(rate) : Number(amt);
    // Convert to USD: UYU / rate, USD stays as-is
    const toUSD = (amt: any, cur: string, rate: any) => cur === 'UYU' ? Number(amt) / safeRate(rate) : Number(amt);

    // Collect average exchange rate from records that have one
    const allRates = [...incomes.map(i => Number(i.exchangeRate))];

    const sumByCur = (items: any[], statusFilter?: string) => {
      const filtered = statusFilter ? items.filter((i: any) => i.status === statusFilter) : items;
      return {
        uyu: filtered.reduce((s: number, i: any) => s + toUYU(i.amount, i.currency, i.exchangeRate), 0),
        usd: filtered.reduce((s: number, i: any) => s + toUSD(i.amount, i.currency, i.exchangeRate), 0),
      };
    };

    const incomePaid = sumByCur(incomes, 'PAID');
    const incomePending = sumByCur(incomes, 'PENDING');
    const incomeOverdue = sumByCur(incomes, 'OVERDUE');

    // Expenses
    const expenses = await this.prisma.truckExpense.findMany({
      where: { truckId, active: { not: false }, ...dateFilter('date') },
      select: { type: true, amount: true, currency: true, exchangeRate: true },
    });
    allRates.push(...expenses.map(e => Number(e.exchangeRate)));
    const avgRate = allRates.filter(r => r > 0).length > 0
      ? Math.round(allRates.filter(r => r > 0).reduce((s, r) => s + r, 0) / allRates.filter(r => r > 0).length * 100) / 100
      : 40;

    const byTypeUYU: Record<string, number> = {};
    const byTypeUSD: Record<string, number> = {};
    let expTotalUYU = 0;
    let expTotalUSD = 0;
    for (const e of expenses) {
      const vUYU = toUYU(e.amount, e.currency, e.exchangeRate);
      const vUSD = toUSD(e.amount, e.currency, e.exchangeRate);
      byTypeUYU[e.type] = (byTypeUYU[e.type] || 0) + vUYU;
      byTypeUSD[e.type] = (byTypeUSD[e.type] || 0) + vUSD;
      expTotalUYU += vUYU;
      expTotalUSD += vUSD;
    }

    // Freight stats from assignments
    const assignments = await this.prisma.freightAssignment.findMany({
      where: { truckId },
      select: { tripStatus: true, tons: true, loadedTons: true },
    });
    const tripsTotal = assignments.length;
    const tripsCompleted = assignments.filter(a => a.tripStatus === 'finished').length;

    // Movements km
    const movements = await this.prisma.truckMovement.findMany({
      where: { truckId, active: { not: false }, ...dateFilter('departureAt') },
      select: { kmDriven: true, fuelLiters: true },
    });
    const totalKm = movements.reduce((s, m) => s + (Number(m.kmDriven) || 0), 0);
    const totalFuel = movements.reduce((s, m) => s + (Number(m.fuelLiters) || 0), 0);

    return {
      exchangeRate: avgRate,
      income: {
        paid:    { uyu: incomePaid.uyu,    usd: incomePaid.usd },
        pending: { uyu: incomePending.uyu, usd: incomePending.usd },
        overdue: { uyu: incomeOverdue.uyu, usd: incomeOverdue.usd },
        total:   { uyu: incomePaid.uyu + incomePending.uyu + incomeOverdue.uyu, usd: incomePaid.usd + incomePending.usd + incomeOverdue.usd },
      },
      expenses: {
        total: { uyu: expTotalUYU, usd: expTotalUSD },
        byType: Object.keys(byTypeUYU).map(type => ({ type, uyu: byTypeUYU[type], usd: byTypeUSD[type] || 0 })),
      },
      net: { uyu: incomePaid.uyu - expTotalUYU, usd: incomePaid.usd - expTotalUSD },
      km: { total: totalKm },
      fuel: {
        total: totalFuel,
        kmPerLiter: totalFuel > 0 ? Math.round((totalKm / totalFuel) * 10) / 10 : null,
      },
      trips: { total: tripsTotal, completed: tripsCompleted },
      costPerKm:   { uyu: totalKm > 0 ? Math.round(expTotalUYU / totalKm) : null, usd: totalKm > 0 ? Math.round((expTotalUSD / totalKm) * 100) / 100 : null },
      incomePerKm: { uyu: totalKm > 0 ? Math.round(incomePaid.uyu / totalKm) : null, usd: totalKm > 0 ? Math.round((incomePaid.usd / totalKm) * 100) / 100 : null },
    };
  }
}

// ======================== CONTROLLER =================================

@ApiTags('Fleet Management')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('trucks')
export class FleetManagementController {
  constructor(private service: FleetManagementService) {}

  // Detail
  @Get(':id')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Detalle de camión' })
  getDetail(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.getDetail(id, user);
  }

  // Incomes
  @Get(':id/incomes')
  @Roles('transporter', 'producer', 'plant')
  listIncomes(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any,
    @Query('from') from?: string, @Query('to') to?: string, @Query('status') status?: string) {
    return this.service.listIncomes(id, user, from, to, status);
  }

  @Post(':id/incomes')
  @Roles('transporter', 'producer', 'plant')
  addIncome(@Param('id', ParseUUIDPipe) id: string, @Body() body: any, @CurrentUser() user: any) {
    return this.service.addIncome(id, body, user);
  }

  @Patch(':id/incomes/:incId')
  @Roles('transporter', 'producer', 'plant')
  updateIncome(@Param('id', ParseUUIDPipe) id: string, @Param('incId', ParseUUIDPipe) incId: string,
    @Body() body: any, @CurrentUser() user: any) {
    return this.service.updateIncome(id, incId, body, user);
  }

  @Patch(':id/incomes/:incId/delete')
  @Roles('transporter', 'producer', 'plant')
  deleteIncome(@Param('id', ParseUUIDPipe) id: string, @Param('incId', ParseUUIDPipe) incId: string,
    @CurrentUser() user: any) {
    return this.service.deleteIncome(id, incId, user);
  }

  // Expenses
  @Get(':id/expenses')
  @Roles('transporter', 'producer', 'plant')
  listExpenses(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any,
    @Query('from') from?: string, @Query('to') to?: string) {
    return this.service.listExpenses(id, user, from, to);
  }

  @Post(':id/expenses')
  @Roles('transporter', 'producer', 'plant')
  addExpense(@Param('id', ParseUUIDPipe) id: string, @Body() body: any, @CurrentUser() user: any) {
    return this.service.addExpense(id, body, user);
  }

  @Patch(':id/expenses/:expId')
  @Roles('transporter', 'producer', 'plant')
  updateExpense(@Param('id', ParseUUIDPipe) id: string, @Param('expId', ParseUUIDPipe) expId: string,
    @Body() body: any, @CurrentUser() user: any) {
    return this.service.updateExpense(id, expId, body, user);
  }

  @Patch(':id/expenses/:expId/delete')
  @Roles('transporter', 'producer', 'plant')
  deleteExpense(@Param('id', ParseUUIDPipe) id: string, @Param('expId', ParseUUIDPipe) expId: string,
    @CurrentUser() user: any) {
    return this.service.deleteExpense(id, expId, user);
  }

  @Get(':id/expenses/summary')
  @Roles('transporter', 'producer', 'plant')
  getExpenseSummary(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.getExpenseSummary(id, user);
  }

  // Movements
  @Get(':id/movements')
  @Roles('transporter', 'producer', 'plant')
  listMovements(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any,
    @Query('from') from?: string, @Query('to') to?: string, @Query('type') type?: string) {
    return this.service.listMovements(id, user, from, to, type);
  }

  @Post(':id/movements')
  @Roles('transporter', 'producer', 'plant')
  addMovement(@Param('id', ParseUUIDPipe) id: string, @Body() body: any, @CurrentUser() user: any) {
    return this.service.addMovement(id, body, user);
  }

  @Patch(':id/movements/:movId')
  @Roles('transporter', 'producer', 'plant')
  updateMovement(@Param('id', ParseUUIDPipe) id: string, @Param('movId', ParseUUIDPipe) movId: string,
    @Body() body: any, @CurrentUser() user: any) {
    return this.service.updateMovement(id, movId, body, user);
  }

  @Patch(':id/movements/:movId/delete')
  @Roles('transporter', 'producer', 'plant')
  deleteMovement(@Param('id', ParseUUIDPipe) id: string, @Param('movId', ParseUUIDPipe) movId: string,
    @CurrentUser() user: any) {
    return this.service.deleteMovement(id, movId, user);
  }

  // Documents
  @Get(':id/documents')
  @Roles('transporter', 'producer', 'plant')
  listDocuments(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.listDocuments(id, user);
  }

  @Post(':id/documents')
  @Roles('transporter', 'producer', 'plant')
  addDocument(@Param('id', ParseUUIDPipe) id: string, @Body() body: any, @CurrentUser() user: any) {
    return this.service.addDocument(id, body, user);
  }

  @Patch(':id/documents/:docId')
  @Roles('transporter', 'producer', 'plant')
  updateDocument(@Param('id', ParseUUIDPipe) id: string, @Param('docId', ParseUUIDPipe) docId: string,
    @Body() body: any, @CurrentUser() user: any) {
    return this.service.updateDocument(id, docId, body, user);
  }

  @Patch(':id/documents/:docId/delete')
  @Roles('transporter', 'producer', 'plant')
  deleteDocument(@Param('id', ParseUUIDPipe) id: string, @Param('docId', ParseUUIDPipe) docId: string,
    @CurrentUser() user: any) {
    return this.service.deleteDocument(id, docId, user);
  }

  // Doc OCR
  @Post(':id/documents/:docId/ocr')
  @Roles('transporter', 'producer', 'plant')
  processDocOcr(@Param('id', ParseUUIDPipe) id: string, @Param('docId', ParseUUIDPipe) docId: string,
    @CurrentUser() user: any) {
    return this.service.processDocOcr(id, docId, user);
  }

  @Get(':id/documents/:docId/ocr')
  @Roles('transporter', 'producer', 'plant')
  getDocOcr(@Param('id', ParseUUIDPipe) id: string, @Param('docId', ParseUUIDPipe) docId: string,
    @CurrentUser() user: any) {
    return this.service.getDocOcr(id, docId, user);
  }

  @Patch(':id/documents/:docId/ocr')
  @Roles('transporter', 'producer', 'plant')
  updateDocOcr(@Param('id', ParseUUIDPipe) id: string, @Param('docId', ParseUUIDPipe) docId: string,
    @Body() body: any, @CurrentUser() user: any) {
    return this.service.updateDocOcr(id, docId, body.ocrData, user);
  }

  @Patch(':id/documents/:docId/ocr-clear')
  @Roles('transporter', 'producer', 'plant')
  clearDocOcr(@Param('id', ParseUUIDPipe) id: string, @Param('docId', ParseUUIDPipe) docId: string,
    @CurrentUser() user: any) {
    return this.service.clearDocOcr(id, docId, user);
  }

  // Freights (history)
  @Get(':id/freights')
  @Roles('transporter', 'producer', 'plant')
  listFreights(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any,
    @Query('take') take?: string, @Query('skip') skip?: string) {
    return this.service.listFreights(id, user, take ? parseInt(take) : 20, skip ? parseInt(skip) : 0);
  }

  // Trip data
  @Patch(':freightId/assignments/:assignmentId/trip-data')
  @Roles('transporter', 'producer', 'plant')
  updateTripData(@Param('freightId', ParseUUIDPipe) freightId: string,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Body() body: any, @CurrentUser() user: any) {
    return this.service.updateTripData(freightId, assignmentId, body, user);
  }

  // Economic summary
  @Get(':id/economic-summary')
  @Roles('transporter', 'producer', 'plant')
  getEconomicSummary(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any,
    @Query('from') from?: string, @Query('to') to?: string) {
    return this.service.getEconomicSummary(id, user, from, to);
  }
}
