import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

export interface PartLookupResult {
  found: boolean;
  source: string;
  sourceUrl: string;
  partNumber: string;
  description: string;
  brand: string;
  diagramUrl?: string;
  price?: string;
  availability?: string;
  crossReferences?: { brand: string; partNumber: string }[];
}

@Injectable()
export class PartsLookupService {
  private readonly logger = new Logger('PartsLookupService');

  constructor(private prisma: PrismaService) {}

  async searchParts(query: {
    machineBrand: string;
    machineModel: string;
    partDescription: string;
    partCategory?: string;
  }): Promise<PartLookupResult[]> {
    const { machineBrand, machineModel, partDescription } = query;

    // 1. Check cache first
    const cached = await this.findCached(machineBrand, machineModel, partDescription);
    if (cached.length > 0) return cached;

    // 2. Search external sources
    let results: PartLookupResult[] = [];
    const brandLower = machineBrand.toLowerCase();

    try {
      if (brandLower.includes('deere') || brandLower.includes('john deere')) {
        results = await this.searchGreenFarmParts(machineModel, partDescription);
      }
      if (results.length === 0 && (brandLower.includes('case') || brandLower.includes('new holland'))) {
        results = await this.searchMessicks(machineBrand, machineModel, partDescription);
      }
      // Generic fallback for any brand
      if (results.length === 0) {
        results = await this.searchGenericWeb(machineBrand, machineModel, partDescription);
      }
    } catch (err) {
      this.logger.error(`Parts search error: ${err.message}`);
    }

    // 3. Cache results
    for (const r of results) {
      await this.cacheResult(r, machineModel).catch(() => {});
    }

    return results;
  }

  async verifyPartNumber(partNumber: string): Promise<PartLookupResult | null> {
    // Check cache
    const cached = await this.prisma.verifiedPart.findFirst({
      where: { partNumber: { equals: partNumber, mode: 'insensitive' } },
    });
    if (cached) {
      await this.prisma.verifiedPart.update({ where: { id: cached.id }, data: { timesUsed: { increment: 1 } } });
      return {
        found: true, source: cached.source, sourceUrl: cached.sourceUrl || '',
        partNumber: cached.partNumber, description: cached.description, brand: cached.brand,
        diagramUrl: cached.diagramUrl || undefined, price: cached.lastKnownPrice || undefined,
        crossReferences: (cached.crossReferences as any[]) || undefined,
      };
    }

    // Search web for the specific part number
    try {
      const results = await this.fetchAndParse(
        `https://www.messicks.com/search?q=${encodeURIComponent(partNumber)}`,
        partNumber
      );
      if (results.length > 0) return results[0];

      const gfp = await this.fetchAndParse(
        `https://www.greenfarmparts.com/search?q=${encodeURIComponent(partNumber)}`,
        partNumber
      );
      if (gfp.length > 0) return gfp[0];
    } catch (err) {
      this.logger.error(`Part verify error: ${err.message}`);
    }

    return null;
  }

  // ── Green Farm Parts (John Deere) ──

  private async searchGreenFarmParts(model: string, partDesc: string): Promise<PartLookupResult[]> {
    const searchQuery = `${model} ${partDesc}`;
    const url = `https://www.greenfarmparts.com/search?q=${encodeURIComponent(searchQuery)}`;
    return this.fetchAndParse(url, partDesc, 'John Deere', 'greenfarmparts.com');
  }

  // ── Messicks (Case IH / New Holland) ──

  private async searchMessicks(brand: string, model: string, partDesc: string): Promise<PartLookupResult[]> {
    const searchQuery = `${model} ${partDesc}`;
    const url = `https://www.messicks.com/search?q=${encodeURIComponent(searchQuery)}`;
    return this.fetchAndParse(url, partDesc, brand, 'messicks.com');
  }

  // ── Generic web search ──

  private async searchGenericWeb(brand: string, model: string, partDesc: string): Promise<PartLookupResult[]> {
    // Try messicks as it covers many brands
    const url = `https://www.messicks.com/search?q=${encodeURIComponent(`${brand} ${model} ${partDesc}`)}`;
    return this.fetchAndParse(url, partDesc, brand, 'messicks.com');
  }

  // ── Fetch + Parse HTML ──

  private async fetchAndParse(url: string, searchTerm: string, defaultBrand?: string, sourceName?: string): Promise<PartLookupResult[]> {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TolvinkBot/1.0)' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return [];
      const html = await res.text();

      // Extract part numbers with regex patterns common across these sites
      const results: PartLookupResult[] = [];

      // Pattern: OEM part numbers (alphanumeric, 5-15 chars, often with hyphens)
      // John Deere: RE504836, AT365870, AH212543
      // Case/NH: 84412164, 87679598, 47124379
      const partPatterns = [
        /(?:part\s*#?\s*:?\s*|P\/N:?\s*|OEM:?\s*|item:?\s*)([A-Z]{1,3}\d{5,10})/gi,
        /(?:part\s*#?\s*:?\s*|P\/N:?\s*|OEM:?\s*)(\d{8,11})/gi,
        /\b([A-Z]{2}\d{6,8})\b/g, // JD pattern: RE504836
        /\b(\d{8,11})\b/g, // CNH pattern: 84412164
      ];

      const foundParts = new Set<string>();
      for (const pattern of partPatterns) {
        let match;
        while ((match = pattern.exec(html)) !== null) {
          const pn = match[1].trim();
          if (pn.length >= 5 && pn.length <= 15 && !foundParts.has(pn)) {
            foundParts.add(pn);
          }
        }
        if (foundParts.size >= 5) break; // Enough results
      }

      // Extract descriptions near part numbers
      for (const pn of Array.from(foundParts).slice(0, 5)) {
        // Find context around the part number in HTML
        const idx = html.indexOf(pn);
        if (idx === -1) continue;
        const context = html.substring(Math.max(0, idx - 200), Math.min(html.length, idx + 200));
        // Extract description from title tags or nearby text
        const descMatch = context.match(/title="([^"]{5,80})"/i)
          || context.match(/>([^<]{5,80})</);
        const description = descMatch?.[1]?.replace(/<[^>]*>/g, '').trim() || searchTerm;

        // Extract price
        const priceMatch = context.match(/\$\s*([\d,]+\.?\d{0,2})/);

        results.push({
          found: true,
          source: sourceName || new URL(url).hostname,
          sourceUrl: url,
          partNumber: pn,
          description,
          brand: defaultBrand || 'Unknown',
          price: priceMatch ? priceMatch[1] : undefined,
        });
      }

      return results;
    } catch (err) {
      this.logger.warn(`Fetch failed for ${url}: ${err.message}`);
      return [];
    }
  }

  // ── Cache ──

  private async findCached(brand: string, model: string, description: string): Promise<PartLookupResult[]> {
    const cached = await this.prisma.verifiedPart.findMany({
      where: {
        brand: { contains: brand, mode: 'insensitive' },
        description: { contains: description, mode: 'insensitive' },
      },
      take: 5,
    });
    if (cached.length === 0) return [];

    // Increment usage
    await this.prisma.verifiedPart.updateMany({
      where: { id: { in: cached.map(c => c.id) } },
      data: { timesUsed: { increment: 1 } },
    });

    return cached.map(c => ({
      found: true,
      source: c.source,
      sourceUrl: c.sourceUrl || '',
      partNumber: c.partNumber,
      description: c.description,
      brand: c.brand,
      diagramUrl: c.diagramUrl || undefined,
      price: c.lastKnownPrice || undefined,
      crossReferences: (c.crossReferences as any[]) || undefined,
    }));
  }

  private async cacheResult(result: PartLookupResult, model: string) {
    await this.prisma.verifiedPart.upsert({
      where: { partNumber_brand: { partNumber: result.partNumber, brand: result.brand } },
      update: { timesUsed: { increment: 1 } },
      create: {
        partNumber: result.partNumber,
        brand: result.brand,
        description: result.description,
        machineModels: [model],
        source: result.source,
        sourceUrl: result.sourceUrl,
        diagramUrl: result.diagramUrl,
        lastKnownPrice: result.price,
        priceDate: result.price ? new Date() : undefined,
      },
    });
  }
}
