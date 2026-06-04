require('dotenv').config();
const path = require('path');
const express = require('express');
const { Pool } = require('pg');
const exceljs = require('exceljs');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 10000;

const isRemoteDb = (process.env.DATABASE_URL || '').includes('render.com');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isRemoteDb ? { rejectUnauthorized: false } : false
});

// Middlewares
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Inicializacion de BD ---
async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS scanned_products (
        id SERIAL PRIMARY KEY,
        code VARCHAR(50) NOT NULL,
        name TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        usuario VARCHAR(50) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        rol VARCHAR(20) NOT NULL DEFAULT 'operador',
        autorizado BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS export_history (
        id SERIAL PRIMARY KEY,
        usuario VARCHAR(50) NOT NULL,
        session_id TEXT NOT NULL,
        total_products INTEGER NOT NULL,
        total_units INTEGER NOT NULL,
        exported_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS product_catalog (
        id SERIAL PRIMARY KEY,
        id_producto VARCHAR(50) NOT NULL,
        codigo VARCHAR(100) NOT NULL,
        nombre TEXT NOT NULL,
        rubro TEXT NOT NULL DEFAULT '',
        fuente VARCHAR(50) NOT NULL DEFAULT 'iduo',
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_product_catalog_codigo ON product_catalog(codigo)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS catalog_metadata (
        id INTEGER PRIMARY KEY,
        last_sync_at TIMESTAMP,
        last_sync_status VARCHAR(20),
        last_sync_error TEXT,
        total_products INTEGER DEFAULT 0,
        source VARCHAR(50) NOT NULL DEFAULT 'iduo',
        sync_in_progress BOOLEAN DEFAULT false
      )
    `);
    // Migrar: quitar constraint singleton si existe (BD existentes)
    await client.query(`ALTER TABLE catalog_metadata DROP CONSTRAINT IF EXISTS singleton`);
    // Insertar filas por cada fuente
    await client.query(`INSERT INTO catalog_metadata (id, source) VALUES (1, 'iduo') ON CONFLICT (id) DO NOTHING`);
    await client.query(`INSERT INTO catalog_metadata (id, source) VALUES (2, 'vision') ON CONFLICT (id) DO NOTHING`);
    // Resetear locks al arrancar (por si quedaron colgados de un crash anterior)
    await client.query(`UPDATE catalog_metadata SET sync_in_progress = false`);

    // Migrar usuarios iniciales si la tabla esta vacia
    const { rows } = await client.query('SELECT COUNT(*) as count FROM users');
    if (parseInt(rows[0].count) === 0) {
      const hash1 = bcrypt.hashSync('manuel5232', 10);
      const hash2 = bcrypt.hashSync('marcela123', 10);
      await client.query(
        `INSERT INTO users (usuario, password_hash, rol, autorizado) VALUES
         ('manuel', $1, 'admin', true),
         ('marcela', $2, 'operador', true)`,
        [hash1, hash2]
      );
      console.log('Usuarios iniciales migrados a PostgreSQL');
    }

    console.log('Tablas creadas/verificadas en PostgreSQL');
  } catch (err) {
    console.error('Error al inicializar la base de datos:', err.message);
    process.exit(1);
  } finally {
    client.release();
  }
}

// Promesa expuesta para encadenar arranque de sync inicial despues de crear tablas
const dbReady = initDatabase();

// --- Helpers ---
function getSessionId(req) {
  return req.headers['authorization'] || 'anonymous';
}

// Middleware: verificar que el usuario esta autenticado
function authRequired(req, res, next) {
  const sessionId = req.headers['authorization'];
  if (!sessionId || sessionId === 'anonymous') {
    return res.status(401).json({ error: 'No autenticado' });
  }
  next();
}

// Middleware: verificar rol admin
async function adminRequired(req, res, next) {
  const sessionId = req.headers['authorization'] || '';
  const username = sessionId.split('_')[0];
  if (!username) return res.status(401).json({ error: 'No autenticado' });

  try {
    const { rows } = await pool.query(
      'SELECT rol FROM users WHERE usuario = $1 AND autorizado = true',
      [username]
    );
    if (rows.length === 0 || rows[0].rol !== 'admin') {
      return res.status(403).json({ error: 'Acceso denegado. Se requiere rol admin.' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// --- Auth Endpoints ---
app.post('/api/login', async (req, res) => {
  const { usuario, password } = req.body;
  if (!usuario || !password) {
    return res.status(400).json({ error: 'Usuario y contrasena requeridos' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE usuario = $1',
      [usuario.trim()]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Usuario no registrado' });
    }

    const user = rows[0];
    if (!user.autorizado) {
      return res.status(401).json({ error: 'Usuario no autorizado' });
    }

    const valid = bcrypt.compareSync(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Contrasena incorrecta' });
    }

    const sessionId = usuario.trim() + '_' + Date.now().toString();
    res.json({
      message: 'Login exitoso',
      sessionId: sessionId,
      usuario: user.usuario,
      rol: user.rol
    });
  } catch (err) {
    console.error('Error en login:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// --- Product Endpoints ---
app.post('/save', authRequired, async (req, res) => {
  let { code, name, quantity } = req.body;
  const sessionId = getSessionId(req);

  if (!code || !name || !quantity) {
    return res.status(400).json({ error: 'Faltan datos requeridos' });
  }

  code = String(code);
  if (code.length > 50) {
    return res.status(400).json({ error: 'El codigo es demasiado largo' });
  }

  try {
    const catalogCheck = await pool.query(
      `SELECT 1 FROM product_catalog WHERE codigo = $1 AND nombre = $2 LIMIT 1`,
      [code, name]
    );
    if (catalogCheck.rowCount === 0) {
      return res.status(400).json({ error: 'Producto no valido: el codigo y nombre no coinciden con el catalogo' });
    }

    const result = await pool.query(
      `INSERT INTO scanned_products (code, name, quantity, session_id)
       VALUES ($1::VARCHAR, $2, $3::INTEGER, $4) RETURNING id`,
      [code, name, parseInt(quantity), sessionId]
    );
    res.status(200).json({ message: 'Registro guardado exitosamente', id: result.rows[0].id });
  } catch (err) {
    console.error('Error al guardar:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.put('/save/:id', authRequired, async (req, res) => {
  let { code, name, quantity } = req.body;
  const sessionId = getSessionId(req);
  const id = req.params.id;

  if (!code || !name || !quantity || !id) {
    return res.status(400).json({ error: 'Faltan datos requeridos' });
  }
  code = String(code);

  try {
    const catalogCheck = await pool.query(
      `SELECT 1 FROM product_catalog WHERE codigo = $1 AND nombre = $2 LIMIT 1`,
      [code, name]
    );
    if (catalogCheck.rowCount === 0) {
      return res.status(400).json({ error: 'Producto no valido: el codigo y nombre no coinciden con el catalogo' });
    }

    const result = await pool.query(
      `UPDATE scanned_products SET code = $1::VARCHAR, name = $2, quantity = $3
       WHERE id = $4 AND session_id = $5`,
      [code, name, parseInt(quantity), id, sessionId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Registro no encontrado' });
    res.status(200).json({ message: 'Registro actualizado exitosamente' });
  } catch (err) {
    console.error('Error al actualizar:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.delete('/delete/:id', authRequired, async (req, res) => {
  const sessionId = getSessionId(req);
  const id = req.params.id;

  if (!id || isNaN(id)) return res.status(400).json({ error: 'ID invalido' });

  try {
    const result = await pool.query(
      'DELETE FROM scanned_products WHERE id = $1 AND session_id = $2',
      [id, sessionId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Registro no encontrado' });
    res.status(200).json({ message: 'Registro eliminado exitosamente' });
  } catch (err) {
    console.error('Error al eliminar:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/records', authRequired, async (req, res) => {
  const sessionId = getSessionId(req);
  try {
    const { rows } = await pool.query(
      'SELECT * FROM scanned_products WHERE session_id = $1 ORDER BY created_at DESC',
      [sessionId]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error al recuperar registros:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/export', authRequired, async (req, res) => {
  const sessionId = getSessionId(req);
  const username = sessionId.split('_')[0];

  try {
    const { rows } = await pool.query(
      `SELECT code, name, SUM(quantity) as total_quantity
       FROM scanned_products WHERE session_id = $1
       GROUP BY code, name ORDER BY name ASC`,
      [sessionId]
    );

    if (rows.length === 0) {
      return res.status(400).json({ error: 'No hay productos para exportar' });
    }

    // Calcular totales para el historial
    const totalProducts = rows.length;
    const totalUnits = rows.reduce((sum, r) => sum + parseInt(r.total_quantity), 0);

    const workbook = new exceljs.Workbook();
    const worksheet = workbook.addWorksheet('Productos Escaneados');
    worksheet.columns = [
      { header: 'Codigo', key: 'code', width: 15 },
      { header: 'Nombre', key: 'name', width: 50 },
      { header: 'Cantidad Total', key: 'total_quantity', width: 15 }
    ];
    worksheet.addRows(rows);

    const buffer = await workbook.xlsx.writeBuffer();

    // Guardar en historial
    await pool.query(
      `INSERT INTO export_history (usuario, session_id, total_products, total_units)
       VALUES ($1, $2, $3, $4)`,
      [username, sessionId, totalProducts, totalUnits]
    );

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=inventario_${new Date().toISOString().split('T')[0]}.xlsx`);
    res.send(buffer);
  } catch (err) {
    console.error('Error al exportar:', err.message);
    res.status(500).json({ error: 'Error al generar el reporte' });
  }
});

app.delete('/clear-session', authRequired, async (req, res) => {
  const sessionId = getSessionId(req);
  try {
    await pool.query('DELETE FROM scanned_products WHERE session_id = $1', [sessionId]);
    res.status(200).json({ message: 'Sesion limpiada exitosamente' });
  } catch (err) {
    console.error('Error al limpiar sesion:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// --- Historial de exportaciones (admin) ---
app.get('/api/history', authRequired, adminRequired, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM export_history ORDER BY exported_at DESC LIMIT 100'
    );
    res.json(rows);
  } catch (err) {
    console.error('Error al obtener historial:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// --- Gestion de usuarios (admin) ---
app.get('/api/users', authRequired, adminRequired, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, usuario, rol, autorizado, created_at FROM users ORDER BY created_at ASC'
    );
    res.json(rows);
  } catch (err) {
    console.error('Error al obtener usuarios:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post('/api/users', authRequired, adminRequired, async (req, res) => {
  const { usuario, password, rol } = req.body;
  if (!usuario || !password) {
    return res.status(400).json({ error: 'Usuario y contrasena requeridos' });
  }
  const validRoles = ['admin', 'operador'];
  const userRol = validRoles.includes(rol) ? rol : 'operador';

  try {
    const hash = bcrypt.hashSync(password, 10);
    await pool.query(
      'INSERT INTO users (usuario, password_hash, rol) VALUES ($1, $2, $3)',
      [usuario.trim(), hash, userRol]
    );
    res.status(201).json({ message: 'Usuario creado exitosamente' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'El usuario ya existe' });
    }
    console.error('Error al crear usuario:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.put('/api/users/:id', authRequired, adminRequired, async (req, res) => {
  const { rol, autorizado, password } = req.body;
  const id = req.params.id;

  try {
    if (password) {
      const hash = bcrypt.hashSync(password, 10);
      await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, id]);
    }
    if (rol !== undefined || autorizado !== undefined) {
      const updates = [];
      const values = [];
      let idx = 1;
      if (rol !== undefined) { updates.push(`rol = $${idx++}`); values.push(rol); }
      if (autorizado !== undefined) { updates.push(`autorizado = $${idx++}`); values.push(autorizado); }
      values.push(id);
      await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}`, values);
    }
    res.json({ message: 'Usuario actualizado exitosamente' });
  } catch (err) {
    console.error('Error al actualizar usuario:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.delete('/api/users/:id', authRequired, adminRequired, async (req, res) => {
  const id = req.params.id;
  try {
    const result = await pool.query('DELETE FROM users WHERE id = $1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ message: 'Usuario eliminado exitosamente' });
  } catch (err) {
    console.error('Error al eliminar usuario:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// --- Catalogo de productos (APIs externas) ---

const SOURCE_CONFIG = {
  iduo: {
    id: 1,
    label: 'TIC TAC (Iduo)',
    baseUrl: () => process.env.IDUO_BASE_URL,
    token: () => process.env.IDUO_TOKEN,
    idPadre: () => process.env.IDUO_ID_PADRE,
    sucursalGrupo: () => process.env.IDUO_SUCURSAL_GRUPO,
    deposito: () => process.env.IDUO_DEPOSITO,
    timeoutMs: () => parseInt(process.env.IDUO_TIMEOUT_MS || '600000'),
  },
  vision: {
    id: 2,
    label: 'VISION',
    baseUrl: () => process.env.VISION_BASE_URL,
    token: () => process.env.VISION_TOKEN,
    idPadre: () => process.env.VISION_ID_PADRE,
    sucursalGrupo: () => process.env.VISION_SUCURSAL_GRUPO,
    deposito: () => process.env.VISION_DEPOSITO,
    timeoutMs: () => parseInt(process.env.VISION_TIMEOUT_MS || '600000'),
  }
};

function buildSourceUrl(sourceKey) {
  const config = SOURCE_CONFIG[sourceKey];
  const base = config.baseUrl();
  const idPadre = config.idPadre();
  const sucGrupo = config.sucursalGrupo();
  const deposito = config.deposito();
  const now = new Date();
  const dia = now.getDate();
  const mes = now.getMonth() + 1;
  const anio = now.getFullYear();
  const params = new URLSearchParams();
  params.set('PAG', 'Listadostock');
  params.set('opcionfechahasta', 'Personalizar');
  params.set('diahasta', String(dia));
  params.set('meshasta', String(mes));
  params.set('anohasta', String(anio));
  params.set('idproducto[0]', idPadre);
  params.set('filtrostockcero', 'todos');
  params.set('idsucursalgrupo[0]', sucGrupo);
  params.set('iddeposito[0]', deposito);
  return `${base}?${params.toString()}`;
}

async function fetchSourceCatalog(sourceKey) {
  const config = SOURCE_CONFIG[sourceKey];
  const url = buildSourceUrl(sourceKey);
  const timeoutMs = config.timeoutMs();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Token': config.token() },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} de la API ${config.label}`);
    }
    const data = await response.json();
    if (data && data.hayerror) {
      throw new Error(`API ${config.label}: ${data.error || 'error desconocido'}`);
    }
    if (!Array.isArray(data)) {
      throw new Error(`Respuesta inesperada de la API ${config.label} (no es array)`);
    }
    return data;
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeProducts(rawProducts) {
  const rows = [];
  for (const p of rawProducts) {
    if (!p || !p.idproducto || !p.codigos) continue;
    const idProducto = String(p.idproducto);
    const nombre = String(p.nombreproducto || '');
    const codigos = String(p.codigos).split(',').map(c => c.trim()).filter(Boolean);
    for (const codigo of codigos) {
      rows.push({ idProducto, codigo, nombre });
    }
  }
  return rows;
}

async function refreshCatalogFromSource(sourceKey) {
  const config = SOURCE_CONFIG[sourceKey];
  const metaId = config.id;

  const lockResult = await pool.query(
    `UPDATE catalog_metadata SET sync_in_progress = true
     WHERE id = $1 AND sync_in_progress = false RETURNING id`,
    [metaId]
  );
  if (lockResult.rowCount === 0) {
    const err = new Error(`Ya hay una sincronizacion en curso para ${config.label}`);
    err.code = 'SYNC_IN_PROGRESS';
    throw err;
  }

  const client = await pool.connect();
  try {
    const rawProducts = await fetchSourceCatalog(sourceKey);
    const rows = normalizeProducts(rawProducts);
    if (rows.length === 0) {
      throw new Error(`La API ${config.label} devolvio un catalogo vacio`);
    }

    await client.query('BEGIN');
    await client.query(`
      CREATE TEMP TABLE product_catalog_tmp (
        id_producto VARCHAR(50) NOT NULL,
        codigo VARCHAR(100) NOT NULL,
        nombre TEXT NOT NULL,
        rubro TEXT NOT NULL DEFAULT '',
        fuente VARCHAR(50) NOT NULL
      ) ON COMMIT DROP
    `);

    // Insertar en lotes
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH);
      const values = [];
      const placeholders = [];
      slice.forEach((r, idx) => {
        const base = idx * 4;
        placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
        values.push(r.idProducto, r.codigo, r.nombre, sourceKey);
      });
      await client.query(
        `INSERT INTO product_catalog_tmp (id_producto, codigo, nombre, fuente)
         VALUES ${placeholders.join(',')}`,
        values
      );
    }

    // Borrar solo los productos de ESTA fuente (preserva los de la otra)
    await client.query('DELETE FROM product_catalog WHERE fuente = $1', [sourceKey]);
    await client.query(`
      INSERT INTO product_catalog (id_producto, codigo, nombre, rubro, fuente)
      SELECT id_producto, codigo, nombre, rubro, fuente FROM product_catalog_tmp
    `);
    await client.query(
      `UPDATE catalog_metadata SET
         last_sync_at = NOW(),
         last_sync_status = 'ok',
         last_sync_error = NULL,
         total_products = $1
       WHERE id = $2`,
      [rows.length, metaId]
    );
    await client.query('COMMIT');
    console.log(`Catalogo ${config.label} sincronizado: ${rows.length} entradas`);
    return { total: rows.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    await pool.query(
      `UPDATE catalog_metadata SET
         last_sync_at = NOW(),
         last_sync_status = 'error',
         last_sync_error = $1
       WHERE id = $2`,
      [err.message.slice(0, 500), metaId]
    );
    throw err;
  } finally {
    await pool.query(`UPDATE catalog_metadata SET sync_in_progress = false WHERE id = $1`, [metaId]);
    client.release();
  }
}

// GET catalogo (todos los autenticados)
app.get('/api/catalogo', authRequired, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id_producto AS "Id", codigo AS "Codigo", nombre AS "Nombre", rubro AS "Rubro"
       FROM product_catalog ORDER BY nombre ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error('Error al obtener catalogo:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Estado del catalogo (todas las fuentes)
app.get('/api/catalogo/status', authRequired, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM catalog_metadata ORDER BY id');
    const result = {};
    for (const meta of rows) {
      result[meta.source] = {
        last_sync_at: meta.last_sync_at,
        last_sync_status: meta.last_sync_status,
        last_sync_error: meta.last_sync_error,
        total_products: meta.total_products || 0,
        source: meta.source,
        sync_in_progress: meta.sync_in_progress || false
      };
    }
    res.json(result);
  } catch (err) {
    console.error('Error al obtener estado catalogo:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Refresh manual (solo admin)
app.post('/api/catalogo/refresh', authRequired, adminRequired, async (req, res) => {
  const fuente = req.body.fuente || 'all';
  const sourcesToSync = fuente === 'all'
    ? Object.keys(SOURCE_CONFIG)
    : [fuente];

  // Validar fuentes
  for (const s of sourcesToSync) {
    if (!SOURCE_CONFIG[s]) {
      return res.status(400).json({ error: `Fuente desconocida: ${s}` });
    }
    const cfg = SOURCE_CONFIG[s];
    if (!cfg.baseUrl() || !cfg.token()) {
      return res.status(400).json({ error: `Fuente ${cfg.label} no tiene configuracion completa en .env` });
    }
  }

  // Verificar locks
  for (const s of sourcesToSync) {
    const { rows } = await pool.query(
      'SELECT sync_in_progress FROM catalog_metadata WHERE id = $1',
      [SOURCE_CONFIG[s].id]
    );
    if (rows[0] && rows[0].sync_in_progress) {
      return res.status(409).json({ error: `Ya hay una sincronizacion en curso para ${SOURCE_CONFIG[s].label}` });
    }
  }

  // Responder inmediato y correr en background
  res.status(202).json({ message: 'Sincronizacion iniciada', fuentes: sourcesToSync });
  for (const s of sourcesToSync) {
    refreshCatalogFromSource(s).catch(err => {
      console.error(`Error en refresh de ${s}:`, err.message);
    });
  }
});

// Sync inicial al arrancar si alguna fuente esta vacia
async function initialCatalogSyncIfNeeded() {
  for (const [sourceKey, config] of Object.entries(SOURCE_CONFIG)) {
    try {
      // Skip si la fuente no tiene configuracion
      if (!config.baseUrl() || !config.token()) {
        console.log(`Catalogo ${config.label}: sin configuracion en .env, omitiendo sync`);
        continue;
      }
      const { rows } = await pool.query(
        'SELECT COUNT(*)::int AS count FROM product_catalog WHERE fuente = $1',
        [sourceKey]
      );
      if (rows[0].count === 0) {
        console.log(`Catalogo ${config.label} vacio, iniciando sync inicial en background...`);
        refreshCatalogFromSource(sourceKey).catch(err => {
          console.error(`Error en sync inicial de ${sourceKey}:`, err.message);
        });
      } else {
        console.log(`Catalogo ${config.label} cargado con ${rows[0].count} entradas`);
      }
    } catch (err) {
      console.error(`Error verificando catalogo ${sourceKey}:`, err.message);
    }
  }
}

// Health check para indicador de conexion
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`Servidor listo en puerto ${PORT}`);
  dbReady.then(() => initialCatalogSyncIfNeeded());
});
