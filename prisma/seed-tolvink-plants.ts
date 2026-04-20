import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

const DEFAULT_CSV_PATH =
  process.env.TOLVINK_PLANTS_CSV_PATH ||
  path.resolve(__dirname, '../tolvink-plants-with-locality-fixed.csv');

type CsvRow = {
  objectId: number | null;
  sourcePlantId: number | null;
  name: string;
  altName: string | null;
  department: string | null;
  locality: string | null;
  lat: string | null;
  lng: string | null;
};

function normalizeText(value: string | undefined): string | null {
  const normalized = (value || '').replace(/\uFEFF/g, '').trim().replace(/\s+/g, ' ');
  return normalized.length ? normalized : null;
}

function normalizeCoordinate(raw: string | undefined): string | null {
  const value = normalizeText(raw);
  if (!value) return null;

  const negative = value.includes('-');
  const digits = value.replace(/\D/g, '');
  if (digits.length < 3) return null;

  const numeric = Number(`${negative ? '-' : ''}${digits.slice(0, 2)}.${digits.slice(2)}`);
  if (!Number.isFinite(numeric)) return null;

  return numeric.toFixed(6);
}

function parseCsv(csvPath: string): CsvRow[] {
  const raw = fs.readFileSync(csvPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);

  if (lines.length <= 1) {
    return [];
  }

  return lines.slice(1).map((line, index) => {
    const columns = line.split(';');
    const objectId = Number.parseInt((columns[0] || '').trim(), 10);
    const sourcePlantId = Number.parseInt((columns[1] || '').trim(), 10);
    const name = normalizeText(columns[2]) || `PLANTA ${index + 1}`;

    return {
      objectId: Number.isFinite(objectId) ? objectId : null,
      sourcePlantId: Number.isFinite(sourcePlantId) ? sourcePlantId : null,
      name,
      altName: normalizeText(columns[3]),
      department: normalizeText(columns[4]),
      locality: normalizeText(columns[7]),
      lat: normalizeCoordinate(columns[5]),
      lng: normalizeCoordinate(columns[6]),
    };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const csvArg = args.find((arg) => !arg.startsWith('--'));
  const csvPath = path.resolve(csvArg || DEFAULT_CSV_PATH);

  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV no encontrado: ${csvPath}`);
  }

  const rows = parseCsv(csvPath);
  console.log(`Procesando ${rows.length} plantas desde ${csvPath}`);

  if (dryRun) {
    console.log('Dry run: no se escriben datos en la base.');
    console.log(JSON.stringify(rows.slice(0, 5), null, 2));
    return;
  }

  let upserted = 0;

  for (const row of rows) {
    if (row.objectId === null) {
      console.warn(`Fila omitida sin objectId: ${row.name}`);
      continue;
    }

    await prisma.tolvinkPlant.upsert({
      where: { sourceRowId: row.objectId },
      update: {
        sourcePlantId: row.sourcePlantId,
        name: row.name,
        altName: row.altName,
        department: row.department,
        locality: row.locality,
        lat: row.lat,
        lng: row.lng,
        active: true,
      },
      create: {
        sourceRowId: row.objectId,
        sourcePlantId: row.sourcePlantId,
        name: row.name,
        altName: row.altName,
        department: row.department,
        locality: row.locality,
        lat: row.lat,
        lng: row.lng,
        active: true,
      },
    });

    upserted += 1;
  }

  console.log(`TolvinkPlant seed completo: ${upserted} registros insertados/actualizados.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
