
const URL_API = 'http://localhost:3000/api';

// Aba ativa na lista de agendamentos
let abaAtiva = 'proximos';

// 1. AUTENTICAÇÃO

function obterToken() { return localStorage.getItem('canaa_token'); }
function obterUsuario() { const d = localStorage.getItem('canaa_usuario'); return d ? JSON.parse(d) : null; }

function logout() {
  localStorage.removeItem('canaa_token');
  localStorage.removeItem('canaa_usuario');
  window.location.href = '/login.html';
}

function headersAuth() {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${obterToken()}` };
}

// Verifica 401 e faz logout automático
function checar401(status) {
  if (status === 401) { logout(); return true; }
  return false;
}

// ------------------------------------------------------------
// 2. INICIALIZAÇÃO
// ------------------------------------------------------------
function init() {
  if (!obterToken()) { window.location.href = '/login.html'; return; }

  const usuario = obterUsuario();
  if (!usuario) { logout(); return; }

  // Preenche navbar
  document.getElementById('navNomeUsuario').textContent = usuario.nome;
  document.getElementById('navBadgeRole').textContent = usuario.role === 'admin' ? 'Administrador' : 'Gestor';
  document.getElementById('navAvatarLetra').textContent = usuario.nome.charAt(0).toUpperCase();

  // Exibe card de admin apenas para admins
  if (usuario.role === 'admin') {
    document.getElementById('cardAdmin').classList.remove('hidden');
  }

  // Carrega tudo
  carregarDashboard();
  carregarLista('proximos');
  carregarAnalytics();

  // Inicializa posição da bolinha conforme tema atual
  const isDark = document.documentElement.classList.contains('dark');
  atualizarToggle(isDark);
}

// ------------------------------------------------------------
// 3. TEMA
// ------------------------------------------------------------

/** Move a bolinha do toggle para a posição correta */
function atualizarToggle(isDark) {
  const thumb = document.getElementById('themeThumb');
  if (!thumb) return;
  if (isDark) {
    thumb.style.left = 'calc(100% - 18px)'; // 16px thumb + 2px gap
    thumb.style.backgroundColor = '#334155'; // slate-700
  } else {
    thumb.style.left = '2px';
    thumb.style.backgroundColor = '#ffffff';
  }
}

function alternarTema() {
  const html = document.documentElement;
  html.classList.toggle('dark');
  const isDark = html.classList.contains('dark');
  document.getElementById('iconSun').classList.toggle('hidden', isDark);
  document.getElementById('iconMoon').classList.toggle('hidden', !isDark);
  atualizarToggle(isDark);
}

// ------------------------------------------------------------
// 4. MODAL POPUP
// ------------------------------------------------------------

/**
 * Exibe o modal popup centrado na tela.
 * @param {'erro'|'sucesso'|'aviso'|'info'} tipo
 * @param {string} mensagem
 * @param {boolean} autoClose - Se true, fecha automaticamente em 2.5s
 */
function mostrarModal(tipo, mensagem, autoClose = false) {
  const overlay = document.getElementById('modalOverlay');
  const iconWrap = document.getElementById('modalIconWrap');
  const icon = document.getElementById('modalIcon');
  const titulo = document.getElementById('modalTitulo');
  const msg = document.getElementById('modalMsg');
  const barWrap = document.getElementById('modalBarWrap');
  const bar = document.getElementById('modalBar');

  msg.textContent = mensagem;

  const configs = {
    erro: { titulo: 'Erro', icone: '✕', bg: 'bg-red-500/20', text: 'text-red-400', barColor: 'bg-red-400' },
    sucesso: { titulo: 'Sucesso', icone: '✓', bg: 'bg-emerald-500/20', text: 'text-emerald-400', barColor: 'bg-emerald-400' },
    aviso: { titulo: 'Atenção', icone: '!', bg: 'bg-yellow-500/20', text: 'text-yellow-300', barColor: 'bg-yellow-400' },
    info: { titulo: 'Info', icone: 'i', bg: 'bg-blue-500/20', text: 'text-blue-400', barColor: 'bg-blue-400' },
  };

  const c = configs[tipo] || configs.info;
  titulo.textContent = c.titulo;
  icon.textContent = c.icone;
  iconWrap.className = `w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 font-bold text-base ${c.bg} ${c.text}`;

  if (autoClose) {
    barWrap.classList.remove('hidden');
    // Reseta a barra e depois anima
    bar.className = `h-full rounded-full ${c.barColor} w-full`;
    // Força um reflow para reiniciar a transição
    bar.getBoundingClientRect();
    bar.style.transition = 'width 2.5s linear';
    bar.style.width = '0%';
    setTimeout(fecharModal, 2600);
  } else {
    barWrap.classList.add('hidden');
    bar.style.transition = '';
    bar.style.width = '100%';
  }

  overlay.classList.remove('hidden');
}

/** Fecha o modal popup */
function fecharModal() {
  document.getElementById('modalOverlay').classList.add('hidden');
}

/** Fecha o modal ao clicar fora do card */
function fecharModalFora(event) {
  if (event.target === document.getElementById('modalOverlay')) fecharModal();
}

// ------------------------------------------------------------
// 5. FORMULÁRIO DINÂMICO — Modalidade
// ------------------------------------------------------------

/** Exibe/oculta o campo de link conforme a modalidade selecionada */
function alternarModalidade() {
  const modalidade = document.getElementById('selectModalidade').value;
  document.getElementById('boxLink').classList.toggle('hidden', modalidade !== 'online');
}

// ------------------------------------------------------------
// 6. ENVIAR NOVA RESERVA
// ------------------------------------------------------------
async function agendarReuniao(event) {
  event.preventDefault();

  const titulo = document.getElementById('inputTitulo').value.trim();
  const data = document.getElementById('inputData').value;
  const horaInicio = document.getElementById('inputInicio').value;
  const horaFim = document.getElementById('inputFim').value;
  const modalidade = document.getElementById('selectModalidade').value;
  const link_reuniao = document.getElementById('inputLink').value.trim() || null;
  const pre_ata = document.getElementById('inputPreAta').value.trim() || null;

  if (!titulo || !data || !horaInicio || !horaFim) {
    mostrarModal('aviso', 'Preencha todos os campos obrigatórios antes de confirmar.');
    return;
  }
  if (modalidade === 'online' && !link_reuniao) {
    mostrarModal('aviso', 'Reuniões online exigem um link de acesso.');
    return;
  }

  try {
    const resposta = await fetch(`${URL_API}/reservas`, {
      method: 'POST',
      headers: headersAuth(),
      body: JSON.stringify({ titulo, data, horaInicio, horaFim, modalidade, link_reuniao, pre_ata })
    });

    if (checar401(resposta.status)) return;
    const resultado = await resposta.json();

    if (!resposta.ok) {
      // Conflito de participante → aviso amarelo; outros erros → vermelho
      const tipo = resultado.tipoConflito === 'participante' ? 'aviso' : 'erro';
      mostrarModal(tipo, resultado.mensagem);
    } else {
      mostrarModal('sucesso', resultado.mensagem, true);
      document.getElementById('formReserva').reset();
      document.getElementById('boxLink').classList.add('hidden');
      carregarDashboard();
      carregarLista(abaAtiva);
      carregarAnalytics();
    }
  } catch (erro) {
    console.error('Erro na requisição:', erro);
    mostrarModal('erro', 'Erro ao conectar com o servidor. Verifique se o backend está rodando.');
  }
}

// ------------------------------------------------------------
// 7. DASHBOARD — Banner e cards de métricas
// ------------------------------------------------------------
async function carregarDashboard() {
  try {
    const resStatus = await fetch(`${URL_API}/status`);
    const status = await resStatus.json();

    // ── BANNER (slim) ────────────────────────────────────────
    const banner = document.getElementById('bannerStatus');
    const bannerTit = document.getElementById('bannerTitulo');
    const bannerDet = document.getElementById('bannerDetalhe');
    const bannerDot = document.getElementById('bannerDot');

    const bannerBase = 'flex items-center gap-3 px-4 sm:px-6 py-2 text-xs font-medium transition-all duration-700 border-b';

    if (status.salaLivre) {
      banner.className = `${bannerBase} bg-emerald-500/10 border-emerald-400/20 text-emerald-400`;
      bannerTit.textContent = 'SALA LIVRE';
      bannerDet.textContent = status.proximaReuniao
        ? `Próxima reunião presencial às ${status.proximaReuniao.horaInicio}`
        : 'Nenhuma reunião presencial em andamento';
      bannerDot.className = 'w-2 h-2 rounded-full bg-emerald-400 status-dot-green flex-shrink-0';
    } else {
      banner.className = `${bannerBase} bg-red-600/10 border-red-400/20 text-red-400`;
      bannerTit.textContent = `SALA OCUPADA 🚫 ${status.reservaAtiva?.titulo || ''}`;
      bannerDet.textContent = `Uso presencial por ${status.reservaAtiva?.gestor || '—'} até ${status.reservaAtiva?.horaFim || '—'}`;
      bannerDot.className = 'w-2 h-2 rounded-full bg-red-400 status-dot-red flex-shrink-0';
    }

    const relogio = document.getElementById('relogioAoVivo');
    if (relogio) relogio.textContent = `🕐 ${status.horaAtual}`;

    // ── CARD KPI — Sala Status (novo: sem absolute, sem big cards) ───
    const cardStatus = document.getElementById('cardSalaStatus');
    const labelStatus = document.getElementById('cardSalaLabel');
    const detalheStatus = document.getElementById('cardSalaDetalhe');
    const dotStatus = document.getElementById('statusDot');

    if (status.salaLivre) {
      cardStatus.className = 'p-4 border-r border-slate-200 dark:border-white/10 transition-all duration-500';
      labelStatus.textContent = 'SALA LIVRE';
      detalheStatus.textContent = 'Disponível';
      dotStatus.className = 'w-2 h-2 rounded-full bg-emerald-400 status-dot-green';
      detalheStatus.className = 'text-lg font-display font-bold text-emerald-400';
      labelStatus.className = 'text-[10px] font-bold uppercase tracking-widest text-slate-400';
    } else {
      cardStatus.className = 'p-4 border-r border-slate-200 dark:border-white/10 transition-all duration-500';
      labelStatus.textContent = 'SALA OCUPADA';
      detalheStatus.textContent = status.reservaAtiva?.gestor || 'Em uso';
      dotStatus.className = 'w-2 h-2 rounded-full bg-red-400 status-dot-red';
      detalheStatus.className = 'text-lg font-display font-bold text-red-400';
      labelStatus.className = 'text-[10px] font-bold uppercase tracking-widest text-slate-400';
    }

    // Card reunião ativa
    const cardTitulo = document.getElementById('cardReuniaoTitulo');
    if (status.reservaAtiva) {
      cardTitulo.textContent = status.reservaAtiva.titulo;
    } else if (status.proximaReuniao) {
      cardTitulo.textContent = `Próx: ${status.proximaReuniao.horaInicio}`;
    } else {
      cardTitulo.textContent = 'Nenhuma';
    }

    document.getElementById('countReunioesHoje').textContent = status.reunioesHoje;
    document.getElementById('countPendentes').textContent = status.pendentes;

  } catch (err) {
    console.error('Erro ao carregar dashboard:', err);
  }
}

// ------------------------------------------------------------
// 8. CONTROLE DE ABAS
// ------------------------------------------------------------

/** Alterna entre as abas "Próximos" e "Histórico" */
function trocarAba(aba) {
  abaAtiva = aba;

  const btnProximos = document.getElementById('tab-btn-proximos');
  const btnHistorico = document.getElementById('tab-btn-historico');

  const estiloAtivo = 'tab-btn flex-1 py-3.5 px-4 text-sm font-semibold uppercase tracking-widest transition-all duration-200 text-blue-600 dark:text-canaa-cyan border-b-2 border-blue-600 dark:border-canaa-cyan bg-blue-50/50 dark:bg-canaa-cyan/5';
  const estiloInativo = 'tab-btn flex-1 py-3.5 px-4 text-sm font-semibold uppercase tracking-widest transition-all duration-200 text-slate-500 dark:text-slate-400 border-b-2 border-transparent hover:bg-slate-50 dark:hover:bg-white/5';

  if (aba === 'proximos') {
    btnProximos.className = estiloAtivo;
    btnHistorico.className = estiloInativo;
  } else {
    btnProximos.className = estiloInativo;
    btnHistorico.className = estiloAtivo;
  }

  carregarLista(aba);
}

// ------------------------------------------------------------
// 9. CARREGAR LISTA DE RESERVAS
// ------------------------------------------------------------

/** Carrega a lista de acordo com a aba: 'proximos' ou 'historico' */
async function carregarLista(aba) {
  const lista = document.getElementById('listaReservas');
  lista.innerHTML = '<div class="text-center py-8 text-slate-400 text-sm">Carregando...</div>';

  try {
    const endpoint = aba === 'historico' ? `${URL_API}/historico` : `${URL_API}/reservas`;
    const res = await fetch(endpoint, { headers: headersAuth() });

    if (checar401(res.status)) return;

    if (res.status === 403) {
      lista.innerHTML = `<div class="text-center py-8 text-orange-400 text-sm">Acesso restrito — somente administradores.</div>`;
      return;
    }

    const reservas = await res.json();
    lista.innerHTML = '';

    if (reservas.length === 0) {
      lista.innerHTML = `<div class="text-center py-8 text-slate-400 text-sm">Nenhum agendamento encontrado.</div>`;
      return;
    }

    lista.innerHTML = reservas.map(r => renderCartaoReserva(r)).join('');

  } catch (err) {
    console.error('Erro ao carregar lista:', err);
    lista.innerHTML = `<div class="text-center py-8 text-red-400 text-sm">Erro ao carregar lista.</div>`;
  }
}

/** Formata uma data ISO (YYYY-MM-DD) para DD/MM/YYYY */
function formatarData(iso) {
  if (!iso) return '—';
  const [ano, mes, dia] = iso.split('-');
  return `${dia}/${mes}/${ano}`;
}

/** Retorna o HTML do badge de status dinâmico */
function renderBadgeStatus(statusDinamico) {
  switch (statusDinamico) {
    case 'Concluída': return '<span class="text-xs font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-300">Concluída</span>';
    case 'Em andamento': return '<span class="text-xs font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300 animate-pulse">● Em andamento</span>';
    case 'Agendada': return '<span class="text-xs font-bold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">Agendada</span>';
    default: return '<span class="text-xs font-bold px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-700">Pendente</span>';
  }
}

/** Renderiza o HTML de um item da lista no layout compacto tipo tabela */
function renderCartaoReserva(r) {
  const usuario = obterUsuario();
  const isAdmin = usuario?.role === 'admin';

  // Badge de status
  const statusBadge = {
    'Concluída': '<span class="text-[10px] font-bold text-slate-400">Concluída</span>',
    'Em andamento': '<span class="text-[10px] font-bold text-emerald-400 animate-pulse">● Ativo</span>',
    'Agendada': '<span class="text-[10px] font-bold text-blue-400">Agendada</span>',
  }[r.statusDinamico] || '<span class="text-[10px] text-slate-500">—</span>';

  // Badge de modalidade
  const tipoBadge = r.modalidade === 'online'
    ? `<a href="${r.link_reuniao || '#'}" target="_blank" class="text-[10px] font-bold text-purple-400 hover:underline">Online</a>`
    : '<span class="text-[10px] font-bold text-slate-400">Presencial</span>';

  const dataDDMMYYYY = formatarData(r.data);

  // Pré-Ata expansiva
  const preAtaHtml = r.pre_ata ? `
    <div class="mt-1.5 col-span-4">
      <button onclick="togglePreAta(${r.id})" class="text-[10px] text-cyan-500 hover:text-cyan-400 font-semibold flex items-center gap-1">
        <svg id="chevron-${r.id}" class="w-3 h-3 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
        Ver Pauta
      </button>
      <div id="preata-${r.id}" class="hidden mt-1 text-[10px] text-slate-300 bg-white/5 rounded px-2 py-1.5 leading-relaxed whitespace-pre-wrap">${r.pre_ata}</div>
    </div>` : '';

  // RSVP — mostra apenas em Próximos (Agendada ou Em andamento)
  const podeConfirmar = r.statusDinamico === 'Agendada' || r.statusDinamico === 'Em andamento';
  const confirmados = r.confirmados ?? 0;
  const euConfirmei = r.euConfirmei;

  const rsvpHtml = podeConfirmar ? `
    <div class="col-span-4 flex items-center gap-2 mt-1">
      <button id="rsvp-btn-${r.id}" onclick="confirmarPresenca(${r.id})"
        class="text-[10px] font-bold px-2.5 py-1 rounded-full transition-all ${euConfirmei
      ? 'bg-emerald-900/40 text-emerald-300 hover:bg-red-900/30 hover:text-red-300'
      : 'bg-white/5 text-slate-400 hover:bg-emerald-900/30 hover:text-emerald-300'
    }">
        ${euConfirmei ? '✓ Confirmado' : '○ Confirmar Presença'}
      </button>
      <span id="rsvp-count-${r.id}" class="text-[10px] text-slate-500">${confirmados} confirmado${confirmados !== 1 ? 's' : ''}</span>
    </div>` : (confirmados > 0 ? `
    <div class="col-span-4 mt-1">
      <span class="text-[10px] text-slate-500">✓ ${confirmados} confirmado${confirmados !== 1 ? 's' : ''}</span>
    </div>` : '');

  // Botão de exclusão — visível apenas para admins
  const adminDeleteBtn = isAdmin ? `
    <div class="col-span-4 mt-1">
      <button onclick="cancelarReserva(${r.id}, '${r.titulo.replace(/'/g, '\\&apos;')}')" 
        class="text-[10px] font-semibold text-red-400 hover:text-red-300 flex items-center gap-1 transition-colors">
        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
        </svg>
        Apagar reunião
      </button>
    </div>` : '';

  return `
    <div id="card-reserva-${r.id}" class="px-3 py-2 border-b border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-white/[0.03] transition-colors">
      <div class="grid grid-cols-[70px_1fr_80px_70px] gap-2 items-center">
        <div class="leading-tight">
          <p class="text-[10px] text-slate-400 font-mono">${dataDDMMYYYY}</p>
          <p class="text-xs font-bold text-blue-600 dark:text-canaa-cyan">${r.horaInicio}<span class="text-slate-400 font-normal">→${r.horaFim}</span></p>
        </div>
        <div class="min-w-0">
          <p class="text-xs font-semibold dark:text-slate-100 truncate">${r.titulo}</p>
          <p class="text-[10px] text-slate-400 truncate">${r.gestor || '—'}</p>
        </div>
        <div class="text-center">${statusBadge}</div>
        <div class="text-center">${tipoBadge}</div>
        ${preAtaHtml}
        ${rsvpHtml}
        ${adminDeleteBtn}
      </div>
    </div>
  `;
}

/** Expande/recolhe a pré-ata de um card */
function togglePreAta(id) {
  const box = document.getElementById(`preata-${id}`);
  const chevron = document.getElementById(`chevron-${id}`);
  box.classList.toggle('hidden');
  chevron.style.transform = box.classList.contains('hidden') ? '' : 'rotate(90deg)';
}

/** Toggle de RSVP via PATCH /api/reservas/:id/presenca */
async function confirmarPresenca(reservaId) {
  try {
    const res = await fetch(`${URL_API}/reservas/${reservaId}/presenca`, {
      method: 'PATCH',
      headers: headersAuth()
    });
    if (checar401(res.status)) return;
    const dados = await res.json();

    // Atualiza o botão e o contador inline, sem recarregar a lista
    const btn = document.getElementById(`rsvp-btn-${reservaId}`);
    const count = document.getElementById(`rsvp-count-${reservaId}`);
    if (!btn || !count) return;

    if (dados.confirmou) {
      btn.className = btn.className.replace('bg-white/5 text-slate-400 hover:bg-emerald-900/30 hover:text-emerald-300',
        'bg-emerald-900/40 text-emerald-300 hover:bg-red-900/30 hover:text-red-300');
      btn.textContent = '✓ Confirmado';
    } else {
      btn.className = btn.className.replace('bg-emerald-900/40 text-emerald-300 hover:bg-red-900/30 hover:text-red-300',
        'bg-white/5 text-slate-400 hover:bg-emerald-900/30 hover:text-emerald-300');
      btn.textContent = '○ Confirmar Presença';
    }
    const n = dados.confirmados;
    count.textContent = `${n} confirmado${n !== 1 ? 's' : ''}`;

  } catch (err) {
    console.error('Erro ao confirmar presença:', err);
  }
}

// ------------------------------------------------------------
// 10. ANALYTICS — Cards de top usuários
// ------------------------------------------------------------
async function carregarAnalytics() {
  try {
    const res = await fetch(`${URL_API}/estatisticas`, { headers: headersAuth() });
    if (checar401(res.status)) return;
    const dados = await res.json();

    // Top por quantidade
    const topQtd = dados.rankingQuantidade[0];
    if (topQtd) {
      document.getElementById('topQtdNome').textContent = topQtd.nome;
      document.getElementById('topQtdValor').textContent = `${topQtd.totalReservas} reserva${topQtd.totalReservas !== 1 ? 's' : ''} confirmadas`;
    } else {
      document.getElementById('topQtdNome').textContent = 'Sem dados';
      document.getElementById('topQtdValor').textContent = '—';
    }

    // Top por tempo
    const topTempo = dados.rankingTempo[0];
    if (topTempo) {
      const horas = Math.floor(topTempo.totalMinutos / 60);
      const minutos = topTempo.totalMinutos % 60;
      const tempoStr = horas > 0 ? `${horas}h ${minutos}min` : `${minutos}min`;
      document.getElementById('topTempoNome').textContent = topTempo.nome;
      document.getElementById('topTempoValor').textContent = `${tempoStr} de uso total`;
    } else {
      document.getElementById('topTempoNome').textContent = 'Sem dados';
      document.getElementById('topTempoValor').textContent = '—';
    }

  } catch (err) {
    console.error('Erro ao carregar analytics:', err);
  }
}

// ------------------------------------------------------------
// ADMIN — Apagar reunião individual
async function cancelarReserva(id, titulo) {
  // Monta o modal de confirmação
  mostrarModal('aviso', `Deseja apagar definitivamente a reunião "${titulo}"? Esta ação não pode ser desfeita.`);

  // Remove botões anteriores se existirem (re-uso)
  document.getElementById('adminConfirmarBtn')?.remove();
  document.getElementById('adminCancelarBtn')?.remove();

  const barWrap = document.getElementById('modalBarWrap');
  const modalCard = document.getElementById('modalCard');

  // Cria barra de botões
  const botoesDiv = document.createElement('div');
  botoesDiv.className = 'flex gap-2 mt-4 justify-end';

  const btnCancelar = document.createElement('button');
  btnCancelar.id = 'adminCancelarBtn';
  btnCancelar.textContent = 'Não';
  btnCancelar.className = 'px-4 py-1.5 text-xs font-bold rounded-lg bg-white/10 hover:bg-white/20 text-slate-300 transition-all';
  btnCancelar.onclick = () => { botoesDiv.remove(); fecharModal(); };

  const btnConfirmar = document.createElement('button');
  btnConfirmar.id = 'adminConfirmarBtn';
  btnConfirmar.textContent = 'Sim, apagar';
  btnConfirmar.className = 'px-4 py-1.5 text-xs font-bold rounded-lg bg-red-500 hover:bg-red-600 text-white transition-all';
  btnConfirmar.onclick = async () => {
    botoesDiv.remove();
    fecharModal();
    try {
      const res = await fetch(`${URL_API}/reservas/${id}`, {
        method: 'DELETE',
        headers: headersAuth()
      });
      if (checar401(res.status)) return;
      const dados = await res.json();
      document.getElementById(`card-reserva-${id}`)?.remove();
      mostrarModal('sucesso', dados.mensagem, true);
      carregarDashboard();
      carregarAnalytics();
    } catch (err) {
      mostrarModal('erro', 'Erro ao apagar a reunião.');
    }
  };

  botoesDiv.appendChild(btnCancelar);
  botoesDiv.appendChild(btnConfirmar);
  // Insere antes da barra de progresso (ou no final do card)
  barWrap ? modalCard.insertBefore(botoesDiv, barWrap) : modalCard.appendChild(botoesDiv);
}

// ADMIN — Apagar todas as reuniões concluídas
// ------------------------------------------------------------
async function apagarConcluidas() {
  const confirmar = window.confirm('Deseja apagar todas as reuniões com status "Concluída"? Esta ação não pode ser desfeita.');
  if (!confirmar) return;

  try {
    const res = await fetch(`${URL_API}/historico/concluidas`, {
      method: 'DELETE',
      headers: headersAuth()
    });

    if (checar401(res.status)) return;
    const dados = await res.json();

    mostrarModal('sucesso', dados.mensagem, true);

    // Recarrega tudo após apagar
    carregarDashboard();
    carregarLista(abaAtiva);
    carregarAnalytics();

  } catch (err) {
    console.error('Erro ao apagar histórico:', err);
    mostrarModal('erro', 'Erro ao conectar com o servidor.');
  }
}

// ------------------------------------------------------------
// INICIALIZAÇÃO
// ------------------------------------------------------------
window.onload = init;