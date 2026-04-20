import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const GOOGLE_MAPS_API_KEY =
  process.env.GOOGLE_MAPS_API_KEY ||
  process.env.GOOGLE_PLACES_API_KEY ||
  '';

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const LOCALITY_TYPE_PRIORITY = [
  'locality',
  'postal_town',
  'administrative_area_level_3',
  'administrative_area_level_4',
  'neighborhood',
  'sublocality',
  'sublocality_level_1',
] as const;

type GoogleAddressComponent = {
  long_name: string;
  short_name: string;
  types: string[];
};

type GoogleGeocodeResult = {
  address_components: GoogleAddressComponent[];
  formatted_address: string;
  geometry?: {
    location?: {
      lat: number;
      lng: number;
    };
  };
  types: string[];
};

type GoogleGeocodeResponse = {
  results?: GoogleGeocodeResult[];
  status: string;
  error_message?: string;
};

type PlantRecord = {
  id: string;
  name: string;
  altName: string | null;
  department: string | null;
  locality: string | null;
  lat: unknown;
  lng: unknown;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeText(value: string | null | undefined): string | null {
  const normalized = (value || '').trim().replace(/\s+/g, ' ');
  return normalized || null;
}

function buildAddressCandidates(plant: PlantRecord): string[] {
  const candidates = [
    [plant.name, plant.department, 'Uruguay'].filter(Boolean).join(', '),
    [plant.altName, plant.department, 'Uruguay'].filter(Boolean).join(', '),
    [plant.name, 'Uruguay'].filter(Boolean).join(', '),
    [plant.altName, 'Uruguay'].filter(Boolean).join(', '),
  ];

  return [...new Set(candidates.map(normalizeText).filter(Boolean) as string[])];
}

function getComponentByPriority(components: GoogleAddressComponent[]): string | null {
  for (const type of LOCALITY_TYPE_PRIORITY) {
    const match = components.find((component) => component.types.includes(type));
    if (match?.long_name) return normalizeText(match.long_name);
  }
  return null;
}

async function callGeocodingApi(params: Record<string, string>): Promise<GoogleGeocodeResponse> {
  const url = new URL(GEOCODE_URL);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  url.searchParams.set('key', GOOGLE_MAPS_API_KEY);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Google Maps devolvio HTTP ${response.status}`);
  }

  const data = (await response.json()) as GoogleGeocodeResponse;
  if (data.status === 'REQUEST_DENIED') {
    throw new Error(data.error_message || 'Google Maps rechazo la request. Habilita Geocoding API en la misma API key.');
  }
  if (data.status === 'OVER_QUERY_LIMIT') {
    throw new Error('Google Maps devolvio OVER_QUERY_LIMIT. Revisa cuota o rate limit.');
  }

  return data;
}

async function geocodePlant(plant: PlantRecord): Promise<{ lat: number; lng: number } | null> {
  const candidates = buildAddressCandidates(plant);

  for (const address of candidates) {
    const data = await callGeocodingApi({
      address,
      language: 'es',
      region: 'uy',
      components: 'country:UY',
    });

    if (data.status !== 'OK' || !data.results?.length) {
      await sleep(120);
      continue;
    }

    const location = data.results[0]?.geometry?.location;
    if (location?.lat != null && location?.lng != null) {
      return { lat: location.lat, lng: location.lng };
    }
    await sleep(120);
  }

  return null;
}

async function reverseGeocodeLocality(lat: number, lng: number): Promise<string | null> {
  const data = await callGeocodingApi({
    latlng: `${lat},${lng}`,
    language: 'es',
    region: 'uy',
    result_type: LOCALITY_TYPE_PRIORITY.join('|'),
  });

  if (data.status !== 'OK' || !data.results?.length) {
    return null;
  }

  for (const result of data.results) {
    const byComponents = getComponentByPriority(result.address_components || []);
    if (byComponents) return byComponents;
  }

  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const onlyMissing = args.includes('--only-missing');
  const limitArg = args.find((arg) => arg.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : null;

  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error('Falta GOOGLE_MAPS_API_KEY o GOOGLE_PLACES_API_KEY en el entorno.');
  }

  const where = onlyMissing
    ? {
        active: true,
        OR: [
          { locality: null },
          { lat: null },
          { lng: null },
        ],
      }
    : { active: true };

  const plants = await prisma.tolvinkPlant.findMany({
    where,
    select: {
      id: true,
      name: true,
      altName: true,
      department: true,
      locality: true,
      lat: true,
      lng: true,
    },
    orderBy: { name: 'asc' },
    ...(limit ? { take: limit } : {}),
  });

  console.log(`Procesando ${plants.length} plantas Tolvink${dryRun ? ' (dry-run)' : ''}.`);

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const plant of plants as PlantRecord[]) {
    try {
      let lat = toNumber(plant.lat);
      let lng = toNumber(plant.lng);
      let locality = normalizeText(plant.locality);

      if (lat == null || lng == null) {
        const geocoded = await geocodePlant(plant);
        if (geocoded) {
          lat = geocoded.lat;
          lng = geocoded.lng;
        }
      }

      if (lat != null && lng != null && !locality) {
        locality = await reverseGeocodeLocality(lat, lng);
      }

      const changed =
        lat !== toNumber(plant.lat) ||
        lng !== toNumber(plant.lng) ||
        locality !== normalizeText(plant.locality);

      if (!changed) {
        skipped += 1;
        continue;
      }

      if (dryRun) {
        console.log(JSON.stringify({
          id: plant.id,
          name: plant.name,
          locality,
          lat,
          lng,
        }));
      } else {
        await prisma.tolvinkPlant.update({
          where: { id: plant.id },
          data: {
            locality,
            lat,
            lng,
          },
        });
      }

      updated += 1;
      await sleep(120);
    } catch (error: any) {
      failed += 1;
      console.error(`Error enriqueciendo ${plant.name}: ${error?.message || error}`);
    }
  }

  console.log(JSON.stringify({ updated, skipped, failed, dryRun }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
