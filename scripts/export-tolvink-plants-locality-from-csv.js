const fs = require('fs');
const path = require('path');

const GOOGLE_MAPS_API_KEY =
  process.env.GOOGLE_MAPS_API_KEY ||
  process.env.GOOGLE_PLACES_API_KEY ||
  '';

const DEFAULT_INPUT =
  process.env.TOLVINK_PLANTS_CSV_PATH ||
  'C:\\Users\\Usuario\\Downloads\\INSTALACIONES_ACOPIO_GRANOS_2017 (3).csv';

const DEFAULT_OUTPUT = path.resolve(process.cwd(), 'tolvink-plants-with-locality.csv');

const LOCALITY_TYPE_PRIORITY = [
  'locality',
  'postal_town',
  'administrative_area_level_3',
  'administrative_area_level_4',
  'neighborhood',
  'sublocality',
  'sublocality_level_1',
];

function normalizeText(value) {
  const normalized = String(value || '').replace(/\uFEFF/g, '').trim().replace(/\s+/g, ' ');
  return normalized.length ? normalized : null;
}

function normalizeCoordinate(raw) {
  const value = normalizeText(raw);
  if (!value) return null;

  const negative = value.includes('-');
  const digits = value.replace(/\D/g, '');
  if (digits.length < 3) return null;

  const numeric = Number(`${negative ? '-' : ''}${digits.slice(0, 2)}.${digits.slice(2)}`);
  if (!Number.isFinite(numeric)) return null;

  return numeric.toFixed(6);
}

function splitSemicolonLine(line) {
  return line.split(';');
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (!/[;"\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function getLocalityFromComponents(components) {
  for (const type of LOCALITY_TYPE_PRIORITY) {
    const match = (components || []).find((component) => Array.isArray(component.types) && component.types.includes(type));
    if (match && match.long_name) return normalizeText(match.long_name);
  }
  return null;
}

async function reverseGeocodeLocality(lat, lng) {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('latlng', `${lat},${lng}`);
  url.searchParams.set('language', 'es');
  url.searchParams.set('region', 'uy');
  url.searchParams.set('key', GOOGLE_MAPS_API_KEY);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (payload.status !== 'OK') {
    if (payload.status === 'ZERO_RESULTS') return null;
    throw new Error(payload.error_message || payload.status || 'Error desconocido de Google Maps');
  }

  for (const result of payload.results || []) {
    const locality = getLocalityFromComponents(result.address_components || []);
    if (locality) return locality;
  }

  return null;
}

async function mapLimit(items, limit, iterator) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index++;
      results[currentIndex] = await iterator(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const inputPath = path.resolve(args[0] || DEFAULT_INPUT);
  const outputPath = path.resolve(args[1] || DEFAULT_OUTPUT);

  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error('Falta GOOGLE_MAPS_API_KEY o GOOGLE_PLACES_API_KEY en el entorno.');
  }

  if (!fs.existsSync(inputPath)) {
    throw new Error(`CSV no encontrado: ${inputPath}`);
  }

  const raw = fs.readFileSync(inputPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length <= 1) {
    throw new Error('El CSV no tiene filas de datos.');
  }

  const header = splitSemicolonLine(lines[0]);
  const rows = lines.slice(1).map((line) => splitSemicolonLine(line));
  const coordCache = new Map();

  const enrichedRows = await mapLimit(rows, 5, async (columns, rowIndex) => {
    const lat = normalizeCoordinate(columns[5]);
    const lng = normalizeCoordinate(columns[6]);
    let locality = '';

    if (lat && lng) {
      const cacheKey = `${lat},${lng}`;
      if (!coordCache.has(cacheKey)) {
        coordCache.set(cacheKey, reverseGeocodeLocality(lat, lng).catch((error) => {
          console.error(`Fila ${rowIndex + 2}: ${error.message}`);
          return null;
        }));
      }
      locality = (await coordCache.get(cacheKey)) || '';
    }

    return [...columns, locality];
  });

  const outputLines = [
    [...header, 'localidad'].map(csvEscape).join(';'),
    ...enrichedRows.map((columns) => columns.map(csvEscape).join(';')),
  ];

  fs.writeFileSync(outputPath, `${outputLines.join('\n')}\n`, 'utf8');
  console.log(`Archivo generado: ${outputPath}`);
  console.log(`Filas procesadas: ${enrichedRows.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
