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

initDatabase();

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

// Health check para indicador de conexion
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`Servidor listo en puerto ${PORT}`);
});
