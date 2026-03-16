// ── 1. IMPORTAÇÕES ──────────────────────────────────────────
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { criarPaginaNotion, atualizarStatusNotion, atualizarPaginaNotion, cancelarPaginaNotion, arquivarPaginaNotion, sincronizarTodasReservas, notionConfigurado } = require('./notion');

// ── 2. CONFIGURAÇÃO ─────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('❌ ERRO FATAL: JWT_SECRET não definido. Crie o arquivo .env com JWT_SECRET=<segredo_forte>');
  process.exit(1);
}

app.use(cors()); // Aceita qualquer origem — seguro para rede interna
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── 3. BANCO DE DADOS PostgreSQL ────────────────────────────
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

// Testar a conexão no início
pool.connect()
  .then(client => {
    console.log('✅ Conectado ao PostgreSQL com sucesso!');
    client.release();
  })
  .catch(err => {
    console.error('❌ Erro ao conectar no PostgreSQL. Verifique suas credenciais em .env', err.message);
  });

// ── 4. SERVER-SENT EVENTS ────────────────────────────────────
/** Conjunto de respostas SSE ativas (um por aba aberta) */
const sseClients = new Set();

/** Notifica todos os clientes conectados que houve uma atualização */
function notificarClientes(evento = 'atualizacao') {
  for (const client of sseClients) {
    client.write(`event: ${evento}\ndata: ok\n\n`);
  }
}

// ============================================================
// 4. INICIALIZAÇÃO E MIGRAÇÃO DO BANCO
// ============================================================

/** Cria as tabelas e insere dados iniciais se o banco estiver vazio */
async function inicializarBanco() {
  try {
    // Tabela de usuários
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id    SERIAL PRIMARY KEY,
        nome  VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        senha VARCHAR(255) NOT NULL,
        role  VARCHAR(50)  NOT NULL DEFAULT 'gestor' CHECK(role IN ('admin', 'gestor'))
      )
    `);

    // Tabela de reservas
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reservas (
        id                    SERIAL PRIMARY KEY,
        usuario_id            INTEGER NOT NULL,
        titulo                VARCHAR(255) NOT NULL,
        data                  VARCHAR(10)  NOT NULL,
        horaInicio            VARCHAR(5)   NOT NULL,
        horaFim               VARCHAR(5)   NOT NULL,
        status                VARCHAR(50)  NOT NULL DEFAULT 'confirmada' CHECK(status IN ('confirmada', 'pendente', 'cancelada')),
        modalidade            VARCHAR(50)  NOT NULL DEFAULT 'presencial' CHECK(modalidade IN ('presencial', 'online')),
        link_reuniao          TEXT,
        pre_ata               TEXT,
        participantes         TEXT,
        notion_page_id        VARCHAR(255),
        notion_status_enviado VARCHAR(50),
        motivo_cancelamento   TEXT,
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
      )
    `);

    // Adiciona colunas novas se estiver migrando de uma versão antiga
    await migrarBanco();

    // Tabela de presenças
    await pool.query(`
      CREATE TABLE IF NOT EXISTS presencas (
        id         SERIAL PRIMARY KEY,
        reserva_id INTEGER NOT NULL,
        usuario_id INTEGER NOT NULL,
        UNIQUE(reserva_id, usuario_id),
        FOREIGN KEY (reserva_id) REFERENCES reservas(id) ON DELETE CASCADE,
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
      )
    `);

    // Seed: cria o admin padrão se não existir nenhum
    const adminCheck = await pool.query("SELECT id FROM usuarios WHERE role = 'admin'");
    if (adminCheck.rows.length === 0) {
      // Usa ADMIN_PASSWORD do .env; se não definida, usa a senha padrão como fallback
      const senhaAdmin = process.env.ADMIN_PASSWORD || 'Cna!@#123';
      if (!process.env.ADMIN_PASSWORD) {
        console.warn('⚠️  ADMIN_PASSWORD não definida no .env — usando senha padrão. Defina-a para maior segurança.');
      }
      const senhaHash = bcrypt.hashSync(senhaAdmin, 10);

      await pool.query(`INSERT INTO usuarios (nome, email, senha, role) VALUES ($1, $2, $3, $4)`, [
        'Administrador', 'ti@canaatelecom.com.br', senhaHash, 'admin'
      ]);
      console.log('✅ Admin padrão criado: ti@canaatelecom.com.br');

      const adminIdRes = await pool.query("SELECT id FROM usuarios WHERE role = 'admin'");
      const adminId = adminIdRes.rows[0].id;
      const dataHoje = hoje();

      // Dados de demonstração com os novos campos
      const demos = [
        [adminId, 'Planejamento Q3', dataHoje, '08:00', '09:30', 'confirmada', 'presencial', null],
        [adminId, 'Daily Standup', dataHoje, '10:00', '11:00', 'confirmada', 'presencial', null],
        [adminId, 'Reunião com Fornecedor', dataHoje, '14:00', '15:00', 'pendente', 'presencial', null],
        [adminId, 'Review de Sprint (Online)', dataHoje, '16:00', '17:00', 'confirmada', 'online', 'https://meet.google.com/abc-defg-hij'],
      ];

      for (const d of demos) {
        await pool.query(`
          INSERT INTO reservas (usuario_id, titulo, data, horaInicio, horaFim, status, modalidade, link_reuniao)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, d);
      }
    }
  } catch (err) {
    console.error("❌ Erro na inicialização do banco de dados PostgreSQL:", err);
  }
}

/**
 * Migração: adiciona colunas que não existem (equivalente ao PRAGMA do SQLite).
 * O PostgreSQL utiliza o information_schema para checar colunas.
 */
async function migrarBanco() {
  try {
    const colRes = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'reservas'");
    const colunas = colRes.rows.map(c => c.column_name);

    if (!colunas.includes('modalidade')) {
      await pool.query("ALTER TABLE reservas ADD COLUMN modalidade VARCHAR(50) NOT NULL DEFAULT 'presencial'");
      console.log('✅ Migração: coluna modalidade adicionada');
    }
    if (!colunas.includes('link_reuniao')) {
      await pool.query("ALTER TABLE reservas ADD COLUMN link_reuniao TEXT");
      console.log('✅ Migração: coluna link_reuniao adicionada');
    }
    if (!colunas.includes('pre_ata')) {
      await pool.query("ALTER TABLE reservas ADD COLUMN pre_ata TEXT");
      console.log('✅ Migração: coluna pre_ata adicionada');
    }
    if (!colunas.includes('participantes')) {
      await pool.query("ALTER TABLE reservas ADD COLUMN participantes TEXT");
      console.log('✅ Migração: coluna participantes adicionada');
    }
    if (!colunas.includes('notion_page_id')) {
      await pool.query("ALTER TABLE reservas ADD COLUMN notion_page_id VARCHAR(255)");
      console.log('✅ Migração: coluna notion_page_id adicionada');
    }
    if (!colunas.includes('notion_status_enviado')) {
      await pool.query("ALTER TABLE reservas ADD COLUMN notion_status_enviado VARCHAR(50)");
      console.log('✅ Migração: coluna notion_status_enviado adicionada');
    }
    if (!colunas.includes('motivo_cancelamento')) {
      await pool.query("ALTER TABLE reservas ADD COLUMN motivo_cancelamento TEXT");
      console.log('✅ Migração: coluna motivo_cancelamento adicionada');
    }
  } catch (err) {
    console.error("❌ Erro durante a migração do banco:", err);
  }
}

// ============================================================
// 5. FUNÇÕES AUXILIARES
// ============================================================

/** Retorna a data de hoje no formato YYYY-MM-DD (fuso local do servidor) */
function hoje() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Converte "HH:MM" para minutos totais */
function horaParaMinutos(hora) {
  const [h, m] = hora.split(':').map(Number);
  return h * 60 + m;
}

/** Retorna true se dois intervalos de tempo se sobrepõem */
function temConflito(inicio1, fim1, inicio2, fim2) {
  return horaParaMinutos(inicio1) < horaParaMinutos(fim2) &&
    horaParaMinutos(fim1) > horaParaMinutos(inicio2);
}

/** Valida formato YYYY-MM-DD */
function isDataValida(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str) && !isNaN(Date.parse(str));
}

/** Valida formato HH:MM */
function isHoraValida(str) {
  if (!/^\d{2}:\d{2}$/.test(str)) return false;
  const [h, m] = str.split(':').map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

/** Retorna a hora atual no formato "HH:MM" */
function horaAtual() {
  const agora = new Date();
  return `${String(agora.getHours()).padStart(2, '0')}:${String(agora.getMinutes()).padStart(2, '0')}`;
}

/**
 * Calcula o status real de uma reunião com base na data e hora atuais.
 * @param {object} r - Objeto da reserva com campos data, horaInicio, horaFim
 * @returns {'Concluída'|'Em andamento'|'Agendada'}
 */
function calcularStatusDinamico(r) {
  // Reunião cancelada: o status manual sempre prevalece
  if (r.status === 'cancelada') return 'Cancelada';

  const agora = horaAtual();
  const dataHoje = hoje();

  if (r.data < dataHoje) return 'Concluída';
  if (r.data > dataHoje) return 'Agendada';

  // Mesmo dia: compara por horário
  // PostgreSQL retorna colunas em minúsculas, então aceitamos os dois formatos
  const horaIni = r.horainicio || r.horaInicio;
  const horaFi = r.horafim || r.horaFim;

  const agoraMin = horaParaMinutos(agora);
  const inicioMin = horaParaMinutos(horaIni);
  const fimMin = horaParaMinutos(horaFi);

  if (agoraMin >= fimMin) return 'Concluída';
  if (agoraMin >= inicioMin) return 'Em andamento';
  return 'Agendada';
}

// ============================================================
// 6. MIDDLEWARES DE AUTENTICAÇÃO
// ============================================================

function autenticar(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ erro: true, mensagem: 'Token não fornecido. Faça login.' });
  }
  try {
    req.usuario = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ erro: true, mensagem: 'Token inválido ou expirado.' });
  }
}

function apenasAdmin(req, res, next) {
  if (req.usuario.role !== 'admin') {
    return res.status(403).json({ erro: true, mensagem: 'Acesso negado. Somente administradores.' });
  }
  next();
}

// ============================================================
// 7. ROTAS DA API
// ============================================================

// ── GET /api/eventos (SSE) ───────────────────────────────────
app.get('/api/eventos', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write(': conectado\n\n');

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ── POST /api/login ──────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    if (!email || !senha) {
      return res.status(400).json({ erro: true, mensagem: 'E-mail e senha são obrigatórios.' });
    }

    const { rows } = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);
    const usuario = rows[0];

    if (!usuario || !bcrypt.compareSync(senha, usuario.senha)) {
      return res.status(401).json({ erro: true, mensagem: 'E-mail ou senha incorretos.' });
    }

    const token = jwt.sign(
      { id: usuario.id, nome: usuario.nome, email: usuario.email, role: usuario.role },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({
      erro: false,
      mensagem: `Bem-vindo, ${usuario.nome}!`,
      token,
      usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email, role: usuario.role }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: true, mensagem: 'Erro ao fazer login no servidor' });
  }
});

// ── GET /api/status ──────────────────────────────────────────
app.get('/api/status', async (req, res) => {
  try {
    const agora = horaAtual();
    const dataHoje = hoje();

    // Reunião presencial ativa agora
    const reservaAtivaRes = await pool.query(`
      SELECT r.*, u.nome AS gestor
      FROM reservas r JOIN usuarios u ON u.id = r.usuario_id
      WHERE r.data = $1 AND r.status = 'confirmada' AND r.modalidade = 'presencial'
        AND r.horainicio <= $2 AND r.horafim > $3
    `, [dataHoje, agora, agora]);

    // Reunião online ativa agora
    const reuniaoOnlineAtivaRes = await pool.query(`
      SELECT r.*, u.nome AS gestor
      FROM reservas r JOIN usuarios u ON u.id = r.usuario_id
      WHERE r.data = $1 AND r.status = 'confirmada' AND r.modalidade = 'online'
        AND r.horainicio <= $2 AND r.horafim > $3
    `, [dataHoje, agora, agora]);

    // Próxima reunião confirmada de hoje (qualquer modalidade)
    const proximaReuniaoRes = await pool.query(`
      SELECT r.*, u.nome AS gestor
      FROM reservas r JOIN usuarios u ON u.id = r.usuario_id
      WHERE r.data = $1 AND r.status = 'confirmada' AND r.horainicio > $2
      ORDER BY r.horainicio ASC LIMIT 1
    `, [dataHoje, agora]);

    const reunioesHojeRes = await pool.query(`
      SELECT COUNT(*) AS total FROM reservas WHERE data = $1 AND status = 'confirmada'
    `, [dataHoje]);

    const pendentesRes = await pool.query(`
      SELECT COUNT(*) AS total FROM reservas WHERE status = 'pendente'
    `);

    res.json({
      salaLivre: reservaAtivaRes.rows.length === 0,
      reservaAtiva: reservaAtivaRes.rows[0] || null,
      reuniaoOnlineAtiva: reuniaoOnlineAtivaRes.rows[0] || null,
      proximaReuniao: proximaReuniaoRes.rows[0] || null,
      reunioesHoje: parseInt(reunioesHojeRes.rows[0].total, 10),
      pendentes: parseInt(pendentesRes.rows[0].total, 10),
      horaAtual: agora
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: true, mensagem: 'Erro interno ao buscar status' });
  }
});

// ── GET /api/reservas ────────────────────────────────────────
app.get('/api/reservas', autenticar, async (req, res) => {
  try {
    const dataHoje = hoje();
    const usuarioId = req.usuario.id;

    const reservasRes = await pool.query(`
      SELECT r.*,
             u.nome AS gestor,
             (SELECT COUNT(*) FROM presencas p WHERE p.reserva_id = r.id) AS confirmados,
             (SELECT COUNT(*) FROM presencas p WHERE p.reserva_id = r.id AND p.usuario_id = $1) AS "euConfirmei",
             (SELECT STRING_AGG(u2.nome, '||') FROM presencas p2
              JOIN usuarios u2 ON u2.id = p2.usuario_id
              WHERE p2.reserva_id = r.id) AS "participantesNomes"
      FROM reservas r JOIN usuarios u ON u.id = r.usuario_id
      WHERE r.data >= $2
      ORDER BY r.data ASC, r.horainicio ASC
    `, [usuarioId, dataHoje]);

    const comStatus = reservasRes.rows.map(r => {
      // PostgreSQL retorna colunas em minúsculas; normalizamos para camelCase
      const checkEuConfirmei = r.euconfirmei ?? r.euConfirmei;
      const partNomes = r.participantesnomes || r.participantesNomes;
      const horaInicio = r.horainicio || r.horaInicio;
      const horaFim = r.horafim || r.horaFim;

      return {
        ...r,
        horaInicio,
        horaFim,
        statusDinamico: calcularStatusDinamico(r),
        euConfirmei: parseInt(checkEuConfirmei, 10) > 0,
        confirmados: parseInt(r.confirmados, 10),
        participantesNomes: partNomes ? partNomes.split('||') : []
      };
    });

    res.json(comStatus);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: true, mensagem: 'Erro interno do servidor' });
  }
});

// ── POST /api/reservas ───────────────────────────────────────
app.post('/api/reservas', autenticar, async (req, res) => {
  try {
    const {
      titulo, data, horaInicio, horaFim,
      modalidade = 'presencial', link_reuniao,
      pre_ata
    } = req.body;
    const usuario_id = req.usuario.id;

    if (!titulo || !data || !horaInicio || !horaFim) {
      return res.status(400).json({ erro: true, mensagem: 'Todos os campos são obrigatórios.' });
    }
    if (!isDataValida(data)) {
      return res.status(400).json({ erro: true, mensagem: 'Formato de data inválido. Use YYYY-MM-DD.' });
    }
    if (!isHoraValida(horaInicio) || !isHoraValida(horaFim)) {
      return res.status(400).json({ erro: true, mensagem: 'Formato de hora inválido. Use HH:MM.' });
    }
    if (modalidade === 'online' && !link_reuniao) {
      return res.status(400).json({ erro: true, mensagem: 'Reuniões online exigem um link de acesso.' });
    }
    if (pre_ata && pre_ata.length > 600) {
      return res.status(400).json({ erro: true, mensagem: 'A pré-ata não pode ultrapassar 600 caracteres.' });
    }
    if (horaParaMinutos(horaInicio) >= horaParaMinutos(horaFim)) {
      return res.status(400).json({ erro: true, mensagem: 'A hora de início deve ser anterior ao término.' });
    }

    if (modalidade === 'presencial') {
      const reservasDaData = await pool.query(`
        SELECT * FROM reservas
        WHERE data = $1 AND status = 'confirmada' AND modalidade = 'presencial'
      `, [data]);

      const conflito = reservasDaData.rows.find(r => {
        const rInicio = r.horainicio || r.horaInicio;
        const rFim = r.horafim || r.horaFim;
        return temConflito(horaInicio, horaFim, rInicio, rFim);
      });

      if (conflito) {
        const cInicio = conflito.horainicio || conflito.horaInicio;
        const cFim = conflito.horafim || conflito.horaFim;
        return res.status(409).json({
          erro: true,
          tipoConflito: 'sala',
          mensagem: `Conflito de horário! A sala já está ocupada por "${conflito.titulo}" das ${cInicio} às ${cFim}.`
        });
      }
    }

    // Cria a reserva
    const insertRes = await pool.query(`
      INSERT INTO reservas (usuario_id, titulo, data, horaInicio, horaFim, status, modalidade, link_reuniao, pre_ata)
      VALUES ($1, $2, $3, $4, $5, 'confirmada', $6, $7, $8)
      RETURNING id
    `, [usuario_id, titulo, data, horaInicio, horaFim, modalidade, link_reuniao || null, pre_ata || null]);

    const novaId = insertRes.rows[0].id;

    const novaReservaRes = await pool.query(`
      SELECT r.*, u.nome AS gestor,
             0 AS confirmados, 0 AS "euConfirmei"
      FROM reservas r JOIN usuarios u ON u.id = r.usuario_id
      WHERE r.id = $1
    `, [novaId]);

    const novaReserva = novaReservaRes.rows[0];

    res.status(201).json({
      erro: false,
      mensagem: 'Reserva criada com sucesso!',
      reserva: { ...novaReserva, statusDinamico: calcularStatusDinamico(novaReserva), euConfirmei: false, confirmados: 0, participantesNomes: [] }
    });
    notificarClientes();

    // Envia para o Notion de forma assíncrona
    const statusParaNotion = calcularStatusDinamico(novaReserva);
    criarPaginaNotion(novaReserva, [], statusParaNotion).then(async notionPageId => {
      if (notionPageId) {
        await pool.query('UPDATE reservas SET notion_page_id = $1, notion_status_enviado = $2 WHERE id = $3',
          [notionPageId, statusParaNotion, novaReserva.id]).catch(() => { });
      }
    }).catch(() => { });

  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: true, mensagem: 'Erro ao criar reserva' });
  }
});

// ── PATCH /api/reservas/:id/cancelar ────────────────────────
app.patch('/api/reservas/:id/cancelar', autenticar, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { motivo } = req.body;

    const reservaRes = await pool.query('SELECT * FROM reservas WHERE id = $1', [id]);
    const reserva = reservaRes.rows[0];
    if (!reserva) {
      return res.status(404).json({ erro: true, mensagem: 'Reserva não encontrada.' });
    }

    if (reserva.usuario_id !== req.usuario.id) {
      return res.status(403).json({ erro: true, mensagem: 'Somente o criador da reunião pode cancelá-la.' });
    }
    if (reserva.status === 'cancelada') {
      return res.status(400).json({ erro: true, mensagem: 'Esta reunião já está cancelada.' });
    }

    await pool.query('UPDATE reservas SET status = $1, motivo_cancelamento = $2 WHERE id = $3',
      ['cancelada', motivo?.trim() || null, id]);

    notificarClientes();
    res.json({ erro: false, mensagem: 'Reunião cancelada com sucesso.' });

    console.log(`🔍 Debug cancelamento #${id}: notion_page_id = "${reserva.notion_page_id}", motivo = "${motivo?.trim() || '(vazio)'}"`);
    if (reserva.notion_page_id) {
      cancelarPaginaNotion(reserva.notion_page_id, motivo?.trim() || '')
        .catch(err => console.error('Notion: erro ao atualizar cancelamento:', err.message));
    } else {
      console.warn(`⚠️  Reunião #${id} cancelada, mas sem notion_page_id — Notion não foi atualizado.`);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: true, mensagem: 'Erro interno ao cancelar' });
  }
});

// ── DELETE /api/reservas/:id ─────────────────────────────────
app.delete('/api/reservas/:id', autenticar, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const reservaRes = await pool.query('SELECT * FROM reservas WHERE id = $1', [id]);
    const reserva = reservaRes.rows[0];

    if (!reserva) {
      return res.status(404).json({ erro: true, mensagem: 'Reserva não encontrada.' });
    }

    if (req.usuario.role !== 'admin' && reserva.usuario_id !== req.usuario.id) {
      return res.status(403).json({ erro: true, mensagem: 'Você só pode cancelar suas próprias reservas.' });
    }

    await pool.query('DELETE FROM reservas WHERE id = $1', [id]);
    notificarClientes();
    res.json({ erro: false, mensagem: 'Reserva apagada com sucesso.' });

    if (reserva.notion_page_id) {
      arquivarPaginaNotion(reserva.notion_page_id).catch(() => { });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: true, mensagem: 'Erro interno' });
  }
});

// ── DELETE /api/reservas/multiplas ───────────────────────────
app.delete('/api/reservas/multiplas', autenticar, apenasAdmin, async (req, res) => {
  try {
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ erro: true, mensagem: 'Nenhuma reserva selecionada.' });
    }

    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const reservasRes = await pool.query(`SELECT * FROM reservas WHERE id IN (${placeholders})`, ids);
    const reservasParaDeletar = reservasRes.rows;

    if (reservasParaDeletar.length === 0) {
      return res.status(404).json({ erro: true, mensagem: 'Nenhuma reserva encontrada para exclusão.' });
    }

    await pool.query(`DELETE FROM reservas WHERE id IN (${placeholders})`, ids);
    notificarClientes();

    res.json({
      erro: false,
      mensagem: `${reservasParaDeletar.length} reunião(ões) apagada(s) com sucesso.`,
      apagadas: reservasParaDeletar.length
    });

    reservasParaDeletar.forEach(reserva => {
      if (reserva.notion_page_id) {
        arquivarPaginaNotion(reserva.notion_page_id).catch(() => { });
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: true, mensagem: 'Erro ao remover multiplas' });
  }
});

// ── PATCH /api/reservas/multiplas/cancelar ───────────────────
app.patch('/api/reservas/multiplas/cancelar', autenticar, apenasAdmin, async (req, res) => {
  try {
    const { ids, motivo } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ erro: true, mensagem: 'Nenhuma reserva selecionada.' });
    }

    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const reservasRes = await pool.query(`SELECT * FROM reservas WHERE id IN (${placeholders})`, ids);
    const reservasParaCancelar = reservasRes.rows;

    if (reservasParaCancelar.length === 0) {
      return res.status(404).json({ erro: true, mensagem: 'Nenhuma reserva encontrada para cancelamento.' });
    }

    const justificativa = motivo?.trim() || null;

    // Concatena o valor do status cancelada e o valor do motivo aos IDs
    const currentParamsLength = ids.length;
    await pool.query(
      `UPDATE reservas SET status = 'cancelada', motivo_cancelamento = $${currentParamsLength + 1} WHERE id IN (${placeholders}) AND status != 'cancelada'`,
      [...ids, justificativa]
    );

    notificarClientes();

    res.json({
      erro: false,
      mensagem: `${reservasParaCancelar.length} reunião(ões) cancelada(s) com sucesso.`,
      canceladas: reservasParaCancelar.length
    });

    reservasParaCancelar.forEach(reserva => {
      if (reserva.status !== 'cancelada' && reserva.notion_page_id) {
        cancelarPaginaNotion(reserva.notion_page_id, justificativa || '')
          .catch(err => console.error('Notion: erro ao atualizar cancelamento em lote:', err.message));
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: true, mensagem: 'Erro interno' });
  }
});

// ── GET /api/notion/status ───────────────────────────────────
app.get('/api/notion/status', autenticar, (req, res) => {
  res.json({ configurado: notionConfigurado() });
});

// ── POST /api/notion/sync ────────────────────────────────────
app.post('/api/notion/sync', autenticar, apenasAdmin, async (req, res) => {
  try {
    const dataHoje = hoje();

    const reservasRes = await pool.query(`
      SELECT r.*, u.nome AS gestor,
             (SELECT STRING_AGG(u2.nome, '||') FROM presencas p2
              JOIN usuarios u2 ON u2.id = p2.usuario_id
              WHERE p2.reserva_id = r.id) AS "participantesNomes"
      FROM reservas r JOIN usuarios u ON u.id = r.usuario_id
      WHERE r.data >= $1
      ORDER BY r.data ASC, r.horaInicio ASC
    `, [dataHoje]);

    const reservasComStatus = reservasRes.rows.map(r => {
      const partNomes = r.participantesnomes || r.participantesNomes;
      const horaInicio = r.horainicio || r.horaInicio;
      const horaFim = r.horafim || r.horaFim;
      return {
        ...r,
        horaInicio,
        horaFim,
        statusDinamico: calcularStatusDinamico(r),
        participantesNomes: partNomes ? partNomes.split('||') : []
      };
    });

    const { criadas, atualizadas, novasIds } = await sincronizarTodasReservas(reservasComStatus);

    for (const { id, notionPageId, status } of novasIds) {
      await pool.query('UPDATE reservas SET notion_page_id = $1, notion_status_enviado = $2 WHERE id = $3',
        [notionPageId, status, id]);
    }

    const total = criadas + atualizadas;
    res.json({
      erro: false,
      mensagem: `Sincronização concluída: ${criadas} criada(s), ${atualizadas} atualizada(s).`,
      total
    });
  } catch (err) {
    console.error('Erro na sincronização com Notion:', err);
    res.status(500).json({ erro: true, mensagem: 'Erro ao sincronizar com o Notion.' });
  }
});

// ── PATCH /api/reservas/:id/presenca ──────────────────────────
app.patch('/api/reservas/:id/presenca', autenticar, async (req, res) => {
  try {
    const reservaId = parseInt(req.params.id);
    const usuarioId = req.usuario.id;

    const resReserva = await pool.query('SELECT id FROM reservas WHERE id = $1', [reservaId]);
    if (resReserva.rows.length === 0) return res.status(404).json({ erro: true, mensagem: 'Reserva não encontrada.' });

    const presRes = await pool.query('SELECT id FROM presencas WHERE reserva_id = $1 AND usuario_id = $2', [reservaId, usuarioId]);
    const jaConfirmou = presRes.rows.length > 0;

    if (jaConfirmou) {
      await pool.query('DELETE FROM presencas WHERE reserva_id = $1 AND usuario_id = $2', [reservaId, usuarioId]);
    } else {
      await pool.query('INSERT INTO presencas (reserva_id, usuario_id) VALUES ($1, $2)', [reservaId, usuarioId]);
    }

    const confRes = await pool.query('SELECT COUNT(*) AS total FROM presencas WHERE reserva_id = $1', [reservaId]);
    const confirmados = parseInt(confRes.rows[0].total, 10);

    res.json({
      erro: false,
      confirmou: !jaConfirmou,
      confirmados
    });
    notificarClientes();

    const compRes = await pool.query('SELECT * FROM reservas WHERE id = $1', [reservaId]);
    const reservaCompleta = compRes.rows[0];

    if (reservaCompleta?.notion_page_id) {
      const nomesRes = await pool.query(`
        SELECT u.nome FROM presencas p
        JOIN usuarios u ON u.id = p.usuario_id
        WHERE p.reserva_id = $1
      `, [reservaId]);

      const nomes = nomesRes.rows.map(r => r.nome);
      const statusAtual = calcularStatusDinamico(reservaCompleta);
      atualizarPaginaNotion(reservaCompleta.notion_page_id, nomes, statusAtual)
        .catch(err => console.error('Notion: erro ao atualizar confirmados:', err.message));
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: true, mensagem: 'Erro interno ao marcar presença' });
  }
});

// ── GET /api/historico ─────────────────────────────────────────
app.get('/api/historico', autenticar, async (req, res) => {
  try {
    const { id: usuarioId, role } = req.usuario;
    let historico;

    if (role === 'admin') {
      const histRes = await pool.query(`
        SELECT r.*, u.nome AS gestor, u.email AS "emailGestor",
               (SELECT COUNT(*) FROM presencas p WHERE p.reserva_id = r.id) AS confirmados,
               (SELECT COUNT(*) FROM presencas p WHERE p.reserva_id = r.id AND p.usuario_id = $1) AS "euConfirmei",
               (SELECT STRING_AGG(u2.nome, '||') FROM presencas p2
                JOIN usuarios u2 ON u2.id = p2.usuario_id
                WHERE p2.reserva_id = r.id) AS "participantesNomes"
        FROM reservas r JOIN usuarios u ON u.id = r.usuario_id
        ORDER BY r.data DESC, r.horaInicio ASC
      `, [usuarioId]);
      historico = histRes.rows;
    } else {
      const histRes = await pool.query(`
        SELECT r.*, u.nome AS gestor,
               (SELECT COUNT(*) FROM presencas p WHERE p.reserva_id = r.id) AS confirmados,
               (SELECT COUNT(*) FROM presencas p WHERE p.reserva_id = r.id AND p.usuario_id = $1) AS "euConfirmei",
               (SELECT STRING_AGG(u2.nome, '||') FROM presencas p2
                JOIN usuarios u2 ON u2.id = p2.usuario_id
                WHERE p2.reserva_id = r.id) AS "participantesNomes"
        FROM reservas r JOIN usuarios u ON u.id = r.usuario_id
        WHERE r.usuario_id = $1
        ORDER BY r.data DESC, r.horaInicio ASC
      `, [usuarioId]);
      historico = histRes.rows;
    }

    const comStatus = historico.map(r => {
      const checkEuConfirmei = r.euconfirmei ?? r.euConfirmei;
      const partNomes = r.participantesnomes || r.participantesNomes;
      const horaInicio = r.horainicio || r.horaInicio;
      const horaFim = r.horafim || r.horaFim;

      return {
        ...r,
        horaInicio,
        horaFim,
        statusDinamico: calcularStatusDinamico(r),
        euConfirmei: parseInt(checkEuConfirmei, 10) > 0,
        confirmados: parseInt(r.confirmados, 10),
        participantesNomes: partNomes ? partNomes.split('||') : []
      };
    });

    res.json(comStatus);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: true, mensagem: 'Erro interno ao buscar historico' });
  }
});

// ── DELETE /api/historico/concluidas ─────────────────────────
app.delete('/api/historico/concluidas', autenticar, apenasAdmin, async (req, res) => {
  try {
    const agora = horaAtual();
    const dataHoje = hoje();

    const delRes = await pool.query(`
      DELETE FROM reservas
      WHERE data < $1
         OR (data = $2 AND horaFim <= $3)
    `, [dataHoje, dataHoje, agora]);

    res.json({
      erro: false,
      mensagem: `${delRes.rowCount} reunião(ões) concluída(s) foram apagada(s).`,
      apagadas: delRes.rowCount
    });
    notificarClientes();
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: true, mensagem: 'Erro interno ao excluir concluídas' });
  }
});

// ── GET /api/estatisticas ────────────────────────────────────
app.get('/api/estatisticas', autenticar, async (req, res) => {
  try {
    const rankQtd = await pool.query(`
      SELECT u.nome, COUNT(r.id) AS "totalReservas"
      FROM reservas r JOIN usuarios u ON u.id = r.usuario_id
      WHERE r.status = 'confirmada'
      GROUP BY r.usuario_id, u.nome
      ORDER BY "totalReservas" DESC LIMIT 5
    `);

    // PostgreSQL SUBSTRING(X FROM Y FOR Z)
    const rankTempo = await pool.query(`
      SELECT u.nome,
        SUM(
          (CAST(SUBSTRING(r.horaFim FROM 1 FOR 2) AS INTEGER) * 60 + CAST(SUBSTRING(r.horaFim FROM 4 FOR 2) AS INTEGER)) -
          (CAST(SUBSTRING(r.horaInicio FROM 1 FOR 2) AS INTEGER) * 60 + CAST(SUBSTRING(r.horaInicio FROM 4 FOR 2) AS INTEGER))
        ) AS "totalMinutos"
      FROM reservas r JOIN usuarios u ON u.id = r.usuario_id
      WHERE r.status = 'confirmada'
      GROUP BY r.usuario_id, u.nome 
      ORDER BY "totalMinutos" DESC LIMIT 5
    `);

    const totais = await pool.query(`
      SELECT
        COUNT(*) AS "totalReservas",
        SUM(
          (CAST(SUBSTRING(horaFim FROM 1 FOR 2) AS INTEGER) * 60 + CAST(SUBSTRING(horaFim FROM 4 FOR 2) AS INTEGER)) -
          (CAST(SUBSTRING(horaInicio FROM 1 FOR 2) AS INTEGER) * 60 + CAST(SUBSTRING(horaInicio FROM 4 FOR 2) AS INTEGER))
        ) AS "totalMinutos"
      FROM reservas WHERE status = 'confirmada'
    `);

    res.json({
      rankingQuantidade: rankQtd.rows.map(r => ({ ...r, totalReservas: parseInt(r.totalReservas || r.totalreservas, 10) })),
      rankingTempo: rankTempo.rows.map(r => ({ ...r, totalMinutos: parseInt(r.totalMinutos || r.totalminutos, 10) })),
      totais: {
        totalReservas: parseInt(totais.rows[0].totalReservas || totais.rows[0].totalreservas, 10),
        totalMinutos: parseInt(totais.rows[0].totalMinutos || totais.rows[0].totalminutos, 10)
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: true, mensagem: 'Erro ao buscar estatisticas' });
  }
});

// ── Rota padrão ──────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================================
// 8.1 SINCRONIZAÇÃO PERIÓDICA DE STATUS COM O NOTION
// ============================================================

async function sincronizarStatusNotion() {
  if (!notionConfigurado()) return;

  try {
    const resReserva = await pool.query(`
      SELECT * FROM reservas
      WHERE notion_page_id IS NOT NULL
    `);
    const reservas = resReserva.rows;

    if (reservas.length === 0) return;

    let atualizadas = 0;
    for (const r of reservas) {
      const statusAtual = calcularStatusDinamico(r);
      if (statusAtual !== r.notion_status_enviado) {
        const ok = await atualizarStatusNotion(r.notion_page_id, statusAtual);
        if (ok) {
          await pool.query('UPDATE reservas SET notion_status_enviado = $1 WHERE id = $2', [statusAtual, r.id]);
          atualizadas++;
        }
      }
    }

    if (atualizadas > 0) {
      console.log(`🔄 Notion: ${atualizadas} status atualizado(s) automaticamente.`);
    }
  } catch (err) {
    console.error("Erro na sync notion automática:", err);
  }
}

// ============================================================
// 9. INICIALIZAÇÃO
// ============================================================

inicializarBanco().then(() => {
  app.listen(PORT, () => {
    console.log(`\n✅ Servidor Canaã Telecom v3.0 (PostgreSQL) rodando!`);
    console.log(`🌐 Acesse: http://localhost:${PORT}`);
    console.log(`🔑 Admin: ti@canaatelecom.com.br\n`);

    if (notionConfigurado()) {
      setTimeout(() => {
        sincronizarStatusNotion();
        setInterval(sincronizarStatusNotion, 5 * 60 * 1000);
      }, 60 * 1000);
      console.log('🔔 Notion: sincronização automática de status ativada (a cada 5 min).');
    }
  });
}).catch(err => {
  console.error("❌ Falha fatal ao inicializar aplicação:", err);
});
