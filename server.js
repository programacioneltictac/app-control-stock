require('dotenv').config();
const path = require('path');
const express = require('express');
const { Pool } = require('pg');
const exceljs = require('exceljs');
const basicAuth = require('express-basic-auth');
const fs = require('fs'); // Añadido para manejo de archivos

const app = express();
const PORT = process.env.PORT || 10000;

// Configuración de PostgreSQL para Render
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { 
    rejectUnauthorized: false 
  } : false
});

// Middlewares
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Servir archivos estáticos desde /public

// Helper functions
function getSessionId(req) {
  return req.headers['authorization'] || 'anonymous';
}

async function initDatabase() {
  try {
    const client = await pool.connect();
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
    client.release();
    console.log('Tabla creada/verificada en PostgreSQL');
  } catch (err) {
    console.error('Error al inicializar la base de datos:', err);
    console.error('Connection String:', process.env.DATABASE_URL); // Para debugging
    process.exit(1);
  }
}

// Inicializar la base de datos al iniciar
initDatabase();

// Endpoints
app.post('/save', async (req, res) => {
  const { code, name, quantity } = req.body;
  const sessionId = getSessionId(req);

  console.log('Datos recibidos:', { code, name, quantity }); // Para debugging

  // Validación de campos requeridos
  if (!code || !name || !quantity) {
    return res.status(400).json({ 
      error: 'Faltan datos requeridos',
      details: {
        received: req.body,
        required: ['code', 'name', 'quantity']
      }
    });
  }

  // Convertir código a string si es número
  if (typeof code === 'number') {
    code = code.toString();
  }

  // Validación adicional para el código como texto
  if (typeof code !== 'string') {
    return res.status(400).json({ 
      error: 'El código debe ser una cadena de texto',
      received_type: typeof code,
      example_valid_format: 'ABC123 o 123456'
    });
  }

  // Validación de longitud máxima (opcional pero recomendado)
  if (code.length > 50) {
    return res.status(400).json({
      error: 'El código es demasiado largo',
      max_length_allowed: 50,
      received_length: code.length
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO scanned_products (code, name, quantity, session_id)
       VALUES ($1::VARCHAR, $2, $3::INTEGER, $4) RETURNING id`,
      [code, name, parseInt(quantity), sessionId]
    );
    
    res.status(200).json({ 
      message: 'Registro guardado exitosamente', 
      id: result.rows[0].id 
    });
  } catch (err) {
    console.error('Error al guardar:', err);
    res.status(500).json({ 
      error: 'Error interno del servidor',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
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
       SET code = $1::VARCHAR, name = $2, quantity = $3 
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

// Nuevo endpoint para servir el index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Nuevo endpoint para servir control.html
app.get('/control', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'control.html'));
});

// Endpoint para servir productos.json
app.get('/productos.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'productos.json'));
});

// Endpoint para servir usuarios.json
app.get('/usuarios.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'usuarios.json'));
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`Servidor listo en puerto ${PORT}`);
  console.log(`URL: https://app-control-stock.onrender.com`);
});