// Pasapalabra - servidor sin dependencias para jugar en red local
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const CARPETA_ROSCOS = path.join(__dirname, 'roscos');
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

// roscos/rosco1.json, rosco2.json, rosco3.json -> { "nombre": "...", "preguntas": [ {letra, pregunta, respuestas[]} ] }
function leerRosco(n) {
  const f = path.join(CARPETA_ROSCOS, `rosco${n}.json`);
  if (!fs.existsSync(f)) return null;
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    const preguntas = Array.isArray(d.preguntas) ? d.preguntas : [];
    return preguntas.length ? { nombre: d.nombre || `Rosco ${n}`, preguntas } : null;
  } catch (e) {
    return null;
  }
}

function primerRoscoDisponible() {
  for (let n = 1; n <= 3; n++) if (leerRosco(n)) return n;
  return 1;
}

let roscoIdx = primerRoscoDisponible();
let sala = nuevaSala();

function nuevaSala() {
  const r = leerRosco(roscoIdx) || { nombre: 'Sin rosco', preguntas: [] };
  return { fase: 'espera', inicio: 0, nombreRosco: r.nombre, preguntas: r.preguntas, jugadores: {} };
}

function nuevoJugador(id, nombre) {
  return {
    id, nombre,
    cola: sala.preguntas.map((_, i) => i),
    estado: sala.preguntas.map(() => null),
    aciertos: 0, fallos: 0, fin: null
  };
}

function normalizar(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Sin límite de tiempo: la partida termina cuando todos acaban el rosco o cuando el profesor la para
function finalizar() {
  if (sala.fase !== 'juego') return;
  const t = Date.now() - sala.inicio;
  sala.fase = 'resultados';
  for (const j of Object.values(sala.jugadores)) if (j.fin === null) j.fin = t;
}

function comprobarFin() {
  if (sala.fase !== 'juego') return;
  const jugadores = Object.values(sala.jugadores);
  if (jugadores.length > 0 && jugadores.every(j => j.cola.length === 0)) finalizar();
}

// Ordena por aciertos (desc) y, si empatan, por quien terminó antes
function clasificacion() {
  return Object.values(sala.jugadores).sort((a, b) =>
    b.aciertos - a.aciertos || (a.fin ?? Infinity) - (b.fin ?? Infinity));
}

function resumen(j) {
  return {
    nombre: j.nombre, aciertos: j.aciertos, fallos: j.fallos,
    respondidas: j.estado.filter(e => e !== null).length, fin: j.fin
  };
}

function estadoPara(pid) {
  comprobarFin();
  const out = {
    fase: sala.fase,
    transcurridoMs: sala.fase === 'juego' ? Date.now() - sala.inicio : 0,
    total: sala.preguntas.length,
    roscoIdx,
    nombreRosco: sala.nombreRosco,
    jugadores: clasificacion().map(resumen)
  };
  const yo = sala.jugadores[pid];
  if (yo) {
    const actual = yo.cola.length ? sala.preguntas[yo.cola[0]] : null;
    out.yo = {
      nombre: yo.nombre,
      aciertos: yo.aciertos,
      fallos: yo.fallos,
      respondidas: yo.estado.filter(e => e !== null).length,
      pendientes: yo.cola.length,
      pregunta: sala.fase === 'juego' && actual ? { letra: actual.letra, texto: actual.pregunta, contiene: !!actual.contiene } : null,
      letras: sala.preguntas.map(p => p.letra),
      estado: yo.estado,
      fin: yo.fin
    };
  }
  return out;
}

function ips() {
  const out = [];
  for (const ifs of Object.values(os.networkInterfaces())) {
    for (const i of ifs || []) {
      if ((i.family === 'IPv4' || i.family === 4) && !i.internal) out.push(i.address);
    }
  }
  return out;
}

function enviar(res, code, tipo, cuerpo) {
  res.writeHead(code, { 'Content-Type': tipo, 'Cache-Control': 'no-store' });
  res.end(cuerpo);
}
function json(res, code, obj) {
  enviar(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));
}
function leerBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 1e5) req.destroy();
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); }
    });
  });
}

async function api(req, res, p, url) {
  if (req.method === 'GET' && p === '/api/info') return json(res, 200, { ips: ips(), puerto: PORT });
  if (req.method === 'GET' && p === '/api/estado') return json(res, 200, estadoPara(url.searchParams.get('pid')));
  if (req.method === 'GET' && p === '/api/preguntas') return json(res, 200, sala.preguntas.map(q => ({ letra: q.letra, pregunta: q.pregunta, contiene: !!q.contiene })));
  if (req.method === 'GET' && p === '/api/roscos') {
    return json(res, 200, [1, 2, 3].map(n => {
      const r = leerRosco(n);
      return { indice: n, nombre: r ? r.nombre : `Rosco ${n}`, disponible: !!r, total: r ? r.preguntas.length : 0 };
    }));
  }

  const body = req.method === 'POST' ? await leerBody(req) : {};
  const ruta = `${req.method} ${p}`;

  if (ruta === 'POST /api/unirse') {
    if (sala.fase !== 'espera') return json(res, 400, { error: 'La partida ya ha empezado.' });
    const nombre = String(body.nombre || '').trim().slice(0, 20);
    if (!nombre) return json(res, 400, { error: 'Escribe tu nombre.' });
    if (!sala.preguntas.length) return json(res, 400, { error: 'El rosco seleccionado no está disponible.' });
    const id = crypto.randomBytes(8).toString('hex');
    sala.jugadores[id] = nuevoJugador(id, nombre);
    return json(res, 200, { pid: id });
  }

  if (ruta === 'POST /api/rosco') {
    if (sala.fase !== 'espera') return json(res, 400, { error: 'Solo se puede cambiar el rosco en la sala de espera.' });
    const n = Number(body.indice);
    const r = leerRosco(n);
    if (!r) return json(res, 400, { error: 'Ese rosco todavía no está disponible.' });
    roscoIdx = n;
    sala.preguntas = r.preguntas;
    sala.nombreRosco = r.nombre;
    for (const id of Object.keys(sala.jugadores)) sala.jugadores[id] = nuevoJugador(id, sala.jugadores[id].nombre);
    return json(res, 200, { ok: true });
  }

  if (ruta === 'POST /api/iniciar') {
    if (sala.fase !== 'espera') return json(res, 400, { error: 'Ya hay una partida en curso.' });
    if (!Object.keys(sala.jugadores).length) return json(res, 400, { error: 'No hay jugadores conectados.' });
    sala.inicio = Date.now();
    sala.fase = 'juego';
    return json(res, 200, { ok: true });
  }

  if (ruta === 'POST /api/responder') {
    comprobarFin();
    if (sala.fase !== 'juego') return json(res, 400, { error: 'No hay partida en curso.' });
    const j = sala.jugadores[body.pid];
    if (!j) return json(res, 403, { error: 'Jugador no registrado.' });
    if (!j.cola.length) return json(res, 400, { error: 'Ya has terminado el rosco.' });
    const idx = j.cola.shift();
    const texto = String(body.texto || '').trim().slice(0, 60);
    const pregunta = sala.preguntas[idx];
    const ok = texto.length > 0 && pregunta.respuestas.some(r => normalizar(r) === normalizar(texto));
    j.estado[idx] = ok ? 'ok' : 'fail';
    if (ok) j.aciertos++; else j.fallos++;
    if (!j.cola.length) j.fin = Date.now() - sala.inicio;
    comprobarFin();
    return json(res, 200, { ok, respuesta: pregunta.respuestas[0] });
  }

  if (ruta === 'POST /api/pasapalabra') {
    comprobarFin();
    if (sala.fase !== 'juego') return json(res, 400, { error: 'No hay partida en curso.' });
    const j = sala.jugadores[body.pid];
    if (!j) return json(res, 403, { error: 'Jugador no registrado.' });
    if (j.cola.length > 1) j.cola.push(j.cola.shift());
    return json(res, 200, { ok: true });
  }

  if (ruta === 'POST /api/terminar') {
    finalizar();
    return json(res, 200, { ok: true });
  }

  if (ruta === 'POST /api/nueva') {
    sala = nuevaSala();
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'No existe' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (p.startsWith('/api/')) return await api(req, res, p, url);

    // Alumnos: http://IP:3000  (también /jugar).  Profesor: http://localhost:3000/profesor
    const archivo = (p === '/' || p === '/jugar') ? 'jugar.html' : p === '/profesor' ? 'host.html' : p.slice(1);
    const full = path.normalize(path.join(PUB, archivo));
    if (!full.startsWith(PUB)) return enviar(res, 403, 'text/plain', 'Prohibido');
    fs.readFile(full, (err, data) => {
      if (err) return enviar(res, 404, 'text/plain; charset=utf-8', 'No encontrado');
      enviar(res, 200, TIPOS[path.extname(full)] || 'application/octet-stream', data);
    });
  } catch (e) {
    enviar(res, 500, 'text/plain; charset=utf-8', String(e));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\nPasapalabra en marcha.');
  console.log(`Profesor:  http://localhost:${PORT}/profesor`);
  for (const ip of ips()) console.log(`Alumnos:   http://${ip}:${PORT}`);
  console.log('\nCtrl+C para parar.\n');
});
