const DB_NAME = 'campocheck-db';
const DB_VERSION = 1;
const STORE_NAME = 'reports';

let swRegistration = null;
let cameraStream = null;
let capturedPhotoData = null;

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => toast.classList.add('hidden'), 3200);
}

// --- IndexedDB (Datos Locales y Offline) ---
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAllLocalReports() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function saveLocalReport(report) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(report);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteLocalReport(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function replaceSyncedReports(remoteReports) {
  const local = await getAllLocalReports();
  const pendingLocal = local.filter(r => r.synced === false);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    for (const r of remoteReports) {
      store.put({ ...r, synced: true });
    }
    for (const p of pendingLocal) {
      store.put(p);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- Notificaciones (DE) ---
function updateNotifUI() {
  const perm = 'Notification' in window ? Notification.permission : 'no-soportado';
  document.getElementById('notif-perm-text').textContent = perm;
}

async function requestNotifPermission() {
  if (!('Notification' in window)) {
    showToast('Este navegador no soporta Web Notifications.');
    return;
  }
  const result = await Notification.requestPermission();
  updateNotifUI();
  showToast(`Permiso de notificaciones: ${result}`);
}

async function notifyUser(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    return;
  }
  const options = {
    body,
    icon: '/pwa.png',
    badge: '/pwa.png',
    tag: 'campocheck-alert'
  };
  try {
    if (swRegistration && swRegistration.showNotification) {
      await swRegistration.showNotification(title, options);
    } else {
      new Notification(title, options);
    }
  } catch {
    new Notification(title, options);
  }
}

// --- Navegación entre pantallas ---
function switchScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const target = document.getElementById(`screen-${name}`);
  const btn = document.querySelector(`.nav-btn[data-screen="${name}"]`);
  if (target) target.classList.add('active');
  if (btn) btn.classList.add('active');
}

// --- Sincronización y Renderizado (CSR) ---
async function loadAndRenderReports() {
  if (navigator.onLine) {
    try {
      const res = await fetch('/api/reports');
      if (res.ok) {
        const remote = await res.json();
        await replaceSyncedReports(remote);
      }
    } catch {
      // Si falla la red, continuamos con IndexedDB local
    }
  }

  const allReports = await getAllLocalReports();
  allReports.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const total = allReports.length;
  const pending = allReports.filter(r => r.status === 'pendiente').length;
  const resolved = allReports.filter(r => r.status === 'resuelto').length;
  const offlineCount = allReports.filter(r => r.synced === false).length;

  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-pending').textContent = pending;
  document.getElementById('stat-resolved').textContent = resolved;
  document.getElementById('stat-offline').textContent = offlineCount;
  document.getElementById('sync-badge').textContent = `${offlineCount} pendientes`;

  renderReportsList(allReports);
}

function escapeText(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function renderReportsList(reports) {
  const filter = document.getElementById('filter-status').value;
  const container = document.getElementById('reports-container');

  const filtered = reports.filter(r => {
    if (filter === 'pendiente') return r.status === 'pendiente';
    if (filter === 'resuelto') return r.status === 'resuelto';
    if (filter === 'offline') return r.synced === false;
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = '<div class="card"><p>No hay reportes para el filtro seleccionado.</p></div>';
    return;
  }

  container.innerHTML = filtered.map(r => `
    <article class="report-card">
      <div class="report-header">
        <h3 class="report-title">${escapeText(r.title)}</h3>
        <div>
          <span class="badge ${r.status === 'resuelto' ? 'ok' : 'warn'}">${escapeText(r.status)}</span>
          ${r.synced === false ? '<span class="badge local">Pendiente Sync (Offline)</span>' : '<span class="badge">Sincronizado</span>'}
        </div>
      </div>
      <p>${escapeText(r.description || 'Sin observaciones adicionales.')}</p>
      ${r.photo ? `<img src="${r.photo}" alt="Evidencia fotográfica" class="report-photo">` : ''}
      <div class="report-meta">
        <span>Categoría: <strong>${escapeText(r.category)}</strong></span>
        <span>Ubicación: <strong>${escapeText(r.location)}</strong></span>
        ${r.coords ? `<span>GPS: <strong>${escapeText(r.coords)}</strong></span>` : ''}
        <span>Inspector: <strong>${escapeText(r.inspector || 'N/A')}</strong></span>
        <span>Fecha: ${new Date(r.createdAt).toLocaleString('es-MX')}</span>
      </div>
      <div class="actions-row">
        <button class="btn btn-ok btn-sm" onclick="toggleReportStatus('${escapeText(r.id)}', '${r.status}')">
          ${r.status === 'pendiente' ? 'Marcar Resuelto' : 'Reabrir'}
        </button>
        <button class="btn btn-danger btn-sm" onclick="removeReport('${escapeText(r.id)}')">Eliminar</button>
      </div>
    </article>
  `).join('');
}

async function syncPendingReports() {
  if (!navigator.onLine) {
    showToast('Sin conexión. Los datos permanecen seguros en IndexedDB.');
    return;
  }
  const all = await getAllLocalReports();
  const pending = all.filter(r => r.synced === false);
  if (pending.length === 0) {
    await loadAndRenderReports();
    showToast('Todo está sincronizado con el servidor.');
    return;
  }

  let syncedCount = 0;
  for (const item of pending) {
    try {
      const res = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item)
      });
      if (res.ok) {
        const saved = await res.json();
        await saveLocalReport({ ...saved, synced: true });
        syncedCount++;
      }
    } catch {
      // Continuar con los demás
    }
  }

  await loadAndRenderReports();
  if (syncedCount > 0) {
    showToast(`Se sincronizaron ${syncedCount} reporte(s) con el servidor.`);
    notifyUser('Sincronización completada', `${syncedCount} reporte(s) offline enviados al servidor.`);
  }
}

window.toggleReportStatus = async (id, currentStatus) => {
  const nextStatus = currentStatus === 'pendiente' ? 'resuelto' : 'pendiente';
  const all = await getAllLocalReports();
  const item = all.find(r => r.id === id);
  if (!item) return;

  item.status = nextStatus;
  if (navigator.onLine && item.synced !== false) {
    try {
      const res = await fetch(`/api/reports/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus })
      });
      if (res.ok) {
        await saveLocalReport({ ...item, synced: true });
      }
    } catch {
      await saveLocalReport(item);
    }
  } else {
    await saveLocalReport(item);
  }
  await loadAndRenderReports();
  showToast(`Reporte actualizado a: ${nextStatus}`);
};

window.removeReport = async id => {
  if (navigator.onLine) {
    try {
      await fetch(`/api/reports/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch {
      // Ignorar si es solo local
    }
  }
  await deleteLocalReport(id);
  await loadAndRenderReports();
  showToast('Reporte eliminado.');
};

// --- Cámara Física (MediaDevices API + Fallback) ---
async function startCamera() {
  const video = document.getElementById('camera-preview');
  const photoPreview = document.getElementById('photo-preview');
  const statusEl = document.getElementById('camera-status');

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    statusEl.textContent = 'getUserMedia no disponible; usa "Subir / Cámara nativa".';
    return;
  }

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false
    });
    video.srcObject = cameraStream;
    video.classList.remove('hidden');
    photoPreview.classList.add('hidden');
    document.getElementById('btn-take-photo').classList.remove('hidden');
    document.getElementById('btn-stop-camera').classList.remove('hidden');
    statusEl.textContent = 'Cámara activa. Presiona "Tomar Foto" para capturar evidencia.';
  } catch (err) {
    statusEl.textContent = `No se pudo acceder a la cámara (${err.name}). Usa "Subir / Cámara nativa".`;
  }
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  document.getElementById('camera-preview').classList.add('hidden');
  document.getElementById('btn-take-photo').classList.add('hidden');
  document.getElementById('btn-stop-camera').classList.add('hidden');
}

function takePhoto() {
  const video = document.getElementById('camera-preview');
  const canvas = document.getElementById('camera-canvas');
  const photoPreview = document.getElementById('photo-preview');

  if (!video.videoWidth) return;
  const maxWidth = 720;
  const scale = Math.min(1, maxWidth / video.videoWidth);
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);

  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  capturedPhotoData = canvas.toDataURL('image/jpeg', 0.78);

  photoPreview.src = capturedPhotoData;
  photoPreview.classList.remove('hidden');
  stopCamera();
  document.getElementById('camera-status').textContent = 'Fotografía capturada lista para adjuntar.';
}

// --- Estado de Red ---
function updateNetworkUI() {
  const pill = document.getElementById('net-status');
  if (navigator.onLine) {
    pill.textContent = 'Online';
    pill.className = 'pill online';
  } else {
    pill.textContent = 'Offline (Modo Caché)';
    pill.className = 'pill offline';
  }
}

// --- Inicialización ---
document.addEventListener('DOMContentLoaded', async () => {
  // Perfil local en localStorage
  const savedName = localStorage.getItem('campocheck_inspector') || 'Angel Eduardo Ramirez';
  document.getElementById('inspector-name').value = savedName;
  document.getElementById('home-inspector').textContent = savedName;

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchScreen(btn.dataset.screen));
  });

  document.getElementById('btn-go-capture').addEventListener('click', () => switchScreen('capture'));
  document.getElementById('btn-sync-now').addEventListener('click', syncPendingReports);
  document.getElementById('btn-force-sync').addEventListener('click', syncPendingReports);
  document.getElementById('btn-refresh-reports').addEventListener('click', loadAndRenderReports);
  document.getElementById('filter-status').addEventListener('change', loadAndRenderReports);

  document.getElementById('btn-start-camera').addEventListener('click', startCamera);
  document.getElementById('btn-take-photo').addEventListener('click', takePhoto);
  document.getElementById('btn-stop-camera').addEventListener('click', () => {
    stopCamera();
    document.getElementById('camera-status').textContent = 'Cámara detenida.';
  });

  document.getElementById('file-photo-input').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      capturedPhotoData = reader.result;
      const preview = document.getElementById('photo-preview');
      preview.src = capturedPhotoData;
      preview.classList.remove('hidden');
      stopCamera();
      document.getElementById('camera-status').textContent = 'Imagen cargada desde dispositivo.';
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('btn-get-gps').addEventListener('click', () => {
    if (!('geolocation' in navigator)) {
      showToast('Geolocalización no soportada en este navegador.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => {
        const coords = `${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`;
        document.getElementById('rep-coords').value = coords;
        showToast('Coordenadas GPS obtenidas.');
      },
      err => showToast(`No se pudo obtener GPS: ${err.message}`)
    );
  });

  document.getElementById('report-form').addEventListener('submit', async e => {
    e.preventDefault();
    const inspector = localStorage.getItem('campocheck_inspector') || 'Angel Eduardo Ramirez';
    const report = {
      id: `rep-${Date.now()}`,
      title: document.getElementById('rep-title').value.trim(),
      category: document.getElementById('rep-category').value,
      location: document.getElementById('rep-location').value.trim(),
      description: document.getElementById('rep-description').value.trim(),
      status: 'pendiente',
      photo: capturedPhotoData,
      coords: document.getElementById('rep-coords').value || null,
      inspector,
      createdAt: new Date().toISOString(),
      synced: false
    };

    if (navigator.onLine) {
      try {
        const res = await fetch('/api/reports', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(report)
        });
        if (res.ok) {
          const created = await res.json();
          await saveLocalReport({ ...created, synced: true });
          showToast('Reporte guardado en servidor remoto y caché local.');
          notifyUser('Reporte registrado', `"${created.title}" se guardó correctamente.`);
        } else {
          await saveLocalReport(report);
          showToast('Guardado localmente (pendiente de sincronizar).');
        }
      } catch {
        await saveLocalReport(report);
        showToast('Sin respuesta del servidor: guardado en IndexedDB offline.');
      }
    } else {
      await saveLocalReport(report);
      showToast('Modo Offline: reporte guardado en IndexedDB.');
      notifyUser('Reporte guardado offline', `"${report.title}" se sincronizará al volver la red.`);
    }

    e.target.reset();
    capturedPhotoData = null;
    document.getElementById('photo-preview').classList.add('hidden');
    document.getElementById('camera-status').textContent = 'Cámara inactiva.';
    await loadAndRenderReports();
    switchScreen('reports');
  });

  document.getElementById('btn-save-inspector').addEventListener('click', () => {
    const val = document.getElementById('inspector-name').value.trim() || 'Inspector';
    localStorage.setItem('campocheck_inspector', val);
    document.getElementById('home-inspector').textContent = val;
    showToast('Nombre del inspector guardado en localStorage.');
  });

  document.getElementById('btn-ask-notif').addEventListener('click', requestNotifPermission);
  document.getElementById('btn-test-notif').addEventListener('click', async () => {
    if (Notification.permission !== 'granted') {
      await requestNotifPermission();
    }
    if (Notification.permission === 'granted') {
      await notifyUser('CampoCheck PWA', 'Notificación de prueba funcionando correctamente.');
      showToast('Notificación enviada.');
    }
  });

  document.getElementById('btn-clear-local').addEventListener('click', async () => {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = async () => {
      await loadAndRenderReports();
      showToast('Caché y almacenamiento local limpiados.');
    };
  });

  window.addEventListener('online', () => {
    updateNetworkUI();
    syncPendingReports();
  });
  window.addEventListener('offline', updateNetworkUI);

  updateNetworkUI();
  updateNotifUI();

  if ('serviceWorker' in navigator) {
    try {
      swRegistration = await navigator.serviceWorker.register('/sw.js');
      document.getElementById('sw-status').textContent = `Service Worker activo en: ${swRegistration.scope}`;
    } catch (err) {
      document.getElementById('sw-status').textContent = `Error en Service Worker: ${err}`;
    }
  } else {
    document.getElementById('sw-status').textContent = 'Service Worker no soportado en este navegador.';
  }

  await loadAndRenderReports();
});
