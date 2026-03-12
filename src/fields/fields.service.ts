import { Injectable, NotFoundException, ForbiddenException, BadRequestException, UnprocessableEntityException, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CompanyResolutionService } from '../common/services/company-resolution.service';
import { CreateFieldDto, UpdateFieldDto, CreateLotDto, UpdateLotDto, ImportConfirmDto } from './fields.dto';

const GMAPS_DOMAINS = ['maps.app.goo.gl', 'goo.gl', 'google.com', 'www.google.com'];
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'es-UY,es;q=0.9,en;q=0.8',
};

@Injectable()
export class FieldsService {
  private readonly logger = new Logger(FieldsService.name);

  constructor(
    private prisma: PrismaService,
    private companyRes: CompanyResolutionService,
  ) {}

  private async resolveAllProducerCompanyIds(user: any): Promise<string[]> {
    return this.companyRes.resolveAllProducerCompanyIds(user);
  }

  private async resolveProducerCompanyId(user: any): Promise<string> {
    const id = await this.companyRes.resolveProducerCompanyId(user);
    if (!id) throw new ForbiddenException('No tenés empresa productora asociada');
    return id;
  }

  async getFields(user: any) {
    const companyIds = await this.resolveAllProducerCompanyIds(user);
    if (companyIds.length === 0) return [];
    return this.prisma.field.findMany({
      where: { companyId: { in: companyIds }, active: true },
      include: {
        company: { select: { id: true, name: true } },
        lots: {
          where: { active: true },
          select: { id: true, name: true, hectares: true, lat: true, lng: true },
          orderBy: { name: 'asc' },
        },
      },
      orderBy: [{ companyId: 'asc' }, { name: 'asc' }],
    });
  }

  async createField(user: any, dto: CreateFieldDto) {
    const companyId = await this.resolveProducerCompanyId(user);
    return this.prisma.field.create({
      data: {
        name: dto.name,
        companyId,
        address: dto.address || null,
        lat: dto.lat != null ? dto.lat : null,
        lng: dto.lng != null ? dto.lng : null,
      },
    });
  }

  async updateField(user: any, fieldId: string, dto: UpdateFieldDto) {
    const companyId = await this.resolveProducerCompanyId(user);
    const field = await this.prisma.field.findFirst({
      where: { id: fieldId, companyId, active: true },
    });
    if (!field) throw new NotFoundException('Campo no encontrado');

    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.lat !== undefined) data.lat = dto.lat;
    if (dto.lng !== undefined) data.lng = dto.lng;

    return this.prisma.field.update({
      where: { id: fieldId },
      data,
    });
  }

  async getLots(user: any, fieldId: string) {
    const companyId = await this.resolveProducerCompanyId(user);
    const field = await this.prisma.field.findFirst({
      where: { id: fieldId, companyId, active: true },
    });
    if (!field) throw new NotFoundException('Campo no encontrado');

    return this.prisma.lot.findMany({
      where: { fieldId, active: true },
      select: { id: true, name: true, hectares: true, lat: true, lng: true },
      orderBy: { name: 'asc' },
    });
  }

  async createLot(user: any, fieldId: string, dto: CreateLotDto) {
    const companyId = await this.resolveProducerCompanyId(user);
    const field = await this.prisma.field.findFirst({
      where: { id: fieldId, companyId, active: true },
    });
    if (!field) throw new NotFoundException('Campo no encontrado');

    const lat = dto.lat ?? field.lat;
    const lng = dto.lng ?? field.lng;

    return this.prisma.lot.create({
      data: {
        name: dto.name,
        companyId,
        fieldId: fieldId,
        hectares: dto.hectares != null ? dto.hectares : null,
        lat: lat != null ? lat : null,
        lng: lng != null ? lng : null,
      },
    });
  }

  async updateLot(user: any, fieldId: string, lotId: string, dto: UpdateLotDto) {
    const companyId = await this.resolveProducerCompanyId(user);
    const lot = await this.prisma.lot.findFirst({
      where: { id: lotId, fieldId, companyId, active: true },
    });
    if (!lot) throw new NotFoundException('Lote no encontrado');

    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.hectares !== undefined) data.hectares = dto.hectares;
    if (dto.lat !== undefined) data.lat = dto.lat;
    if (dto.lng !== undefined) data.lng = dto.lng;

    return this.prisma.lot.update({
      where: { id: lotId },
      data,
    });
  }

  // ── Google Maps Link Import ──────────────────────────────────────

  /**
   * Resolve a Google Maps share URL.
   * Supports both single-location links and saved-places lists (multiple locations).
   * For lists, fetches the entitylist/getlist endpoint to extract all places.
   */
  private async resolveGoogleLink(shortUrl: string): Promise<{ name: string | null; lat: number; lng: number; address: string | null }[]> {
    try {
      const res = await fetch(shortUrl, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
      const html = await res.text();

      // Strategy A: Check if this is a saved-places list (entitylist/getlist URL in HTML)
      const listUrlMatch = html.match(/entitylist\/getlist\?[^"'\s]+/);
      if (listUrlMatch) {
        const listLocations = await this.resolveGoogleList(listUrlMatch[0]);
        if (listLocations.length > 0) return listLocations;
      }

      // Strategy B: Single location — extract from staticmap meta tag
      const centerMatch = html.match(/center=(-?\d+\.\d+)%2C(-?\d+\.\d+)/);
      let lat: number, lng: number;
      if (centerMatch) {
        lat = parseFloat(centerMatch[1]);
        lng = parseFloat(centerMatch[2]);
      } else {
        // Fallback: extract from @lat,lng in final URL
        const urlMatch = res.url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
        if (!urlMatch) return [];
        lat = parseFloat(urlMatch[1]);
        lng = parseFloat(urlMatch[2]);
      }

      if (isNaN(lat) || isNaN(lng) || (lat === 0 && lng === 0)) return [];

      // Try to extract place name from /place/Name/ in URL
      const placeMatch = res.url.match(/\/place\/([^/@]+)/);
      let urlName = placeMatch ? decodeURIComponent(placeMatch[1].replace(/\+/g, ' ')) : null;

      // Fallback: extract from og:title or <title> in HTML
      if (!urlName) {
        const ogMatch = html.match(/property="og:title"\s+content="([^"]+)"/);
        if (ogMatch && ogMatch[1] !== 'Google Maps') {
          urlName = ogMatch[1];
        }
      }

      return [{
        name: urlName,
        lat: Math.round(lat * 1e6) / 1e6,
        lng: Math.round(lng * 1e6) / 1e6,
        address: null,
      }];
    } catch {
      return [];
    }
  }

  /**
   * Fetch all locations from a Google Maps saved-places list via the entitylist/getlist endpoint.
   */
  private async resolveGoogleList(getlistPath: string): Promise<{ name: string | null; lat: number; lng: number; address: string | null }[]> {
    try {
      // Unescape HTML entities (&amp; → &) and build full URL
      const cleanPath = getlistPath.replace(/&amp;/g, '&');
      const url = cleanPath.startsWith('http') ? cleanPath : `https://www.google.com/maps/preview/${cleanPath}`;

      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      let body = await res.text();

      // Strip XSSI prefix )]}'
      body = body.replace(/^\)\]\}'/, '').trim();

      const data = JSON.parse(body);
      const items = data?.[8];
      if (!Array.isArray(items)) return [];

      const locations: { name: string | null; lat: number; lng: number; address: string | null }[] = [];
      for (const item of items) {
        try {
          const coords = item?.[1]?.[5];
          if (!coords) continue;
          const lat = coords[2];
          const lng = coords[3];
          if (typeof lat !== 'number' || typeof lng !== 'number') continue;
          if (isNaN(lat) || isNaN(lng) || (lat === 0 && lng === 0)) continue;

          // Custom name at [3], fallback type at [2], address at [1][4]
          const customName = item[3] || item[2] || null;
          const address = item[1]?.[4] || null;

          locations.push({
            name: customName,
            lat: Math.round(lat * 1e6) / 1e6,
            lng: Math.round(lng * 1e6) / 1e6,
            address: typeof address === 'string' ? address : null,
          });
        } catch {
          // Skip malformed items
        }
      }
      return locations;
    } catch {
      return [];
    }
  }

  async parseGoogleLinks(text: string) {
    // Extract all Google Maps short links from pasted text
    const urlRegex = /https?:\/\/maps\.app\.goo\.gl\/[A-Za-z0-9_-]+[^\s)}\]>"]*/g;
    const lines = text.split('\n').map(l => l.trim());

    // Build entries: for each URL, look at the preceding non-empty line as potential name
    const entries: { url: string; contextName: string | null }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const urls = lines[i].match(urlRegex);
      if (!urls) continue;
      for (const url of urls) {
        let contextName: string | null = null;
        for (let j = i - 1; j >= 0; j--) {
          const prev = lines[j];
          if (!prev) continue;
          if (urlRegex.test(prev)) break;
          contextName = prev.split('·')[0].trim() || prev.trim();
          break;
        }
        entries.push({ url: url.replace(/[?&]g_st=[^&\s]*/g, ''), contextName });
      }
    }

    if (entries.length === 0) {
      throw new BadRequestException('No se encontraron links de Google Maps en el texto pegado');
    }
    if (entries.length > 50) {
      throw new BadRequestException('Máximo 50 links por importación');
    }

    // Resolve all URLs in parallel (with concurrency limit)
    // Each link may return multiple locations (saved-places lists)
    const BATCH = 5;
    const parsed: any[] = [];
    let discarded = 0;

    for (let i = 0; i < entries.length; i += BATCH) {
      const batch = entries.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(e => this.resolveGoogleLink(e.url)));
      for (let j = 0; j < results.length; j++) {
        const locations = results[j];
        if (locations.length === 0) { discarded++; continue; }
        const entry = batch[j];
        for (const loc of locations) {
          parsed.push({
            name: loc.name || entry.contextName || 'Ubicación sin nombre',
            address: loc.address,
            lat: loc.lat,
            lng: loc.lng,
          });
        }
      }
    }

    return { parsed, discarded };
  }

  // ── Import from Google Maps shared list URL ────────────────────

  async importGoogleList(url: string) {
    // Validate domain
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new BadRequestException('URL inválida'); }
    if (!GMAPS_DOMAINS.some(d => parsed.hostname === d || parsed.hostname.endsWith('.' + d))) {
      throw new BadRequestException('La URL no es un link válido de Google Maps');
    }

    this.logger.log(`[import-list] Resolving URL: ${url}`);

    // Step 1: Follow redirects to get the expanded URL
    let expandedUrl: string;
    let html: string;
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: BROWSER_HEADERS,
        signal: AbortSignal.timeout(15000),
      });
      expandedUrl = res.url;
      html = await res.text();
    } catch (err) {
      this.logger.error(`[import-list] Failed to fetch URL: ${err.message}`);
      throw new UnprocessableEntityException('No se pudo acceder al link de Google Maps. Verificá que sea un link válido.');
    }

    this.logger.log(`[import-list] Expanded URL: ${expandedUrl}`);

    // Strategy A: entitylist/getlist endpoint (saved-places lists)
    const listUrlMatch = html.match(/entitylist\/getlist\?[^"'\s]+/);
    if (listUrlMatch) {
      this.logger.log(`[import-list] Found entitylist/getlist URL, fetching list data...`);
      const listLocations = await this.resolveGoogleList(listUrlMatch[0]);
      if (listLocations.length > 0) {
        this.logger.log(`[import-list] Extracted ${listLocations.length} locations via entitylist/getlist`);
        // Try to extract list name from og:title or page title
        let listName: string | null = null;
        const ogMatch = html.match(/property="og:title"\s+content="([^"]+)"/);
        if (ogMatch && ogMatch[1] !== 'Google Maps') listName = ogMatch[1];
        return { listName, parsed: listLocations.map(l => ({ ...l, name: l.name || 'Ubicación sin nombre' })), total: listLocations.length, discarded: 0, warning: null };
      }
    }

    // Strategy B: Extract data= parameter and fetch the list page
    const dataMatch = expandedUrl.match(/[?&]data=([^&]+)/) || html.match(/data=([^"&\s]+)/);
    if (dataMatch) {
      this.logger.log(`[import-list] Found data= parameter, fetching list page...`);
      try {
        const dataUrl = `https://www.google.com/maps/@/data=${dataMatch[1]}?ucbcb=1`;
        const dataRes = await fetch(dataUrl, {
          headers: BROWSER_HEADERS,
          signal: AbortSignal.timeout(15000),
        });
        const dataHtml = await dataRes.text();
        const locations = this.parseLocationsFromHtml(dataHtml);
        if (locations.length > 0) {
          this.logger.log(`[import-list] Extracted ${locations.length} locations via data= page`);
          let listName: string | null = null;
          const ogMatch = dataHtml.match(/property="og:title"\s+content="([^"]+)"/);
          if (ogMatch && ogMatch[1] !== 'Google Maps') listName = ogMatch[1];
          return { listName, parsed: locations, total: locations.length, discarded: 0, warning: null };
        }
      } catch (err) {
        this.logger.warn(`[import-list] data= page fetch failed: ${err.message}`);
      }
    }

    // Strategy C: Parse the initial HTML response directly
    this.logger.log(`[import-list] Trying direct HTML parse...`);
    const directLocations = this.parseLocationsFromHtml(html);
    if (directLocations.length > 0) {
      this.logger.log(`[import-list] Extracted ${directLocations.length} locations from direct HTML`);
      let listName: string | null = null;
      const ogMatch = html.match(/property="og:title"\s+content="([^"]+)"/);
      if (ogMatch && ogMatch[1] !== 'Google Maps') listName = ogMatch[1];
      return { listName, parsed: directLocations, total: directLocations.length, discarded: 0, warning: null };
    }

    // Strategy D: Single location fallback (staticmap / @lat,lng)
    const singleLoc = this.parseSingleLocation(html, expandedUrl);
    if (singleLoc) {
      this.logger.log(`[import-list] Extracted single location fallback`);
      return { listName: null, parsed: [singleLoc], total: 1, discarded: 0, warning: 'Se encontró una sola ubicación. ¿Es un link de lista o de un lugar individual?' };
    }

    this.logger.warn(`[import-list] No locations found in URL`);
    throw new UnprocessableEntityException('No se pudieron extraer ubicaciones de este link. Verificá que sea un link de lista compartida de Google Maps.');
  }

  /**
   * Parse locations from Google Maps HTML/JS using coordinate regex.
   * Looks for [null,null,lat,lng] patterns and extracts nearby names.
   */
  private parseLocationsFromHtml(html: string): { name: string; lat: number; lng: number; address: string | null }[] {
    const coordRegex = /\[null,null,(-?\d+\.\d+),(-?\d+\.\d+)\]/g;
    const locations: { name: string; lat: number; lng: number; address: string | null }[] = [];
    const seen = new Set<string>();
    let match: RegExpExecArray | null;
    let idx = 0;

    while ((match = coordRegex.exec(html)) !== null) {
      const lat = parseFloat(match[1]);
      const lng = parseFloat(match[2]);
      if (isNaN(lat) || isNaN(lng)) continue;
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
      if (lat === 0 && lng === 0) continue;

      // Deduplicate by rounding to ~1m precision
      const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Extract name from surrounding text
      let name: string | null = null;
      // Look backwards from the match for a quoted string (escaped or regular)
      const before = html.substring(Math.max(0, match.index - 500), match.index);
      // Try escaped quotes first: \"Name\"
      const escapedQuotes = [...before.matchAll(/\\"([^"\\]{1,200})\\"/g)];
      if (escapedQuotes.length > 0) {
        const candidate = escapedQuotes[escapedQuotes.length - 1][1];
        if (candidate && candidate.length > 1 && !/^[\d\s.,-]+$/.test(candidate)) {
          name = this.htmlUnescape(candidate);
        }
      }
      // Try regular quotes
      if (!name) {
        const regularQuotes = [...before.matchAll(/"([^"]{1,200})"/g)];
        if (regularQuotes.length > 0) {
          const candidate = regularQuotes[regularQuotes.length - 1][1];
          if (candidate && candidate.length > 1 && !/^[\d\s.,-]+$/.test(candidate) && !candidate.includes('null')) {
            name = this.htmlUnescape(candidate);
          }
        }
      }

      idx++;
      locations.push({
        name: name || `Ubicación ${idx}`,
        lat: Math.round(lat * 1e6) / 1e6,
        lng: Math.round(lng * 1e6) / 1e6,
        address: null,
      });
    }

    this.logger.log(`[import-list] Regex found ${locations.length} coordinate matches (${seen.size} unique)`);
    return locations;
  }

  private parseSingleLocation(html: string, finalUrl: string): { name: string; lat: number; lng: number; address: string | null } | null {
    const centerMatch = html.match(/center=(-?\d+\.\d+)%2C(-?\d+\.\d+)/);
    let lat: number, lng: number;
    if (centerMatch) {
      lat = parseFloat(centerMatch[1]);
      lng = parseFloat(centerMatch[2]);
    } else {
      const urlMatch = finalUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
      if (!urlMatch) return null;
      lat = parseFloat(urlMatch[1]);
      lng = parseFloat(urlMatch[2]);
    }
    if (isNaN(lat) || isNaN(lng) || (lat === 0 && lng === 0)) return null;

    const placeMatch = finalUrl.match(/\/place\/([^/@]+)/);
    let name = placeMatch ? decodeURIComponent(placeMatch[1].replace(/\+/g, ' ')) : null;
    if (!name) {
      const ogMatch = html.match(/property="og:title"\s+content="([^"]+)"/);
      if (ogMatch && ogMatch[1] !== 'Google Maps') name = ogMatch[1];
    }

    return {
      name: name || 'Ubicación sin nombre',
      lat: Math.round(lat * 1e6) / 1e6,
      lng: Math.round(lng * 1e6) / 1e6,
      address: null,
    };
  }

  private htmlUnescape(str: string): string {
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }

  async importConfirm(user: any, dto: ImportConfirmDto) {
    const companyId = await this.resolveProducerCompanyId(user);
    const locations = dto.locations;

    if (locations.length === 0) {
      throw new BadRequestException('No hay ubicaciones para importar');
    }

    // Fetch existing fields to check for near-duplicates (< 100m)
    const existing = await this.prisma.field.findMany({
      where: { companyId, active: true },
      select: { name: true, lat: true, lng: true },
    });

    const created: string[] = [];
    const errors: string[] = [];

    for (const loc of locations) {
      // Check near-duplicate: same name + < 100m distance
      const isDuplicate = existing.some(e => {
        if (e.name !== loc.name) return false;
        if (e.lat == null || e.lng == null) return false;
        const dLat = (Number(e.lat) - loc.lat) * 111320;
        const dLng = (Number(e.lng) - loc.lng) * 111320 * Math.cos(loc.lat * Math.PI / 180);
        return Math.sqrt(dLat * dLat + dLng * dLng) < 100;
      });

      if (isDuplicate) {
        errors.push(`"${loc.name}" ya existe con coordenadas similares`);
        continue;
      }

      try {
        await this.prisma.field.create({
          data: {
            name: loc.name,
            companyId,
            address: loc.address || null,
            lat: loc.lat,
            lng: loc.lng,
          },
        });
        created.push(loc.name);
        // Add to existing array so subsequent items in this batch also deduplicate
        existing.push({ name: loc.name, lat: loc.lat as any, lng: loc.lng as any });
      } catch (err) {
        errors.push(`Error al crear "${loc.name}": ${err.message}`);
      }
    }

    return { created: created.length, errors };
  }
}
