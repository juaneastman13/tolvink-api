import * as fs from 'fs';
import * as path from 'path';

type TolvinkPlantLike = {
  sourceRowId?: number | null;
  sourcePlantId?: number | null;
  name: string;
  altName?: string | null;
  department?: string | null;
  locality?: string | null;
};

type CsvEntry = {
  sourceRowId: number | null;
  sourcePlantId: number | null;
  name: string | null;
  altName: string | null;
  department: string | null;
  locality: string | null;
};

let cachedEntries: CsvEntry[] | null = null;

function normalizeText(value: string | null | undefined): string | null {
  const normalized = String(value || '').replace(/\uFEFF/g, '').trim().replace(/\s+/g, ' ');
  return normalized.length ? normalized : null;
}

function parseIntSafe(value: string | null | undefined): number | null {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function readCsvEntries(): CsvEntry[] {
  if (cachedEntries) return cachedEntries;

  const candidates = [
    path.resolve(process.cwd(), 'tolvink-plants-with-locality-fixed.csv'),
    path.resolve(process.cwd(), 'tolvink-plants-with-locality.csv'),
  ];

  const csvPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!csvPath) {
    cachedEntries = [];
    return cachedEntries;
  }

  const raw = fs.readFileSync(csvPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  cachedEntries = lines.slice(1).map((line) => {
    const columns = line.split(';');
    return {
      sourceRowId: parseIntSafe(columns[0]),
      sourcePlantId: parseIntSafe(columns[1]),
      name: normalizeText(columns[2]),
      altName: normalizeText(columns[3]),
      department: normalizeText(columns[4]),
      locality: normalizeText(columns[7]),
    };
  });

  return cachedEntries;
}

function sameText(left: string | null | undefined, right: string | null | undefined) {
  return normalizeText(left)?.toLowerCase() === normalizeText(right)?.toLowerCase();
}

function findLocality(plant: TolvinkPlantLike): string | null {
  const entries = readCsvEntries();
  if (!entries.length) return null;

  const bySource = entries.find((entry) =>
    (plant.sourceRowId != null && entry.sourceRowId === plant.sourceRowId) ||
    (plant.sourcePlantId != null && entry.sourcePlantId === plant.sourcePlantId),
  );
  if (bySource?.locality) return bySource.locality;

  const byIdentity = entries.find((entry) =>
    sameText(entry.name, plant.name) &&
    sameText(entry.department, plant.department) &&
    (!normalizeText(plant.altName) || sameText(entry.altName, plant.altName))
  );
  return byIdentity?.locality || null;
}

export function hydrateTolvinkPlantLocality<T extends TolvinkPlantLike>(plants: T[]): Array<T & { locality: string | null }> {
  return plants.map((plant) => ({
    ...plant,
    locality: normalizeText(plant.locality) || findLocality(plant),
  }));
}
