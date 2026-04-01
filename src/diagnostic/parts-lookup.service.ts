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

    // 1. Check cache
    const cached = await this.findCached(machineBrand, machineModel, partDescription);
    if (cached.length > 0) return cached;

    // 2. Search via DuckDuckGo
    let results: PartLookupResult[] = [];
    try {
      results = await this.searchViaDuckDuckGo(machineBrand, machineModel, partDescription);
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

    // Search DuckDuckGo for this specific part number
    try {
      const results = await this.searchDDG(`"${partNumber}" part number OEM`);
      if (results.length > 0) {
        const r = results[0];
        await this.cacheResult({ ...r, partNumber, found: true }, '').catch(() => {});
        return { ...r, partNumber, found: true };
      }
    } catch (err) {
      this.logger.error(`Part verify error: ${err.message}`);
    }
    return null;
  }

  // ── DuckDuckGo Search ──

  private async searchViaDuckDuckGo(brand: string, model: string, partDesc: string): Promise<PartLookupResult[]> {
    const brandLower = brand.toLowerCase();
    let searchSites = '';
    if (brandLower.includes('deere') || brandLower.includes('john deere')) {
      searchSites = 'site:shop.deere.com OR site:greenfarmparts.com OR site:avs.parts';
    } else if (brandLower.includes('case')) {
      searchSites = 'site:messicks.com OR site:caseih.com OR site:cnhindustrial.com';
    } else if (brandLower.includes('new holland')) {
      searchSites = 'site:messicks.com OR site:newholland.com OR site:cnhindustrial.com';
    } else {
      searchSites = 'site:messicks.com OR site:tractorjoe.com OR site:agriexpo.com';
    }

    const query = `${brand} ${model} ${partDesc} OEM part number ${searchSites}`;
    const results = await this.searchDDG(query);

    // If few results from specific sites, try broader search
    if (results.length < 2) {
      const broader = await this.searchDDG(`${brand} ${model} ${partDesc} OEM part number`);
      // Merge, dedup by partNumber
      const seen = new Set(results.map(r => r.partNumber));
      for (const r of broader) {
        if (!seen.has(r.partNumber)) { results.push(r); seen.add(r.partNumber); }
      }
    }

    return results.slice(0, 5);
  }

  private async searchDDG(query: string): Promise<PartLookupResult[]> {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return [];
    const html = await res.text();

    const results: PartLookupResult[] = [];
    const seenParts = new Set<string>();

    // Extract result titles, URLs, and snippets
    const titleRegex = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRegex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

    const titles: { url: string; title: string }[] = [];
    let match;
    while ((match = titleRegex.exec(html)) !== null) {
      const rawUrl = match[1];
      // DuckDuckGo wraps URLs: //duckduckgo.com/l/?uddg=https%3A%2F%2F...
      const urlMatch = rawUrl.match(/uddg=([^&]+)/);
      const finalUrl = urlMatch ? decodeURIComponent(urlMatch[1]) : rawUrl;
      const title = match[2].replace(/<[^>]*>/g, '').trim();
      titles.push({ url: finalUrl, title });
    }

    const snippets: string[] = [];
    while ((match = snippetRegex.exec(html)) !== null) {
      snippets.push(match[1].replace(/<[^>]*>/g, '').trim());
    }

    // Extract part numbers from titles and snippets
    for (let i = 0; i < Math.min(titles.length, 10); i++) {
      const text = `${titles[i].title} ${snippets[i] || ''}`;
      const source = titles[i].url;

      // Part number patterns
      const patterns = [
        /\b([A-Z]{2}\d{5,8})\b/g,   // JD: RE504836, DZ114256, AL156625
        /\b([A-Z]\d{7,9})\b/g,       // Some: A123456789
        /\b(\d{8,10})\b/g,           // CNH: 84412164
      ];

      for (const pat of patterns) {
        let pmatch;
        while ((pmatch = pat.exec(text)) !== null) {
          const pn = pmatch[1];
          if (seenParts.has(pn)) continue;
          if (pn.length < 5 || pn.length > 12) continue;
          // Filter out obviously non-part numbers (years, phone numbers, etc)
          if (/^(19|20)\d{2}$/.test(pn)) continue;
          if (/^0+/.test(pn)) continue;

          seenParts.add(pn);
          // Determine brand from context
          let partBrand = 'Unknown';
          if (/deere|john/i.test(text) || /^[A-Z]{2}\d/.test(pn)) partBrand = 'John Deere';
          else if (/case/i.test(text)) partBrand = 'Case IH';
          else if (/new holland|nh/i.test(text)) partBrand = 'New Holland';
          else if (/massey|mf/i.test(text)) partBrand = 'Massey Ferguson';
          else if (/baldwin/i.test(text)) partBrand = 'Baldwin';
          else if (/donaldson/i.test(text)) partBrand = 'Donaldson';
          else if (/fleetguard/i.test(text)) partBrand = 'Fleetguard';
          else if (/wix/i.test(text)) partBrand = 'WIX';

          const description = titles[i].title.slice(0, 100);

          results.push({
            found: true,
            source: new URL(source).hostname.replace('www.', ''),
            sourceUrl: source,
            partNumber: pn,
            description,
            brand: partBrand,
          });
        }
      }
    }

    return results;
  }

  // ── Cache ──

  private async findCached(brand: string, _model: string, description: string): Promise<PartLookupResult[]> {
    const cached = await this.prisma.verifiedPart.findMany({
      where: {
        brand: { contains: brand, mode: 'insensitive' },
        description: { contains: description, mode: 'insensitive' },
      },
      take: 5,
    });
    if (cached.length === 0) return [];

    await this.prisma.verifiedPart.updateMany({
      where: { id: { in: cached.map(c => c.id) } },
      data: { timesUsed: { increment: 1 } },
    });

    return cached.map(c => ({
      found: true, source: c.source, sourceUrl: c.sourceUrl || '',
      partNumber: c.partNumber, description: c.description, brand: c.brand,
      diagramUrl: c.diagramUrl || undefined, price: c.lastKnownPrice || undefined,
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
        machineModels: model ? [model] : [],
        source: result.source,
        sourceUrl: result.sourceUrl,
        lastKnownPrice: result.price,
        priceDate: result.price ? new Date() : undefined,
      },
    });
  }
}
