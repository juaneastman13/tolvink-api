import {
  Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Res, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import { Response } from 'express';
import { ArrayMaxSize, IsArray, IsEnum, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { FreightAccessGuard } from '../common/guards/freight-access.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { FreightLocationsService } from './freight-locations.service';

const LOCATION_TYPE_VALUES = ['ORIGIN', 'DESTINATION', 'POINT_OF_INTEREST', 'LOAD_LOCATION', 'UNLOAD_LOCATION', 'OPERATIONAL_REFERENCE', 'OTHER'] as const;

class SaveFreightLocationDto {
  @IsEnum(LOCATION_TYPE_VALUES)
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

class CreatePublicMapLinkDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @IsEnum(LOCATION_TYPE_VALUES, { each: true })
  allowedTypes?: any[];

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(7 * 24 * 60)
  ttlMinutes?: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  purpose?: string;
}

class SavePublicLocationDto {
  @IsEnum(LOCATION_TYPE_VALUES)
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
  @IsEnum(['BROWSER_CURRENT', 'PIN_MANUAL', 'SEARCH', 'WHATSAPP_NATIVE', 'UNKNOWN'])
  inputMethod?: any;
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

  @Post('freights/:id/public-map-link')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, FreightAccessGuard)
  @Roles('producer', 'plant', 'transporter', 'platform_admin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Crear link publico (sin auth) para indicar ubicaciones de un flete' })
  createPublicMapLink(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreatePublicMapLinkDto,
    @CurrentUser() user: any,
  ) {
    return this.service.createPublicMapLink(id, {
      allowedTypes: dto.allowedTypes,
      ttlMinutes: dto.ttlMinutes,
      purpose: dto.purpose,
      createdByUserId: user?.id || user?.sub,
    });
  }
}

@ApiTags('Freight Map Public (Anonymous)')
@Controller('freight-map-public')
export class FreightMapPublicAnonController {
  constructor(private service: FreightLocationsService) {}

  @Get(':token')
  @SkipThrottle()
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @ApiOperation({ summary: 'Pagina movil de mapa publico anonimo' })
  async page(@Param('token') token: string, @Res() res: Response) {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(renderMapPage(token, '/api/freight-map-public', this.service.getGoogleMapsKey()));
  }

  @Get(':token/data')
  @SkipThrottle()
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @ApiOperation({ summary: 'Datos del mapa publico anonimo' })
  data(@Param('token') token: string) {
    return this.service.getPublicMapData(token);
  }

  @Post(':token/locations')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @HttpCode(200)
  @ApiOperation({ summary: 'Guardar ubicacion publica anonima' })
  save(@Param('token') token: string, @Body() dto: SavePublicLocationDto) {
    return this.service.savePublicLocation(token, dto as any);
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
    res.send(renderMapPage(token, '/api/freight-map', this.service.getGoogleMapsKey()));
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

}

function renderMapPage(token: string, apiBasePath: string, mapsKey: string): string {
  return renderGoogleMapPage(token, apiBasePath, mapsKey);
}

function renderGoogleMapPage(token: string, apiBasePath: string, mapsKey: string): string {
  const mapsScript = mapsKey
    ? `<script async defer src="https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(mapsKey)}&libraries=places&callback=initMap"></script>`
    : '';
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Tolvink - Mapa de flete</title>
  <style>
    :root { --ink:#17211b; --muted:#5c675f; --line:#d8ded5; --bg:#f5f7f3; --green:#23633f; --green-dark:#164c33; --panel:#fff; --danger:#a24a2b; --amber:#b86e12; --blue:#2563a9; --red:#a33a2b; --violet:#7257a8; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color:var(--ink); background:var(--bg); }
    main { min-height:100vh; display:grid; grid-template-rows:auto minmax(360px,1fr) auto; }
    header { padding:16px 18px 14px; background:var(--panel); border-bottom:1px solid var(--line); }
    .brand { display:flex; align-items:center; justify-content:space-between; gap:12px; max-width:1120px; margin:0 auto; }
    .brand-left { display:flex; align-items:center; gap:10px; min-width:0; }
    .brand-mark { display:grid; place-items:center; width:34px; height:34px; border-radius:8px; background:var(--green); color:#fff; font-weight:800; }
    h1 { margin:0; font-size:20px; line-height:1.2; }
    .meta { margin-top:4px; color:var(--muted); font-size:13px; display:flex; gap:8px; flex-wrap:wrap; }
    .pill { border:1px solid #b8cfbf; border-radius:999px; padding:6px 10px; color:var(--green-dark); background:#eef6f0; font-size:12px; font-weight:700; }
    #map { min-height:380px; background:#dce5da; }
    .map-empty { height:100%; display:grid; place-items:center; padding:24px; text-align:center; color:var(--muted); }
    .panel { background:var(--panel); border-top:1px solid var(--line); padding:12px 14px 16px; display:grid; gap:10px; box-shadow:0 -14px 30px rgba(23,33,27,.08); }
    label { display:block; font-size:12px; color:var(--muted); margin-bottom:5px; }
    input, textarea { width:100%; border:1px solid #c9d3c7; border-radius:8px; padding:12px 13px; font-size:15px; background:#fff; color:var(--ink); }
    textarea { min-height:58px; resize:vertical; }
    button { min-height:48px; border:0; border-radius:8px; padding:12px 14px; font-weight:800; font-size:15px; color:#fff; background:var(--green); cursor:pointer; }
    button.secondary { background:#e8ede5; color:var(--ink); }
    button:disabled { opacity:.55; cursor:default; }
    .grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .chips, .legend { display:flex; gap:8px; overflow:auto; padding-bottom:2px; }
    .chip { flex:0 0 auto; border:1px solid #c9d5ca; border-radius:999px; padding:9px 12px; background:#fff; color:var(--ink); font-weight:700; font-size:14px; }
    .chip.selected { border-color:var(--green); background:#e8f3ec; color:var(--green-dark); }
    .legend .chip { color:var(--muted); font-size:12px; padding:0; border:0; background:transparent; display:inline-flex; align-items:center; gap:6px; }
    .dot { width:10px; height:10px; border-radius:999px; display:inline-block; }
    .selection { padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:#fbfcfa; color:var(--muted); font-size:14px; line-height:1.35; }
    .list { display:grid; gap:7px; max-height:170px; overflow:auto; }
    .item { border:1px solid var(--line); border-radius:7px; padding:9px; font-size:13px; }
    .item strong { display:block; font-size:14px; }
    .status { min-height:20px; color:var(--muted); font-size:13px; }
    .status.error { color:var(--danger); }
    @media (min-width:840px) {
      main { grid-template-columns:minmax(360px,430px) 1fr; grid-template-rows:auto 1fr; }
      header { grid-column:1 / -1; }
      #map { grid-column:2; grid-row:2; min-height:calc(100vh - 76px); }
      .panel { grid-column:1; grid-row:2; border-top:0; border-right:1px solid var(--line); overflow:auto; }
    }
    @media (max-width:680px) {
      main { grid-template-rows:auto 46vh auto; }
      .grid { grid-template-columns:1fr; }
      .pill { display:none; }
    }
  </style>
</head>
<body>
<main>
  <header>
    <div class="brand">
      <div class="brand-left">
        <span class="brand-mark">T</span>
        <div>
          <h1 id="title">Mapa de flete</h1>
          <div class="meta"><span id="status">Cargando...</span><span id="route"></span></div>
        </div>
      </div>
      <span class="pill">Tolvink</span>
    </div>
  </header>
  <div id="map"><div class="map-empty">Cargando Google Maps...</div></div>
  <section class="panel">
    <div class="legend" id="legend"></div>
    <div>
      <label for="search">Buscar lugar o direccion</label>
      <input id="search" autocomplete="off" placeholder="Ej: Planta Nueva Palmira, Campo Ruta 3" />
    </div>
    <div>
      <label>Tipo de ubicacion</label>
      <div class="chips" id="typeChips"></div>
    </div>
    <div class="selection" id="selectedText">Todavia no marcaste un punto.</div>
    <div class="grid">
      <button type="button" class="secondary" id="gpsBtn">Usar ubicacion actual</button>
      <button type="button" class="secondary" id="centerBtn">Ver todo</button>
    </div>
    <input id="label" maxlength="255" placeholder="Nombre visible, ej: Portera norte" />
    <textarea id="description" maxlength="2000" placeholder="Descripcion opcional"></textarea>
    <button type="button" id="saveBtn">Guardar ubicacion</button>
    <div class="status" id="msg"></div>
    <div class="list" id="locations"></div>
  </section>
</main>
<script>
const token = ${JSON.stringify(token)};
const apiBasePath = ${JSON.stringify(apiBasePath)};
const hasMapsKey = ${JSON.stringify(Boolean(mapsKey))};
const colors = { ORIGIN:'#23633f', DESTINATION:'#a33a2b', POINT_OF_INTEREST:'#7257a8', LOAD_LOCATION:'#b86e12', UNLOAD_LOCATION:'#2563a9', OPERATIONAL_REFERENCE:'#45524a', OTHER:'#6b7280', CURRENT:'#0f766e' };
const labels = { ORIGIN:'Origen', DESTINATION:'Destino', POINT_OF_INTEREST:'Punto de interes', LOAD_LOCATION:'Carga', UNLOAD_LOCATION:'Descarga', OPERATIONAL_REFERENCE:'Referencia', OTHER:'Otro', CURRENT:'Actual' };
const typeOptions = [['LOAD_LOCATION','Ubicacion de carga'],['UNLOAD_LOCATION','Ubicacion de descarga'],['ORIGIN','Origen'],['DESTINATION','Destino'],['POINT_OF_INTEREST','Punto de interes'],['OPERATIONAL_REFERENCE','Referencia operativa'],['OTHER','Otro']];
let data, map, draftMarker, markers = [], inputMethod = 'PIN_MANUAL', selectedAddress = '', selectedLat = null, selectedLng = null;
let selectedTypes = new Set();
const el = id => document.getElementById(id);
function setMsg(text, isError) { el('msg').textContent = text || ''; el('msg').className = 'status' + (isError ? ' error' : ''); }
function selectedTypeLabels() { return typeOptions.filter(([value]) => selectedTypes.has(value)).map(([, label]) => label); }
function updateSelectedText() {
  const where = selectedAddress || (selectedLat == null ? 'Punto seleccionado en el mapa' : selectedLat.toFixed(6) + ', ' + selectedLng.toFixed(6));
  el('selectedText').textContent = selectedTypeLabels().join(', ') + ' - ' + where;
}
function renderTypeChips() {
  const allowedTypes = data.permissions.allowedTypes || typeOptions.map(([value]) => value);
  if (!selectedTypes.size) selectedTypes.add(allowedTypes[0] || 'OTHER');
  selectedTypes = new Set(Array.from(selectedTypes).filter((value) => allowedTypes.includes(value)));
  if (!selectedTypes.size) selectedTypes.add(allowedTypes[0] || 'OTHER');
  el('typeChips').innerHTML = '';
  typeOptions.filter(([value]) => allowedTypes.includes(value)).forEach(([value, label]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip' + (selectedTypes.has(value) ? ' selected' : '');
    btn.textContent = label;
    btn.onclick = () => {
      if (selectedTypes.has(value) && selectedTypes.size > 1) selectedTypes.delete(value);
      else selectedTypes.add(value);
      renderTypeChips();
      updateSelectedText();
    };
    el('typeChips').appendChild(btn);
  });
}
function markerIcon(type) {
  return { path: google.maps.SymbolPath.CIRCLE, scale:8, fillColor:colors[type] || colors.OTHER, fillOpacity:1, strokeColor:'#ffffff', strokeWeight:3 };
}
function setDraft(lat, lng, zoom, method, address) {
  selectedLat = Number(lat);
  selectedLng = Number(lng);
  inputMethod = method || inputMethod;
  selectedAddress = address || '';
  const position = { lat:selectedLat, lng:selectedLng };
  if (draftMarker) draftMarker.setPosition(position);
  if (map && zoom) map.setZoom(zoom);
  if (map) map.panTo(position);
  updateSelectedText();
}
function addPoint(point, typeOverride) {
  if (!point || !map) return;
  const type = typeOverride || point.type;
  const marker = new google.maps.Marker({ position:{ lat:Number(point.lat), lng:Number(point.lng) }, map, icon:markerIcon(type), title:(labels[type] || type) + ' ' + (point.label || '') });
  const info = new google.maps.InfoWindow({ content:'<strong>'+(labels[type] || type)+'</strong><br>'+(point.label || point.address || '') });
  marker.addListener('click', () => info.open({ anchor:marker, map }));
  markers.push(marker);
}
function fitAll() {
  if (!map) return;
  const bounds = new google.maps.LatLngBounds();
  markers.forEach(marker => bounds.extend(marker.getPosition()));
  if (draftMarker) bounds.extend(draftMarker.getPosition());
  if (!bounds.isEmpty()) map.fitBounds(bounds, 60);
}
function render() {
  const f = data.freight;
  el('title').textContent = 'Flete ' + f.code;
  el('status').textContent = 'Estado: ' + f.status;
  el('route').textContent = [f.originName, f.destName].filter(Boolean).join(' -> ');
  el('saveBtn').disabled = !data.permissions.canEdit;
  if (!data.permissions.canEdit) setMsg('Este enlace es de solo lectura.');
  renderTypeChips();
  el('legend').innerHTML = Object.keys(labels).map(k => '<span class="chip"><span class="dot" style="background:'+colors[k]+'"></span>'+labels[k]+'</span>').join('');
  markers.forEach(marker => marker.setMap(null)); markers = [];
  addPoint(f.origin, 'ORIGIN');
  addPoint(f.destination, 'DESTINATION');
  data.locations.forEach(point => addPoint(point));
  data.liveLocations.forEach(point => addPoint(point, 'CURRENT'));
  const start = f.origin || f.destination || data.locations[0] || { lat:-32.5228, lng:-55.7658 };
  if (!draftMarker && map) {
    draftMarker = new google.maps.Marker({ position:{ lat:Number(start.lat), lng:Number(start.lng) }, map, draggable:true, icon:markerIcon('OTHER'), title:'Ubicacion seleccionada' });
    draftMarker.addListener('dragend', e => setDraft(e.latLng.lat(), e.latLng.lng(), null, 'PIN_MANUAL'));
  }
  setDraft(start.lat, start.lng, null, 'PIN_MANUAL');
  el('locations').innerHTML = data.locations.length ? data.locations.map(point =>
    '<div class="item"><strong>'+(labels[point.type] || point.type)+' - '+(point.label || point.address || 'Sin nombre')+'</strong>'+[point.companyName, point.userName].filter(Boolean).join(' - ')+'<br>'+new Date(point.createdAt).toLocaleString()+'</div>'
  ).join('') : '<div class="item">Todavia no hay ubicaciones registradas.</div>';
  fitAll();
}
async function load() {
  data = await fetch(apiBasePath+'/'+encodeURIComponent(token)+'/data').then(r => {
    if (!r.ok) throw new Error('No se pudo abrir el mapa');
    return r.json();
  });
  render();
}
window.initMap = async function initMap() {
  const center = { lat:-32.5228, lng:-55.7658 };
  map = new google.maps.Map(el('map'), { center, zoom:7, mapTypeControl:false, streetViewControl:false, fullscreenControl:false, gestureHandling:'greedy' });
  map.addListener('click', e => setDraft(e.latLng.lat(), e.latLng.lng(), 16, 'PIN_MANUAL'));
  const autocomplete = new google.maps.places.Autocomplete(el('search'), { fields:['geometry', 'formatted_address', 'name'] });
  autocomplete.addListener('place_changed', () => {
    const place = autocomplete.getPlace();
    if (!place.geometry || !place.geometry.location) return setMsg('No pude ubicar ese lugar. Proba con otra busqueda.', true);
    if (!el('label').value.trim() && place.name) el('label').value = place.name;
    setDraft(place.geometry.location.lat(), place.geometry.location.lng(), 16, 'SEARCH', place.formatted_address || place.name || '');
    setMsg('');
  });
  await load().catch(err => {
    document.body.innerHTML = '<main style="padding:20px;font-family:Arial"><h1>No se pudo abrir el mapa</h1><p>'+err.message+'</p></main>';
  });
};
el('centerBtn').onclick = fitAll;
el('gpsBtn').onclick = () => {
  if (!navigator.geolocation) return setMsg('Tu navegador no permite geolocalizacion.', true);
  setMsg('Buscando ubicacion actual...');
  navigator.geolocation.getCurrentPosition(pos => {
    setDraft(pos.coords.latitude, pos.coords.longitude, 16, 'BROWSER_CURRENT');
    setMsg('Ubicacion actual cargada. Revisala y guarda.');
  }, () => setMsg('No se pudo obtener ubicacion actual. Marca el punto manualmente.', true), { enableHighAccuracy:true, timeout:12000 });
};
el('saveBtn').onclick = async () => {
  if (!data.permissions.canEdit) return;
  if (!Number.isFinite(selectedLat) || !Number.isFinite(selectedLng)) return setMsg('Selecciona un punto valido en el mapa.', true);
  const types = Array.from(selectedTypes);
  if (!types.length) return setMsg('Selecciona al menos un tipo de ubicacion.', true);
  if (!confirm('Guardar '+selectedTypeLabels().join(', ')+' en el punto seleccionado?')) return;
  setMsg('Guardando...');
  for (const type of types) {
    const saved = await fetch(apiBasePath+'/'+encodeURIComponent(token)+'/locations', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body: JSON.stringify({ type, lat:selectedLat, lng:selectedLng, label:el('label').value.trim(), address:selectedAddress || el('search').value.trim(), description:el('description').value.trim(), inputMethod })
    });
    if (!saved.ok) return setMsg('No se pudo guardar. Revisa permisos o enlace.', true);
  }
  setMsg('Ubicacion guardada.');
  await load();
};
if (!hasMapsKey) {
  el('map').innerHTML = '<div class="map-empty">No se pudo cargar Google Maps. Revisar la configuracion de Maps en el servidor.</div>';
  el('saveBtn').disabled = true;
  setMsg('El mapa no esta disponible en este momento.', true);
} else {
  window.gm_authFailure = () => {
    el('map').innerHTML = '<div class="map-empty">No se pudo autorizar Google Maps.</div>';
    el('saveBtn').disabled = true;
    setMsg('Google Maps no esta autorizado para este dominio.', true);
  };
}
</script>
${mapsScript}
</body>
</html>`;
}
