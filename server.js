const http = require('http');
const fs = require('fs');
const path = require('path');

const DEFAULT_PORT = process.env.PORT || 8000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_DATA_FILE = path.join(__dirname, 'data', 'reports.json');

const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.json': 'application/manifest+json; charset=UTF-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=UTF-8'
};

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function readReports(dataFile) {
  try {
    const raw = fs.readFileSync(dataFile, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeReports(dataFile, reports) {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify(reports, null, 2), 'utf8');
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    const MAX_BYTES = 8 * 1024 * 1024; // 8 MB para soportar fotos base64
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BYTES) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=UTF-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function renderSsrReportsPage(reports) {
  const total = reports.length;
  const pending = reports.filter(r => r.status === 'pendiente').length;
  const resolved = reports.filter(r => r.status === 'resuelto').length;

  const rows = reports.map(r => `
    <tr>
      <td><code>${escapeHtml(r.id)}</code></td>
      <td><strong>${escapeHtml(r.title)}</strong><br><small>${escapeHtml(r.description)}</small></td>
      <td>${escapeHtml(r.category)}</td>
      <td>${escapeHtml(r.location)}</td>
      <td><span class="badge ${r.status === 'resuelto' ? 'ok' : 'warn'}">${escapeHtml(r.status)}</span></td>
      <td>${escapeHtml(r.inspector || 'N/A')}</td>
      <td>${r.photo ? '<span class="badge ok">Con foto</span>' : '<span class="badge">Sin foto</span>'}</td>
      <td>${escapeHtml(new Date(r.createdAt).toLocaleString('es-MX'))}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CampoCheck - Vista SSR (Servidor)</title>
  <link rel="manifest" href="/manifest.json">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header class="app-header">
    <div class="header-brand">
      <img src="/pwa.png" alt="Logo CampoCheck" class="brand-logo">
      <div>
        <h1>CampoCheck PWA — Vista SSR</h1>
        <p class="subtitle">HTML generado dinámicamente en el servidor Node.js</p>
      </div>
    </div>
    <a href="/" class="btn btn-secondary">Volver al App Shell (CSR)</a>
  </header>
  <main class="main-content">
    <section class="card">
      <h2>Resumen generado en el servidor (${escapeHtml(new Date().toLocaleString('es-MX'))})</h2>
      <div class="stats-grid">
        <div class="stat-box"><span class="stat-num">${total}</span><span class="stat-label">Total</span></div>
        <div class="stat-box"><span class="stat-num">${pending}</span><span class="stat-label">Pendientes</span></div>
        <div class="stat-box"><span class="stat-num">${resolved}</span><span class="stat-label">Resueltos</span></div>
      </div>
    </section>
    <section class="card" style="overflow-x:auto;">
      <h2>Bitácora Remota (Renderizado SSR)</h2>
      <table class="ssr-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Incidencia</th>
            <th>Categoría</th>
            <th>Ubicación</th>
            <th>Estado</th>
            <th>Inspector</th>
            <th>Evidencia</th>
            <th>Fecha</th>
          </tr>
        </thead>
        <tbody>
          ${rows || '<tr><td colspan="8">No hay reportes registrados en el servidor.</td></tr>'}
        </tbody>
      </table>
    </section>
  </main>
</body>
</html>`;
}

function createAppServer(options = {}) {
  const dataFile = options.dataFile || DEFAULT_DATA_FILE;

  return http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = reqUrl.pathname;

    // Salud del servidor
    if (pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, {
        status: 'ok',
        service: 'CampoCheck PWA',
        timestamp: new Date().toISOString()
      });
    }

    // API REST: Listar o crear reportes
    if (pathname === '/api/reports') {
      if (req.method === 'GET') {
        const reports = readReports(dataFile);
        return sendJson(res, 200, reports);
      }

      if (req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          if (!body.title || !String(body.title).trim()) {
            return sendJson(res, 400, { error: 'El título es obligatorio' });
          }

          const reports = readReports(dataFile);
          const id = body.id && !reports.some(r => r.id === body.id)
            ? String(body.id)
            : `rep-${Date.now()}`;

          const newReport = {
            id,
            title: String(body.title).trim(),
            category: String(body.category || 'General'),
            location: String(body.location || 'Sin ubicación'),
            description: String(body.description || ''),
            status: body.status === 'resuelto' ? 'resuelto' : 'pendiente',
            photo: body.photo || null,
            coords: body.coords || null,
            inspector: String(body.inspector || 'Inspector de Campo'),
            createdAt: body.createdAt || new Date().toISOString()
          };

          reports.unshift(newReport);
          writeReports(dataFile, reports);
          return sendJson(res, 201, newReport);
        } catch (err) {
          const code = err.message === 'Payload too large' ? 413 : 400;
          return sendJson(res, code, { error: err.message });
        }
      }

      return sendJson(res, 405, { error: 'Método no permitido' });
    }

    // API REST: Actualizar o eliminar reporte específico
    if (pathname.startsWith('/api/reports/')) {
      const id = decodeURIComponent(pathname.replace('/api/reports/', ''));
      const reports = readReports(dataFile);
      const index = reports.findIndex(r => r.id === id);

      if (index === -1) {
        return sendJson(res, 404, { error: 'Reporte no encontrado' });
      }

      if (req.method === 'PATCH') {
        try {
          const body = await parseJsonBody(req);
          if (body.status === 'pendiente' || body.status === 'resuelto') {
            reports[index].status = body.status;
          }
          if (typeof body.title === 'string' && body.title.trim()) {
            reports[index].title = body.title.trim();
          }
          writeReports(dataFile, reports);
          return sendJson(res, 200, reports[index]);
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }

      if (req.method === 'DELETE') {
        const [removed] = reports.splice(index, 1);
        writeReports(dataFile, reports);
        return sendJson(res, 200, { deleted: removed.id });
      }

      return sendJson(res, 405, { error: 'Método no permitido' });
    }

    // Vista generada del lado del servidor (SSR)
    if (pathname === '/ssr-reportes' && req.method === 'GET') {
      const reports = readReports(dataFile);
      const html = renderSsrReportsPage(reports);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
      return res.end(html);
    }

    // Archivos estáticos de public/
    const safePath = pathname === '/' ? 'index.html' : pathname;
    const normalized = path.normalize(safePath).replace(/^(\.\.[\/\\])+/, '');
    const filePath = path.join(PUBLIC_DIR, normalized);

    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('403 Forbidden');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
      if (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('404 Not Found');
        } else {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(`500 Internal Error: ${err.code}`);
        }
      } else {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
      }
    });
  });
}

if (require.main === module) {
  const server = createAppServer();
  server.listen(DEFAULT_PORT, () => {
    console.log(`Servidor PWA CampoCheck corriendo en http://localhost:${DEFAULT_PORT}`);
  });
}

module.exports = { createAppServer, readReports, writeReports };