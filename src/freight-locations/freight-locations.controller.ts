import {
  Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Res, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { IsEnum, IsNumber, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { FreightAccessGuard } from '../common/guards/freight-access.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { FreightLocationsService } from './freight-locations.service';

class SaveFreightLocationDto {
  @IsEnum(['ORIGIN', 'DESTINATION', 'POINT_OF_INTEREST', 'LOAD_LOCATION', 'UNLOAD_LOCATION', 'OPERATIONAL_REFERENCE', 'OTHER'])
  type: any;

  @IsNumber()
  lat: number;

  @IsNumber()
  lng: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsUUID()
  companyId?: string;

  @IsOptional()
  @IsEnum(['BROWSER_CURRENT', 'PIN_MANUAL', 'SEARCH', 'WHATSAPP_NATIVE', 'UNKNOWN'])
  inputMethod?: any;
}

class CreateMapLinkDto {
  @IsOptional()
  @IsEnum(['read', 'edit'])
  mode?: 'read' | 'edit';

  @IsOptional()
  @IsEnum(['WEB_APP', 'SHARED_LINK', 'WHATSAPP_AGENT'])
  source?: 'WEB_APP' | 'SHARED_LINK' | 'WHATSAPP_AGENT';

  @IsOptional()
  @IsString()
  @MaxLength(80)
  purpose?: string;
}

@ApiTags('Freight Map')
@Controller()
export class FreightLocationsController {
  constructor(private service: FreightLocationsService) {}

  @Get('freights/:id/map')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, FreightAccessGuard)
  @Roles('producer', 'plant', 'transporter', 'chofer', 'platform_admin')
  @ApiOperation({ summary: 'Datos de mapa de un flete autenticado' })
  getAuthenticatedMap(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.getAuthenticatedMapData(id, user);
  }

  @Post('freights/:id/map/locations')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, FreightAccessGuard)
  @Roles('producer', 'plant', 'transporter', 'chofer', 'platform_admin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Guardar ubicacion operativa de flete autenticada' })
  saveAuthenticatedLocation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveFreightLocationDto,
    @CurrentUser() user: any,
  ) {
    return this.service.saveAuthenticatedLocation(id, user, dto as any);
  }

  @Post('freights/:id/map-link')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, FreightAccessGuard)
  @Roles('producer', 'plant', 'transporter', 'chofer', 'platform_admin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Crear link compartible de mapa para un flete' })
  createMapLink(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateMapLinkDto,
    @CurrentUser() user: any,
  ) {
    return this.service.createMapLink(id, user, {
      mode: dto.mode || 'edit',
      source: dto.source || 'WEB_APP',
      purpose: dto.purpose,
    });
  }
}

@ApiTags('Freight Map Public')
@Controller('freight-map')
export class FreightMapPublicController {
  constructor(private service: FreightLocationsService) {}

  @Get(':token')
  @ApiOperation({ summary: 'Pagina movil de mapa compartible' })
  async page(@Param('token') token: string, @Res() res: Response) {
    await this.service.getTokenMapData(token);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(this.renderPage(token));
  }

  @Get(':token/data')
  @ApiOperation({ summary: 'Datos JSON de mapa compartible' })
  data(@Param('token') token: string) {
    return this.service.getTokenMapData(token);
  }

  @Post(':token/locations')
  @HttpCode(200)
  @ApiOperation({ summary: 'Guardar ubicacion desde mapa compartible' })
  save(@Param('token') token: string, @Body() dto: SaveFreightLocationDto) {
    return this.service.saveTokenLocation(token, dto as any);
  }

  private renderPage(token: string): string {
    return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Tolvink - Mapa de flete</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <style>
    :root { --ink:#17211b; --muted:#5c675f; --line:#d8ded5; --bg:#f5f7f3; --green:#23633f; --amber:#b86e12; --blue:#2563a9; --red:#a33a2b; --violet:#7257a8; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Inter, Arial, sans-serif; color:var(--ink); background:var(--bg); }
    main { min-height:100vh; display:grid; grid-template-rows:auto minmax(360px, 1fr) auto; }
    header { padding:14px 14px 10px; background:#fff; border-bottom:1px solid var(--line); }
    h1 { margin:0; font-size:20px; line-height:1.2; }
    .meta { margin-top:6px; color:var(--muted); font-size:13px; display:flex; gap:8px; flex-wrap:wrap; }
    #map { min-height:380px; background:#dce5da; }
    .panel { background:#fff; border-top:1px solid var(--line); padding:12px 14px 16px; display:grid; gap:10px; }
    .toolbar { display:grid; grid-template-columns:1fr auto; gap:8px; }
    input, select, textarea { width:100%; border:1px solid #c9d3c7; border-radius:7px; padding:11px; font-size:15px; background:#fff; color:var(--ink); }
    textarea { min-height:58px; resize:vertical; }
    button { border:0; border-radius:7px; padding:11px 13px; font-weight:700; font-size:15px; color:#fff; background:var(--green); }
    button.secondary { background:#e8ede5; color:var(--ink); }
    button:disabled { opacity:.55; }
    .grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .legend { display:flex; gap:8px; overflow:auto; padding-bottom:2px; }
    .chip { white-space:nowrap; display:inline-flex; align-items:center; gap:6px; color:var(--muted); font-size:12px; }
    .dot { width:10px; height:10px; border-radius:999px; display:inline-block; }
    .list { display:grid; gap:7px; max-height:170px; overflow:auto; }
    .item { border:1px solid var(--line); border-radius:7px; padding:9px; font-size:13px; }
    .item strong { display:block; font-size:14px; }
    .status { min-height:20px; color:var(--muted); font-size:13px; }
    @media (min-width: 840px) {
      main { grid-template-columns: minmax(360px, 430px) 1fr; grid-template-rows:auto 1fr; }
      header { grid-column:1 / -1; }
      #map { grid-column:2; grid-row:2; min-height:calc(100vh - 76px); }
      .panel { grid-column:1; grid-row:2; border-top:0; border-right:1px solid var(--line); overflow:auto; }
    }
  </style>
</head>
<body>
<main>
  <header>
    <h1 id="title">Mapa de flete</h1>
    <div class="meta"><span id="status">Cargando...</span><span id="route"></span></div>
  </header>
  <div id="map"></div>
  <section class="panel">
    <div class="legend" id="legend"></div>
    <div class="toolbar">
      <input id="search" placeholder="Buscar dirección o lugar" />
      <button type="button" class="secondary" id="searchBtn">Buscar</button>
    </div>
    <div class="grid">
      <button type="button" class="secondary" id="gpsBtn">Usar ubicación actual</button>
      <button type="button" class="secondary" id="centerBtn">Ver todo</button>
    </div>
    <select id="type">
      <option value="LOAD_LOCATION">Ubicación de carga</option>
      <option value="UNLOAD_LOCATION">Ubicación de descarga</option>
      <option value="ORIGIN">Origen</option>
      <option value="DESTINATION">Destino</option>
      <option value="POINT_OF_INTEREST">Punto de interés</option>
      <option value="OPERATIONAL_REFERENCE">Referencia operativa</option>
      <option value="OTHER">Otro</option>
    </select>
    <input id="label" maxlength="255" placeholder="Nombre visible, ej: Portera norte" />
    <textarea id="description" maxlength="2000" placeholder="Descripción opcional"></textarea>
    <div class="grid">
      <input id="lat" inputmode="decimal" placeholder="Latitud" />
      <input id="lng" inputmode="decimal" placeholder="Longitud" />
    </div>
    <button type="button" id="saveBtn">Guardar ubicación</button>
    <div class="status" id="msg"></div>
    <div class="list" id="locations"></div>
  </section>
</main>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const token = ${JSON.stringify(token)};
const colors = {
  ORIGIN:'#23633f', DESTINATION:'#a33a2b', POINT_OF_INTEREST:'#7257a8',
  LOAD_LOCATION:'#b86e12', UNLOAD_LOCATION:'#2563a9', OPERATIONAL_REFERENCE:'#45524a',
  OTHER:'#6b7280', CURRENT:'#0f766e'
};
const labels = {
  ORIGIN:'Origen', DESTINATION:'Destino', POINT_OF_INTEREST:'Punto de interés',
  LOAD_LOCATION:'Carga', UNLOAD_LOCATION:'Descarga', OPERATIONAL_REFERENCE:'Referencia',
  OTHER:'Otro', CURRENT:'Actual'
};
let data, map, draftMarker, markers = [], inputMethod = 'PIN_MANUAL';
const el = id => document.getElementById(id);
function setMsg(text) { el('msg').textContent = text || ''; }
function icon(type) {
  const c = colors[type] || colors.OTHER;
  return L.divIcon({ className:'', html:'<span style="display:block;width:18px;height:18px;border-radius:50%;background:'+c+';border:3px solid white;box-shadow:0 1px 5px #0005"></span>', iconSize:[18,18], iconAnchor:[9,9] });
}
function setDraft(lat, lng, zoom) {
  el('lat').value = Number(lat).toFixed(6);
  el('lng').value = Number(lng).toFixed(6);
  draftMarker.setLatLng([lat, lng]);
  if (zoom) map.setView([lat, lng], zoom);
}
function addPoint(point, typeOverride) {
  if (!point) return;
  const type = typeOverride || point.type;
  const m = L.marker([point.lat, point.lng], { icon: icon(type) }).addTo(map);
  m.bindPopup('<strong>'+ (labels[type] || type) +'</strong><br>'+ (point.label || '') + (point.companyName ? '<br>'+point.companyName : ''));
  markers.push(m);
}
function fitAll() {
  const pts = markers.map(m => m.getLatLng());
  if (draftMarker) pts.push(draftMarker.getLatLng());
  if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.25));
}
function render() {
  const f = data.freight;
  el('title').textContent = 'Flete ' + f.code;
  el('status').textContent = 'Estado: ' + f.status;
  el('route').textContent = f.originName + ' → ' + f.destName;
  el('saveBtn').disabled = !data.permissions.canEdit;
  if (!data.permissions.canEdit) setMsg('Este enlace es de solo lectura.');
  el('legend').innerHTML = Object.keys(labels).map(k => '<span class="chip"><span class="dot" style="background:'+colors[k]+'"></span>'+labels[k]+'</span>').join('');
  markers.forEach(m => m.remove()); markers = [];
  addPoint(f.origin, 'ORIGIN');
  addPoint(f.destination, 'DESTINATION');
  data.locations.forEach(p => addPoint(p));
  data.liveLocations.forEach(p => addPoint(p, 'CURRENT'));
  const start = f.origin || f.destination || data.locations[0] || { lat:-32.5228, lng:-55.7658 };
  if (!draftMarker) {
    draftMarker = L.marker([start.lat, start.lng], { draggable:true, icon: icon('OTHER') }).addTo(map);
    draftMarker.on('dragend', () => { const p = draftMarker.getLatLng(); inputMethod = 'PIN_MANUAL'; setDraft(p.lat, p.lng); });
  }
  setDraft(start.lat, start.lng);
  el('locations').innerHTML = data.locations.length ? data.locations.map(p =>
    '<div class="item"><strong>'+labels[p.type]+' · '+(p.label || p.address || 'Sin nombre')+'</strong>'+p.companyName+' · '+p.userName+'<br>'+new Date(p.createdAt).toLocaleString()+'</div>'
  ).join('') : '<div class="item">Todavía no hay ubicaciones registradas.</div>';
  fitAll();
}
async function load() {
  data = await fetch('/api/freight-map/'+encodeURIComponent(token)+'/data').then(r => {
    if (!r.ok) throw new Error('No se pudo abrir el mapa');
    return r.json();
  });
  render();
}
map = L.map('map').setView([-32.5228, -55.7658], 7);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19, attribution:'&copy; OpenStreetMap' }).addTo(map);
map.on('click', e => { inputMethod = 'PIN_MANUAL'; setDraft(e.latlng.lat, e.latlng.lng); });
el('centerBtn').onclick = fitAll;
el('gpsBtn').onclick = () => {
  if (!navigator.geolocation) return setMsg('Tu navegador no permite geolocalización.');
  setMsg('Buscando ubicación actual...');
  navigator.geolocation.getCurrentPosition(pos => {
    inputMethod = 'BROWSER_CURRENT';
    setDraft(pos.coords.latitude, pos.coords.longitude, 16);
    setMsg('Ubicación actual cargada. Revisá y guardá.');
  }, () => setMsg('No se pudo obtener ubicación actual. Marcá el punto manualmente.'), { enableHighAccuracy:true, timeout:12000 });
};
el('searchBtn').onclick = async () => {
  const q = el('search').value.trim();
  if (!q) return;
  setMsg('Buscando lugar...');
  const res = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q='+encodeURIComponent(q + ', Uruguay')).then(r => r.json()).catch(() => []);
  if (!res.length) return setMsg('No encontré ese lugar. Probá mover el pin.');
  inputMethod = 'SEARCH';
  el('label').value = el('label').value || q;
  setDraft(Number(res[0].lat), Number(res[0].lon), 15);
  setMsg('Lugar encontrado. Confirmá antes de guardar.');
};
el('saveBtn').onclick = async () => {
  if (!data.permissions.canEdit) return;
  const payload = {
    type: el('type').value,
    lat: Number(el('lat').value),
    lng: Number(el('lng').value),
    label: el('label').value.trim(),
    description: el('description').value.trim(),
    inputMethod
  };
  if (!Number.isFinite(payload.lat) || !Number.isFinite(payload.lng)) return setMsg('Coordenadas inválidas.');
  if (!confirm('Guardar '+labels[payload.type]+' en '+payload.lat.toFixed(6)+', '+payload.lng.toFixed(6)+'?')) return;
  setMsg('Guardando...');
  const saved = await fetch('/api/freight-map/'+encodeURIComponent(token)+'/locations', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body: JSON.stringify(payload)
  });
  if (!saved.ok) return setMsg('No se pudo guardar. Revisá permisos o enlace.');
  setMsg('Ubicación guardada.');
  await load();
};
load().catch(err => {
  document.body.innerHTML = '<main style="padding:20px;font-family:Arial"><h1>No se pudo abrir el mapa</h1><p>'+err.message+'</p></main>';
});
</script>
</body>
</html>`;
  }
}
