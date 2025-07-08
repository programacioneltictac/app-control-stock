require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const exceljs = require('exceljs');
const basicAuth = require('express-basic-auth');
const app = express();

// Configuración de PostgreSQL para Render
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { 
    rejectUnauthorized: false // Necesario para Render
  }
});

// Middlewares
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  next();
});

app.use(express.json());
app.use(basicAuth({
  users: { 
    [process.env.AUTH_USER]: process.env.AUTH_PASSWORD 
  },
  challenge: true,
  unauthorizedResponse: 'Acceso no autorizado. Necesitas credenciales válidas.'
}));

// Helper functions
function getSessionId(req) {
  return req.headers['authorization'] || 'anonymous';
}

async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS scanned_products (
        id SERIAL PRIMARY KEY,
        code INTEGER NOT NULL,
        name TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('Tabla creada/verificada en PostgreSQL');
  } catch (err) {
    console.error('Error al inicializar la base de datos:', err);
    process.exit(1);
  }
}

// Inicializar la base de datos al iniciar
initDatabase();

// Endpoints
app.post('/save', async (req, res) => {
  const { code, name, quantity } = req.body;
  const sessionId = getSessionId(req);

  if (!code || !name || !quantity) {
    return res.status(400).json({ error: 'Faltan datos requeridos' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO scanned_products (code, name, quantity, session_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [code, name, quantity, sessionId]
    );
    res.status(200).json({ 
      message: 'Registro guardado exitosamente', 
      id: result.rows[0].id 
    });
  } catch (err) {
    console.error('Error al guardar:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.put('/save/:id', async (req, res) => {
  const { code, name, quantity } = req.body;
  const sessionId = getSessionId(req);
  const id = req.params.id;

  if (!code || !name || !quantity || !id) {
    return res.status(400).json({ error: 'Faltan datos requeridos' });
  }

  try {
    const result = await pool.query(
      `UPDATE scanned_products 
       SET code = $1, name = $2, quantity = $3 
       WHERE id = $4 AND session_id = $5`,
      [code, name, quantity, id, sessionId]
    );
    
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Registro no encontrado' });
    }
    
    res.status(200).json({ message: 'Registro actualizado exitosamente' });
  } catch (err) {
    console.error('Error al actualizar:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.delete('/delete/:id', async (req, res) => {
  const sessionId = getSessionId(req);
  const id = req.params.id;

  if (!id || isNaN(id)) {
    return res.status(400).json({ error: 'ID inválido' });
  }

  try {
    const result = await pool.query(
      `DELETE FROM scanned_products 
       WHERE id = $1 AND session_id = $2`,
      [id, sessionId]
    );
    
    if (result.rowCount === 0) {
      return res.status(404).json({ 
        error: 'Registro no encontrado o no pertenece a esta sesión' 
      });
    }
    
    res.status(200).json({ message: 'Registro eliminado exitosamente' });
  } catch (err) {
    console.error('Error al eliminar:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/records', async (req, res) => {
  const sessionId = getSessionId(req);
  
  try {
    const { rows } = await pool.query(
      `SELECT * FROM scanned_products WHERE session_id = $1`,
      [sessionId]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error al recuperar registros:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/recover', async (req, res) => {
  const sessionId = getSessionId(req);
  
  try {
    const { rows } = await pool.query(
      `SELECT * FROM scanned_products WHERE session_id = $1`,
      [sessionId]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error al recuperar datos:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/export', async (req, res) => {
  const sessionId = getSessionId(req);
  
  try {
    const { rows } = await pool.query(
      `SELECT code, name, SUM(quantity) as total_quantity
       FROM scanned_products 
       WHERE session_id = $1
       GROUP BY code, name`,
      [sessionId]
    );

    const workbook = new exceljs.Workbook();
    const worksheet = workbook.addWorksheet('Productos Escaneados');
    
    worksheet.columns = [
      { header: 'Código', key: 'code', width: 15 },
      { header: 'Nombre', key: 'name', width: 50 },
      { header: 'Cantidad Total', key: 'total_quantity', width: 15 }
    ];
    
    worksheet.addRows(rows);

    const buffer = await workbook.xlsx.writeBuffer();
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=inventario_${new Date().toISOString().split('T')[0]}.xlsx`);
    res.send(buffer);

    // Limpiar la base de datos después de exportar
    await pool.query(
      `DELETE FROM scanned_products WHERE session_id = $1`,
      [sessionId]
    );
  } catch (err) {
    console.error('Error al exportar:', err);
    res.status(500).json({ error: 'Error al generar el reporte' });
  }
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor listo en http://localhost:${PORT}`);
});