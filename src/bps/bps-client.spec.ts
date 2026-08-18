import { detectarCaptcha, parseNomina, parseObligaciones, parseObservaciones, parseVigencia } from './bps-client';

describe('bps-client parsers', () => {
  describe('parseVigencia', () => {
    it('detecta certificado vigente con fecha', () => {
      const html = `<html><body><p>La empresa POSEE certificado común vigente.</p>
        <span>Vigente hasta: 30/11/2026</span></body></html>`;
      const r = parseVigencia(html);
      expect(r.estado).toBe('VIGENTE');
      expect(r.vigenteHasta?.toISOString().slice(0, 10)).toBe('2026-11-30');
    });

    it('detecta no vigente (la negación gana sobre la frase positiva)', () => {
      const r = parseVigencia('<body>El contribuyente NO posee certificado común vigente</body>');
      expect(r.estado).toBe('NO_VIGENTE');
    });

    it('detecta en trámite', () => {
      expect(parseVigencia('<body>Solicitud en trámite de emisión</body>').estado).toBe('EN_TRAMITE');
    });

    it('markup desconocido → DESCONOCIDO, nunca inventa estado', () => {
      expect(parseVigencia('<body><h1>Error 500</h1></body>').estado).toBe('DESCONOCIDO');
      expect(parseVigencia('').estado).toBe('DESCONOCIDO');
    });
  });

  describe('parseObservaciones', () => {
    it('sin observaciones → OK', () => {
      expect(parseObservaciones('<body>La empresa no registra observaciones</body>').estado).toBe('OK');
    });
    it('tabla de observaciones → ATENCION con detalle', () => {
      const html = `<body><h2>Observaciones</h2><table>
        <tr><th>Detalle</th></tr>
        <tr><td>Declaración jurada pendiente 06/2026</td></tr>
        <tr><td>Deuda convenio cuota 3</td></tr>
      </table></body>`;
      const r = parseObservaciones(html);
      expect(r.estado).toBe('ATENCION');
      expect(r.detalle.items).toHaveLength(2);
    });
    it('markup roto → DESCONOCIDO', () => {
      expect(parseObservaciones('<body>???</body>').estado).toBe('DESCONOCIDO');
    });
  });

  describe('parseObligaciones', () => {
    it('al día → OK', () => {
      expect(parseObligaciones('<body>No registra obligaciones pendientes</body>').estado).toBe('OK');
    });
    it('deuda → ATENCION', () => {
      const html = `<body>Obligaciones pendientes de pago<table>
        <tr><th>Vencimiento</th><th>Importe</th></tr>
        <tr><td>25/08/2026</td><td>$ 45.300</td></tr>
      </table></body>`;
      const r = parseObligaciones(html);
      expect(r.estado).toBe('ATENCION');
      expect(r.detalle.items).toHaveLength(1);
    });
    it('markup roto → DESCONOCIDO', () => {
      expect(parseObligaciones('<body>bienvenido</body>').estado).toBe('DESCONOCIDO');
    });
  });

  describe('parseNomina', () => {
    it('presentada → OK', () => {
      expect(parseNomina('<body>Declaración presentada correctamente</body>').estado).toBe('OK');
    });
    it('observada → ATENCION', () => {
      expect(parseNomina('<body>Su declaración de nómina fue observada</body>').estado).toBe('ATENCION');
    });
    it('markup roto → DESCONOCIDO', () => {
      expect(parseNomina('<body>...</body>').estado).toBe('DESCONOCIDO');
    });
  });

  it('detectarCaptcha', () => {
    expect(detectarCaptcha('<div class="g-recaptcha"></div>')).toBe(true);
    expect(detectarCaptcha('<body>formulario normal</body>')).toBe(false);
  });
});
