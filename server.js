// ── 1. IMPORTAÇÕES ──────────────────────────────────────────
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const Database = require('better-sqlite3');
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

// ── 3. BANCO DE DADOS ────────────────────────────────────────
const db = new Database(path.join(__dirname, 'sala_reuniao.db'));

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
function inicializarBanco() {
  // Tabela de usuários
  db.exec(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      nome  TEXT    NOT NULL,
      email TEXT    NOT NULL UNIQUE,
      senha TEXT    NOT NULL,
      role  TEXT    NOT NULL DEFAULT 'gestor' CHECK(role IN ('admin', 'gestor'))
    )
  `);

  // Tabela de reservas
  db.exec(`
    CREATE TABLE IF NOT EXISTS reservas (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id            INTEGER NOT NULL,
      titulo                TEXT    NOT NULL,
      data                  TEXT    NOT NULL,
      horaInicio            TEXT    NOT NULL,
      horaFim               TEXT    NOT NULL,
      status                TEXT    NOT NULL DEFAULT 'confirmada' CHECK(status IN ('confirmada', 'pendente', 'cancelada')),
      modalidade            TEXT    NOT NULL DEFAULT 'presencial' CHECK(modalidade IN ('presencial', 'online')),
      link_reuniao          TEXT,
      pre_ata               TEXT,
      participantes         TEXT,
      notion_page_id        TEXT,
      notion_status_enviado TEXT,
      motivo_cancelamento   TEXT,
      FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
    )
  `);

  // Adiciona colunas novas em bancos criados antes da v2.1
  migrarBanco();

  // Seed: cria o admin padrão se não existir nenhum
  const jaExisteAdmin = db.prepare('SELECT id FROM usuarios WHERE role = ?').get('admin');
  if (!jaExisteAdmin) {
    // Usa ADMIN_PASSWORD do .env; se não definida, usa a senha padrão como fallback
    const senhaAdmin = process.env.ADMIN_PASSWORD || 'Cna!@#123';
    if (!process.env.ADMIN_PASSWORD) {
      console.warn('⚠️  ADMIN_PASSWORD não definida no .env — usando senha padrão. Defina-a para maior segurança.');
    }
    const senhaHash = bcrypt.hashSync(senhaAdmin, 10);
    db.prepare('INSERT INTO usuarios (nome, email, senha, role) VALUES (?, ?, ?, ?)').run(
      'Administrador', 'ti@canaatelecom.com.br', senhaHash, 'admin'
    );
    console.log('✅ Admin padrão criado: ti@canaatelecom.com.br');

    const adminId = db.prepare('SELECT id FROM usuarios WHERE role = ?').get('admin').id;
    const dataHoje = hoje();

    // Dados de demonstração com os novos campos
    const demos = [
      [adminId, 'Planejamento Q3', dataHoje, '08:00', '09:30', 'confirmada', 'presencial', null],
      [adminId, 'Daily Standup', dataHoje, '10:00', '11:00', 'confirmada', 'presencial', null],
      [adminId, 'Reunião com Fornecedor', dataHoje, '14:00', '15:00', 'pendente', 'presencial', null],
      [adminId, 'Review de Sprint (Online)', dataHoje, '16:00', '17:00', 'confirmada', 'online', 'https://meet.google.com/abc-defg-hij'],
    ];

    const stmt = db.prepare(`
      INSERT INTO reservas (usuario_id, titulo, data, horaInicio, horaFim, status, modalidade, link_reuniao)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    demos.forEach(d => stmt.run(...d));
  }
}

/**
 * Migração: adiciona colunas que não existem em bancos mais antigos.
 * SQLite não suporta IF NOT EXISTS em ALTER TABLE, por isso verificamos
 * manualmente via PRAGMA.
 */
function migrarBanco() {
  let colunas = db.prepare('PRAGMA table_info(reservas)').all().map(c => c.name);

  if (!colunas.includes('modalidade')) {
    db.exec("ALTER TABLE reservas ADD COLUMN modalidade TEXT NOT NULL DEFAULT 'presencial'");
    console.log('✅ Migração: coluna modalidade adicionada');
  }
  if (!colunas.includes('link_reuniao')) {
    db.exec('ALTER TABLE reservas ADD COLUMN link_reuniao TEXT');
    console.log('✅ Migração: coluna link_reuniao adicionada');
  }
  if (!colunas.includes('pre_ata')) {
    db.exec('ALTER TABLE reservas ADD COLUMN pre_ata TEXT');
    console.log('✅ Migração: coluna pre_ata adicionada');
  }
  if (!colunas.includes('participantes')) {
    db.exec('ALTER TABLE reservas ADD COLUMN participantes TEXT');
    console.log('✅ Migração: coluna participantes adicionada');
  }
  if (!colunas.includes('notion_page_id')) {
    db.exec('ALTER TABLE reservas ADD COLUMN notion_page_id TEXT');
    console.log('✅ Migração: coluna notion_page_id adicionada');
  }
  if (!colunas.includes('notion_status_enviado')) {
    db.exec('ALTER TABLE reservas ADD COLUMN notion_status_enviado TEXT');
    console.log('✅ Migração: coluna notion_status_enviado adicionada');
  }

  // Migração: atualiza CHECK constraint para incluir 'cancelada' e adiciona motivo_cancelamento
  // SQLite não suporta ALTER COLUMN, então recriamos a tabela se necessário.
  const tableSQL = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='reservas'").get()?.sql || '';
  if (!tableSQL.includes("'cancelada'")) {
    console.log('🔄 Migração: atualizando tabela reservas (nova constraint + motivo_cancelamento)...');
    db.exec(`
      BEGIN TRANSACTION;
      CREATE TABLE reservas_temp (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_id            INTEGER NOT NULL,
        titulo                TEXT    NOT NULL,
        data                  TEXT    NOT NULL,
        horaInicio            TEXT    NOT NULL,
        horaFim               TEXT    NOT NULL,
        status                TEXT    NOT NULL DEFAULT 'confirmada' CHECK(status IN ('confirmada', 'pendente', 'cancelada')),
        modalidade            TEXT    NOT NULL DEFAULT 'presencial' CHECK(modalidade IN ('presencial', 'online')),
        link_reuniao          TEXT,
        pre_ata               TEXT,
        participantes         TEXT,
        notion_page_id        TEXT,
        notion_status_enviado TEXT,
        motivo_cancelamento   TEXT,
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
      );
      INSERT INTO reservas_temp
        (id, usuario_id, titulo, data, horaInicio, horaFim, status, modalidade,
         link_reuniao, pre_ata, participantes, notion_page_id, notion_status_enviado)
      SELECT
        id, usuario_id, titulo, data, horaInicio, horaFim, status, modalidade,
        link_reuniao, pre_ata, participantes, notion_page_id, notion_status_enviado
      FROM reservas;
      DROP TABLE reservas;
      ALTER TABLE reservas_temp RENAME TO reservas;
      COMMIT;
    `);
    console.log('✅ Migração: tabela reservas atualizada com sucesso.');
  } else if (!tableSQL.includes('motivo_cancelamento')) {
    // Constraint já ok mas coluna ainda não existe (caso de borda)
    db.exec('ALTER TABLE reservas ADD COLUMN motivo_cancelamento TEXT');
    console.log('✅ Migração: coluna motivo_cancelamento adicionada');
  }

  // Tabela de confirmações de presença (RSVP)
  db.exec(`
    CREATE TABLE IF NOT EXISTS presencas (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      reserva_id INTEGER NOT NULL,
      usuario_id INTEGER NOT NULL,
      UNIQUE(reserva_id, usuario_id),
      FOREIGN KEY (reserva_id) REFERENCES reservas(id) ON DELETE CASCADE,
      FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
    )
  `);
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
  const agoraMin = horaParaMinutos(agora);
  const inicioMin = horaParaMinutos(r.horaInicio);
  const fimMin = horaParaMinutos(r.horaFim);

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
// Endpoint público: só envia um sinal genérico sem dados sensíveis.
// O frontend recarrega os dados via endpoints autenticados ao receber o evento.
app.get('/api/eventos', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Envia um heartbeat imediato para confirmar a conexão
  res.write(': conectado\n\n');

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ── POST /api/login ──────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) {
    return res.status(400).json({ erro: true, mensagem: 'E-mail e senha são obrigatórios.' });
  }

  const usuario = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email);
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
});

// ── GET /api/status ──────────────────────────────────────────
// Rota pública. A sala só aparece como OCUPADA se houver uma reunião
// PRESENCIAL confirmada acontecendo agora.
app.get('/api/status', (req, res) => {
  const agora = horaAtual();
  const dataHoje = hoje();

  // Reunião presencial ativa agora
  const reservaAtiva = db.prepare(`
    SELECT r.*, u.nome AS gestor
    FROM reservas r JOIN usuarios u ON u.id = r.usuario_id
    WHERE r.data = ? AND r.status = 'confirmada' AND r.modalidade = 'presencial'
      AND r.horaInicio <= ? AND r.horaFim > ?
  `).get(dataHoje, agora, agora);

  // Reunião online ativa agora
  const reuniaoOnlineAtiva = db.prepare(`
    SELECT r.*, u.nome AS gestor
    FROM reservas r JOIN usuarios u ON u.id = r.usuario_id
    WHERE r.data = ? AND r.status = 'confirmada' AND r.modalidade = 'online'
      AND r.horaInicio <= ? AND r.horaFim > ?
  `).get(dataHoje, agora, agora);

  // Próxima reunião confirmada de hoje (qualquer modalidade)
  const proximaReuniao = db.prepare(`
    SELECT r.*, u.nome AS gestor
    FROM reservas r JOIN usuarios u ON u.id = r.usuario_id
    WHERE r.data = ? AND r.status = 'confirmada' AND r.horaInicio > ?
    ORDER BY r.horaInicio ASC LIMIT 1
  `).get(dataHoje, agora);

  const reunioesHoje = db.prepare(
    `SELECT COUNT(*) AS total FROM reservas WHERE data = ? AND status = 'confirmada'`
  ).get(dataHoje).total;

  const pendentes = db.prepare(
    `SELECT COUNT(*) AS total FROM reservas WHERE status = 'pendente'`
  ).get().total;

  res.json({
    salaLivre: !reservaAtiva,
    reservaAtiva: reservaAtiva || null,
    reuniaoOnlineAtiva: reuniaoOnlineAtiva || null,
    proximaReuniao: proximaReuniao || null,
    reunioesHoje,
    pendentes,
    horaAtual: agora
  });
});

// ── GET /api/reservas ────────────────────────────────────────
app.get('/api/reservas', autenticar, (req, res) => {
  const dataHoje = hoje();
  const usuarioId = req.usuario.id;

  const reservas = db.prepare(`
    SELECT r.*,
           u.nome AS gestor,
           (SELECT COUNT(*) FROM presencas p WHERE p.reserva_id = r.id) AS confirmados,
           (SELECT COUNT(*) FROM presencas p WHERE p.reserva_id = r.id AND p.usuario_id = ?) AS euConfirmei,
           (SELECT GROUP_CONCAT(u2.nome, '||') FROM presencas p2
            JOIN usuarios u2 ON u2.id = p2.usuario_id
            WHERE p2.reserva_id = r.id) AS participantesNomes
    FROM reservas r JOIN usuarios u ON u.id = r.usuario_id
    WHERE r.data >= ?
    ORDER BY r.data ASC, r.horaInicio ASC
  `).all(usuarioId, dataHoje);

  const comStatus = reservas.map(r => ({
    ...r,
    statusDinamico: calcularStatusDinamico(r),
    euConfirmei: r.euConfirmei > 0,
    participantesNomes: r.participantesNomes ? r.participantesNomes.split('||') : []
  }));

  res.json(comStatus);
});

// ── POST /api/reservas ───────────────────────────────────────
app.post('/api/reservas', autenticar, (req, res) => {
  const {
    titulo, data, horaInicio, horaFim,
    modalidade = 'presencial', link_reuniao,
    pre_ata
  } = req.body;
  const usuario_id = req.usuario.id;

  // Validação 1: campos obrigatórios
  if (!titulo || !data || !horaInicio || !horaFim) {
    return res.status(400).json({ erro: true, mensagem: 'Todos os campos são obrigatórios.' });
  }

  // Validação 2: formatos válidos de data e hora
  if (!isDataValida(data)) {
    return res.status(400).json({ erro: true, mensagem: 'Formato de data inválido. Use YYYY-MM-DD.' });
  }
  if (!isHoraValida(horaInicio) || !isHoraValida(horaFim)) {
    return res.status(400).json({ erro: true, mensagem: 'Formato de hora inválido. Use HH:MM.' });
  }

  // Validação 3: modalidade online exige link
  if (modalidade === 'online' && !link_reuniao) {
    return res.status(400).json({ erro: true, mensagem: 'Reuniões online exigem um link de acesso.' });
  }

  // Validação 4: pré-ata não pode exceder 600 caracteres
  if (pre_ata && pre_ata.length > 600) {
    return res.status(400).json({ erro: true, mensagem: 'A pré-ata não pode ultrapassar 600 caracteres.' });
  }

  // Validação 5: hora início antes de hora fim
  if (horaParaMinutos(horaInicio) >= horaParaMinutos(horaFim)) {
    return res.status(400).json({ erro: true, mensagem: 'A hora de início deve ser anterior ao término.' });
  }

  // Validação 6: conflito de sala apenas com reuniões PRESENCIAIS confirmadas
  if (modalidade === 'presencial') {
    const reservasDaData = db.prepare(`
      SELECT * FROM reservas
      WHERE data = ? AND status = 'confirmada' AND modalidade = 'presencial'
    `).all(data);

    const conflito = reservasDaData.find(r =>
      temConflito(horaInicio, horaFim, r.horaInicio, r.horaFim)
    );

    if (conflito) {
      return res.status(409).json({
        erro: true,
        tipoConflito: 'sala',
        mensagem: `Conflito de horário! A sala já está ocupada por "${conflito.titulo}" das ${conflito.horaInicio} às ${conflito.horaFim}.`
      });
    }
  }

  // Cria a reserva
  const resultado = db.prepare(`
    INSERT INTO reservas (usuario_id, titulo, data, horaInicio, horaFim, status, modalidade, link_reuniao, pre_ata)
    VALUES (?, ?, ?, ?, ?, 'confirmada', ?, ?, ?)
  `).run(
    usuario_id, titulo, data, horaInicio, horaFim,
    modalidade, link_reuniao || null,
    pre_ata || null
  );

  const novaReserva = db.prepare(`
    SELECT r.*, u.nome AS gestor,
           0 AS confirmados, 0 AS euConfirmei
    FROM reservas r JOIN usuarios u ON u.id = r.usuario_id
    WHERE r.id = ?
  `).get(resultado.lastInsertRowid);

  // Responde ao cliente antes de chamar o Notion (não bloqueia)
  res.status(201).json({
    erro: false,
    mensagem: 'Reserva criada com sucesso!',
    reserva: { ...novaReserva, statusDinamico: calcularStatusDinamico(novaReserva), euConfirmei: false }
  });
  notificarClientes();

  // Envia para o Notion de forma assíncrona e salva o notion_page_id retornado
  const statusParaNotion = calcularStatusDinamico(novaReserva);
  criarPaginaNotion(novaReserva, [], statusParaNotion).then(notionPageId => {
    if (notionPageId) {
      db.prepare('UPDATE reservas SET notion_page_id = ?, notion_status_enviado = ? WHERE id = ?')
        .run(notionPageId, statusParaNotion, novaReserva.id);
    }
  }).catch(() => { });
});

// ── PATCH /api/reservas/:id/cancelar ────────────────────────
// Somente o criador pode cancelar, com motivo opcional.
app.patch('/api/reservas/:id/cancelar', autenticar, (req, res) => {
  const id = parseInt(req.params.id);
  const { motivo } = req.body;

  const reserva = db.prepare('SELECT * FROM reservas WHERE id = ?').get(id);
  if (!reserva) {
    return res.status(404).json({ erro: true, mensagem: 'Reserva não encontrada.' });
  }

  // Somente o criador pode cancelar
  if (reserva.usuario_id !== req.usuario.id) {
    return res.status(403).json({ erro: true, mensagem: 'Somente o criador da reunião pode cancelá-la.' });
  }

  if (reserva.status === 'cancelada') {
    return res.status(400).json({ erro: true, mensagem: 'Esta reunião já está cancelada.' });
  }

  db.prepare('UPDATE reservas SET status = ?, motivo_cancelamento = ? WHERE id = ?')
    .run('cancelada', motivo?.trim() || null, id);

  notificarClientes();
  res.json({ erro: false, mensagem: 'Reunião cancelada com sucesso.' });

  // Atualiza status e motivo no Notion de forma assíncrona
  console.log(`🔍 Debug cancelamento #${id}: notion_page_id = "${reserva.notion_page_id}", motivo = "${motivo?.trim() || '(vazio)'}"`);
  if (reserva.notion_page_id) {
    cancelarPaginaNotion(reserva.notion_page_id, motivo?.trim() || '')
      .catch(err => console.error('Notion: erro ao atualizar cancelamento:', err.message));
  } else {
    console.warn(`⚠️  Reunião #${id} cancelada, mas sem notion_page_id — Notion não foi atualizado.`);
  }
});

// ── DELETE /api/reservas/:id ─────────────────────────────────
app.delete('/api/reservas/:id', autenticar, (req, res) => {
  const id = parseInt(req.params.id);
  const reserva = db.prepare('SELECT * FROM reservas WHERE id = ?').get(id);

  if (!reserva) {
    return res.status(404).json({ erro: true, mensagem: 'Reserva não encontrada.' });
  }

  if (req.usuario.role !== 'admin' && reserva.usuario_id !== req.usuario.id) {
    return res.status(403).json({ erro: true, mensagem: 'Você só pode cancelar suas próprias reservas.' });
  }

  db.prepare('DELETE FROM reservas WHERE id = ?').run(id);
  notificarClientes();
  res.json({ erro: false, mensagem: 'Reserva cancelada com sucesso.' });

  // Arquiva a página no Notion de forma assíncrona (se existir)
  if (reserva.notion_page_id) {
    arquivarPaginaNotion(reserva.notion_page_id).catch(() => { });
  }
});

// ── GET /api/notion/status ───────────────────────────────────
// Informa ao frontend se a integração com o Notion está configurada.
app.get('/api/notion/status', autenticar, (req, res) => {
  res.json({ configurado: notionConfigurado() });
});

// ── POST /api/notion/sync ────────────────────────────────────
// Somente Admin. Sincroniza todas as reservas futuras (de hoje em diante) para o Notion.
app.post('/api/notion/sync', autenticar, apenasAdmin, async (req, res) => {
  const dataHoje = hoje();

  const reservas = db.prepare(`
    SELECT r.*, u.nome AS gestor,
           (SELECT GROUP_CONCAT(u2.nome, '||') FROM presencas p2
            JOIN usuarios u2 ON u2.id = p2.usuario_id
            WHERE p2.reserva_id = r.id) AS participantesNomes
    FROM reservas r JOIN usuarios u ON u.id = r.usuario_id
    WHERE r.data >= ?
    ORDER BY r.data ASC, r.horaInicio ASC
  `).all(dataHoje);

  try {
    // Adiciona statusDinamico calculado a cada reserva antes de enviar ao Notion
    const reservasComStatus = reservas.map(r => ({
      ...r,
      statusDinamico: calcularStatusDinamico(r),
      participantesNomes: r.participantesNomes || null
    }));
    const { criadas, atualizadas, novasIds } = await sincronizarTodasReservas(reservasComStatus);

    // Salva no banco os notion_page_id das reservas recém-criadas no Notion
    const stmtAtualizar = db.prepare(
      'UPDATE reservas SET notion_page_id = ?, notion_status_enviado = ? WHERE id = ?'
    );
    for (const { id, notionPageId, status } of novasIds) {
      stmtAtualizar.run(notionPageId, status, id);
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
// Toggle RSVP: confirma ou remove presença do usuário logado.
app.patch('/api/reservas/:id/presenca', autenticar, (req, res) => {
  const reservaId = parseInt(req.params.id);
  const usuarioId = req.usuario.id;

  const reserva = db.prepare('SELECT id FROM reservas WHERE id = ?').get(reservaId);
  if (!reserva) return res.status(404).json({ erro: true, mensagem: 'Reserva não encontrada.' });

  const jaConfirmou = db.prepare(
    'SELECT id FROM presencas WHERE reserva_id = ? AND usuario_id = ?'
  ).get(reservaId, usuarioId);

  if (jaConfirmou) {
    db.prepare('DELETE FROM presencas WHERE reserva_id = ? AND usuario_id = ?').run(reservaId, usuarioId);
  } else {
    db.prepare('INSERT INTO presencas (reserva_id, usuario_id) VALUES (?, ?)').run(reservaId, usuarioId);
  }

  const confirmados = db.prepare(
    'SELECT COUNT(*) AS total FROM presencas WHERE reserva_id = ?'
  ).get(reservaId).total;

  res.json({
    erro: false,
    confirmou: !jaConfirmou,
    confirmados
  });
  notificarClientes();

  // Atualiza o campo "Confirmados" no Notion de forma assíncrona
  const reservaCompleta = db.prepare('SELECT * FROM reservas WHERE id = ?').get(reservaId);
  if (reservaCompleta?.notion_page_id) {
    const nomes = db.prepare(`
      SELECT u.nome FROM presencas p
      JOIN usuarios u ON u.id = p.usuario_id
      WHERE p.reserva_id = ?
    `).all(reservaId).map(r => r.nome);

    const statusAtual = calcularStatusDinamico(reservaCompleta);
    atualizarPaginaNotion(reservaCompleta.notion_page_id, nomes, statusAtual)
      .catch(err => console.error('Notion: erro ao atualizar confirmados:', err.message));
  }
});

// ── GET /api/historico ─────────────────────────────────────────
// Admin: vê todas as reservas. Gestor: vê somente as suas.
app.get('/api/historico', autenticar, (req, res) => {
  const { id: usuarioId, role } = req.usuario;
  let todas;

  if (role === 'admin') {
    todas = db.prepare(`
      SELECT r.*, u.nome AS gestor, u.email AS emailGestor,
             (SELECT COUNT(*) FROM presencas p WHERE p.reserva_id = r.id) AS confirmados,
             (SELECT COUNT(*) FROM presencas p WHERE p.reserva_id = r.id AND p.usuario_id = ?) AS euConfirmei,
             (SELECT GROUP_CONCAT(u2.nome, '||') FROM presencas p2
              JOIN usuarios u2 ON u2.id = p2.usuario_id
              WHERE p2.reserva_id = r.id) AS participantesNomes
      FROM reservas r JOIN usuarios u ON u.id = r.usuario_id
      ORDER BY r.data DESC, r.horaInicio ASC
    `).all(usuarioId);
  } else {
    todas = db.prepare(`
      SELECT r.*, u.nome AS gestor,
             (SELECT COUNT(*) FROM presencas p WHERE p.reserva_id = r.id) AS confirmados,
             (SELECT COUNT(*) FROM presencas p WHERE p.reserva_id = r.id AND p.usuario_id = ?) AS euConfirmei,
             (SELECT GROUP_CONCAT(u2.nome, '||') FROM presencas p2
              JOIN usuarios u2 ON u2.id = p2.usuario_id
              WHERE p2.reserva_id = r.id) AS participantesNomes
      FROM reservas r JOIN usuarios u ON u.id = r.usuario_id
      WHERE r.usuario_id = ?
      ORDER BY r.data DESC, r.horaInicio ASC
    `).all(usuarioId, usuarioId);
  }

  const comStatus = todas.map(r => ({
    ...r,
    statusDinamico: calcularStatusDinamico(r),
    euConfirmei: r.euConfirmei > 0,
    participantesNomes: r.participantesNomes ? r.participantesNomes.split('||') : []
  }));
  res.json(comStatus);
});

// ── DELETE /api/historico/concluidas ─────────────────────────
// Somente Admin. Apaga todas as reuniões com status 'Concluída'
// (data anterior a hoje, ou hoje com horaFim já passada).
app.delete('/api/historico/concluidas', autenticar, apenasAdmin, (req, res) => {
  const agora = horaAtual();
  const dataHoje = hoje();

  const resultado = db.prepare(`
    DELETE FROM reservas
    WHERE data < ?
       OR (data = ? AND horaFim <= ?)
  `).run(dataHoje, dataHoje, agora);

  res.json({
    erro: false,
    mensagem: `${resultado.changes} reunião(ões) concluída(s) foram apagada(s).`,
    apagadas: resultado.changes
  });
  notificarClientes();
});

// ── GET /api/estatisticas ────────────────────────────────────
// Autenticado. Rankings de uso da sala.
app.get('/api/estatisticas', autenticar, (req, res) => {
  const rankingQuantidade = db.prepare(`
    SELECT u.nome, COUNT(r.id) AS totalReservas
    FROM reservas r JOIN usuarios u ON u.id = r.usuario_id
    WHERE r.status = 'confirmada'
    GROUP BY r.usuario_id ORDER BY totalReservas DESC LIMIT 5
  `).all();

  const rankingTempo = db.prepare(`
    SELECT u.nome,
      SUM(
        (CAST(SUBSTR(r.horaFim,   1, 2) AS INTEGER) * 60 + CAST(SUBSTR(r.horaFim,   4, 2) AS INTEGER)) -
        (CAST(SUBSTR(r.horaInicio,1, 2) AS INTEGER) * 60 + CAST(SUBSTR(r.horaInicio,4, 2) AS INTEGER))
      ) AS totalMinutos
    FROM reservas r JOIN usuarios u ON u.id = r.usuario_id
    WHERE r.status = 'confirmada'
    GROUP BY r.usuario_id ORDER BY totalMinutos DESC LIMIT 5
  `).all();

  const totais = db.prepare(`
    SELECT
      COUNT(*) AS totalReservas,
      SUM(
        (CAST(SUBSTR(horaFim,   1, 2) AS INTEGER) * 60 + CAST(SUBSTR(horaFim,   4, 2) AS INTEGER)) -
        (CAST(SUBSTR(horaInicio,1, 2) AS INTEGER) * 60 + CAST(SUBSTR(horaInicio,4, 2) AS INTEGER))
      ) AS totalMinutos
    FROM reservas WHERE status = 'confirmada'
  `).get();

  res.json({ rankingQuantidade, rankingTempo, totais });
});

// ── Rota padrão ──────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================================
// 8.1 SINCRONIZAÇÃO PERIÓDICA DE STATUS COM O NOTION
// ============================================================

/**
 * Verifica todas as reservas que possuem notion_page_id e compara o status
 * atual (calculado dinamicamente) com o último status enviado ao Notion.
 * Se houver diferença, atualiza a página no Notion.
 *
 * Roda a cada 5 minutos após a inicialização do servidor.
 */
async function sincronizarStatusNotion() {
  if (!notionConfigurado()) return;

  const reservas = db.prepare(`
    SELECT * FROM reservas
    WHERE notion_page_id IS NOT NULL
  `).all();

  if (reservas.length === 0) return;

  let atualizadas = 0;
  for (const r of reservas) {
    const statusAtual = calcularStatusDinamico(r);
    if (statusAtual !== r.notion_status_enviado) {
      const ok = await atualizarStatusNotion(r.notion_page_id, statusAtual);
      if (ok) {
        db.prepare('UPDATE reservas SET notion_status_enviado = ? WHERE id = ?')
          .run(statusAtual, r.id);
        atualizadas++;
      }
    }
  }

  if (atualizadas > 0) {
    console.log(`🔄 Notion: ${atualizadas} status atualizado(s) automaticamente.`);
  }
}

// ============================================================
// 9. INICIALIZAÇÃO
// ============================================================
inicializarBanco();

app.listen(PORT, () => {
  console.log(`\n✅ Servidor Canaã Telecom v2.3 rodando!`);
  console.log(`🌐 Acesse: http://localhost:${PORT}`);
  console.log(`🔑 Admin: ti@canaatelecom.com.br\n`);

  // Inicia o timer de sincronização de status com o Notion (a cada 5 minutos)
  if (notionConfigurado()) {
    // Roda a primeira vez após 1 minuto (aguarda o servidor estabilizar)
    setTimeout(() => {
      sincronizarStatusNotion();
      setInterval(sincronizarStatusNotion, 5 * 60 * 1000);
    }, 60 * 1000);
    console.log('🔔 Notion: sincronização automática de status ativada (a cada 5 min).');
  }
});
