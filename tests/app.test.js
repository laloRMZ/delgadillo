const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAppServer } = require('../server');

describe('CampoCheck PWA - Pruebas de Servidor, API y SSR', () => {
  let server;
  let baseUrl;
  let tempDir;
  let tempDataFile;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campocheck-test-'));
    tempDataFile = path.join(tempDir, 'reports.json');
    fs.writeFileSync(
      tempDataFile,
      JSON.stringify([
        {
          id: 'rep-seed-1',
          title: 'Inspección inicial',
          category: 'Infraestructura',
          location: 'Planta 1',
          description: 'Registro semilla de prueba',
          status: 'pendiente',
          photo: null,
          coords: null,
          inspector: 'Tester',
          createdAt: '2026-11-24T10:00:00.000Z'
        }
      ]),
      'utf8'
    );

    server = createAppServer({ dataFile: tempDataFile });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('GET / sirve el App Shell HTML con enlace al manifest', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /CampoCheck PWA/);
    assert.match(html, /rel="manifest"/);
  });

  it('GET /manifest.json sirve el Web App Manifest válido', async () => {
    const res = await fetch(`${baseUrl}/manifest.json`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/manifest\+json/);
    const manifest = await res.json();
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.start_url, '/');
    assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0);
  });

  it('GET /sw.js y /pwa.png están disponibles para el Service Worker', async () => {
    const swRes = await fetch(`${baseUrl}/sw.js`);
    assert.equal(swRes.status, 200);
    assert.match(swRes.headers.get('content-type'), /javascript/);

    const iconRes = await fetch(`${baseUrl}/pwa.png`);
    assert.equal(iconRes.status, 200);
    assert.equal(iconRes.headers.get('content-type'), 'image/png');
  });

  it('GET /api/health responde estado ok', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'ok');
  });

  it('Flujo completo CRUD en /api/reports (GET, POST, PATCH, DELETE)', async () => {
    // GET inicial
    const listRes = await fetch(`${baseUrl}/api/reports`);
    assert.equal(listRes.status, 200);
    const initial = await listRes.json();
    assert.equal(initial.length, 1);

    // POST nuevo reporte
    const createRes = await fetch(`${baseUrl}/api/reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Prueba de cámara y offline',
        category: 'Seguridad',
        location: 'Almacén B',
        description: 'Evidencia generada en test',
        photo: 'data:image/png;base64,iVBORw0KGgo='
      })
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.equal(created.title, 'Prueba de cámara y offline');
    assert.equal(created.status, 'pendiente');

    // PATCH cambiar estado
    const patchRes = await fetch(`${baseUrl}/api/reports/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'resuelto' })
    });
    assert.equal(patchRes.status, 200);
    const updated = await patchRes.json();
    assert.equal(updated.status, 'resuelto');

    // DELETE eliminar
    const delRes = await fetch(`${baseUrl}/api/reports/${created.id}`, {
      method: 'DELETE'
    });
    assert.equal(delRes.status, 200);
  });

  it('GET /ssr-reportes renderiza HTML desde el servidor con los datos actuales', async () => {
    const res = await fetch(`${baseUrl}/ssr-reportes`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /Vista SSR/);
    assert.match(html, /Inspección inicial/);
  });

  it('Bloquea acceso fuera de public/ (Path Traversal)', async () => {
    const res = await fetch(`${baseUrl}/../package.json`);
    assert.ok(res.status === 403 || res.status === 404);
  });
});
