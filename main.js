
const URL_API = `${window.location.origin}/api`;

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

  // Preenche data padrão (hoje) e bloqueia datas passadas
  const inputData = document.getElementById('inputData');
  const dataHoje = new Date().toISOString().split('T')[0];
  inputData.value = dataHoje;
  inputData.min = dataHoje;

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
  // Persiste a preferência do usuário
  localStorage.setItem('canaa_tema', isDark ? 'dark' : 'light');
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

/** Atualiza o contador de caracteres da pré-ata */
function atualizarContadorPreAta(el) {
  const max = parseInt(el.maxLength) || 600;
  const usado = el.value.length;
  const restante = max - usado;
  const contador = document.getElementById('contadorPreAta');
  if (!contador) return;
  contador.textContent = `${usado} / ${max}`;
  if (restante <= 50) {
    contador.className = 'text-[10px] font-mono text-red-400 transition-colors font-bold';
  } else if (restante <= 150) {
    contador.className = 'text-[10px] font-mono text-yellow-400 transition-colors';
  } else {
    contador.className = 'text-[10px] font-mono text-slate-400 transition-colors';
  }
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
      // Reseta o contador da pré-ata
      const contador = document.getElementById('contadorPreAta');
      if (contador) {
        contador.textContent = '0 / 600';
        contador.className = 'text-[10px] font-mono text-slate-400 transition-colors';
      }
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

    // ── BANNER REUNIÃO ONLINE ─────────────────────────────────
    const bannerOnline = document.getElementById('bannerOnline');
    if (bannerOnline) {
      const online = status.reuniaoOnlineAtiva;
      if (online) {
        bannerOnline.classList.remove('hidden');
        document.getElementById('bannerOnlineTitulo').textContent = online.titulo;
        document.getElementById('bannerOnlineGestor').textContent = `por ${online.gestor}`;
        document.getElementById('bannerOnlineHorarioTexto').textContent = `${online.horaInicio} → ${online.horaFim}`;
        const linkEl = document.getElementById('bannerOnlineLink');
        if (online.link_reuniao) {
          linkEl.href = online.link_reuniao;
          linkEl.style.opacity = '1';
          linkEl.style.pointerEvents = 'auto';
        } else {
          linkEl.href = '#';
          linkEl.style.opacity = '0.4';
          linkEl.style.pointerEvents = 'none';
        }
      } else {
        bannerOnline.classList.add('hidden');
      }
    }

    // ── Título da aba ─────────────────────────────────────────
    if (!status.salaLivre) {
      document.title = `🔴 OCUPADA: ${status.reservaAtiva?.titulo || 'Em uso'} — Canaã Telecom`;
    } else if (status.reuniaoOnlineAtiva) {
      document.title = `🟣 ONLINE: ${status.reuniaoOnlineAtiva.titulo} — Canaã Telecom`;
    } else {
      document.title = '🟢 SALA LIVRE — Canaã Telecom';
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

    // Card reunião ativa — prioriza presencial sobre online
    const cardTitulo = document.getElementById('cardReuniaoTitulo');
    if (status.reservaAtiva) {
      cardTitulo.textContent = status.reservaAtiva.titulo;
    } else if (status.reuniaoOnlineAtiva) {
      cardTitulo.textContent = `🟣 ${status.reuniaoOnlineAtiva.titulo}`;
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

  const cabecalho = document.getElementById('cabecalhoLista');

  if (aba === 'proximos') {
    btnProximos.className = estiloAtivo;
    btnHistorico.className = estiloInativo;
    if (cabecalho) cabecalho.classList.remove('hidden');
  } else {
    btnProximos.className = estiloInativo;
    btnHistorico.className = estiloAtivo;
    if (cabecalho) cabecalho.classList.add('hidden');
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

    lista.innerHTML = reservas.map(r =>
      aba === 'historico' ? renderCartaoHistorico(r) : renderCartaoReserva(r)
    ).join('');

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

/** Card compacto para o histórico — título, data/horário e badge de status real */
function renderCartaoHistorico(r) {
  const titulo = escapeHtml(r.titulo);
  const data = formatarData(r.data);
  const badgesHistorico = {
    'Concluída': '<span class="text-xs font-semibold text-slate-400 dark:text-slate-500 bg-slate-100 dark:bg-white/5 px-2 py-0.5 rounded-full flex-shrink-0">Concluída</span>',
    'Cancelada': '<span class="text-xs font-semibold text-red-400 bg-red-50 dark:bg-red-900/20 px-2 py-0.5 rounded-full flex-shrink-0 line-through">Cancelada</span>',
    'Em andamento': '<span class="text-xs font-semibold text-emerald-500 bg-emerald-50 dark:bg-emerald-900/20 px-2 py-0.5 rounded-full flex-shrink-0">Em andamento</span>',
    'Agendada': '<span class="text-xs font-semibold text-blue-500 bg-blue-50 dark:bg-blue-900/20 px-2 py-0.5 rounded-full flex-shrink-0">Agendada</span>',
  };
  const badge = badgesHistorico[r.statusDinamico] || badgesHistorico['Concluída'];
  const motivoHtml = (r.statusDinamico === 'Cancelada' && r.motivo_cancelamento) ? `
    <p class="text-[10px] text-red-400/70 italic px-4 pb-1.5 leading-relaxed">Motivo: ${escapeHtml(r.motivo_cancelamento)}</p>` : '';
  return `
    <div class="border-b border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-white/[0.02] transition-colors">
      <div class="flex items-center gap-3 px-4 py-2.5">
        <div class="flex-1 min-w-0">
          <p class="text-sm font-semibold dark:text-slate-100 truncate ${r.statusDinamico === 'Cancelada' ? 'line-through opacity-60' : ''}">${titulo}</p>
          <p class="text-xs text-slate-400 font-mono">${data} &nbsp;${r.horaInicio}<span class="text-slate-300 dark:text-slate-600"> → </span>${r.horaFim}</p>
        </div>
        ${badge}
      </div>
      ${motivoHtml}
    </div>
  `;
}

/** Escapa caracteres HTML para prevenir XSS */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Retorna o HTML do badge de status dinâmico */
function renderBadgeStatus(statusDinamico) {
  switch (statusDinamico) {
    case 'Concluída': return '<span class="text-xs font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-300">Concluída</span>';
    case 'Em andamento': return '<span class="text-xs font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300 animate-pulse">● Em andamento</span>';
    case 'Agendada': return '<span class="text-xs font-bold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">Agendada</span>';
    case 'Cancelada': return '<span class="text-xs font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-500 dark:bg-red-900/30 dark:text-red-400 line-through">Cancelada</span>';
    default: return '<span class="text-xs font-bold px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-700">Pendente</span>';
  }
}

/** Renderiza o HTML de um item da lista no layout compacto de linha única */
function renderCartaoReserva(r) {
  const usuario = obterUsuario();
  const isAdmin = usuario?.role === 'admin';
  const criadorDaReuniao = usuario?.id === r.usuario_id;
  const podeConfirmar = r.statusDinamico === 'Agendada' || r.statusDinamico === 'Em andamento';
  const confirmados = r.confirmados ?? 0;
  const euConfirmei = r.euConfirmei;
  const participantes = r.participantesNomes || [];
  const titulo = escapeHtml(r.titulo);
  const gestor = escapeHtml(r.gestor) || '—';
  const dataDDMMYYYY = formatarData(r.data);

  // Badge de status — compacto
  const statusBadge = {
    'Concluída': `<span class="text-[10px] font-semibold text-slate-400 dark:text-slate-500">Concluída</span>`,
    'Em andamento': `<span class="text-[10px] font-bold text-emerald-500 dark:text-emerald-400 animate-pulse">● Ativo</span>`,
    'Agendada': `<span class="text-[10px] font-semibold text-blue-500 dark:text-blue-400">Agendada</span>`,
    'Cancelada': `<span class="text-[10px] font-semibold text-red-400 dark:text-red-400 line-through">Cancelada</span>`,
  }[r.statusDinamico] || `<span class="text-[10px] text-slate-400">—</span>`;

  // Badge de modalidade — compacto
  const tipoBadge = r.modalidade === 'online'
    ? `<a href="${r.link_reuniao || '#'}" target="_blank" title="Abrir link da reunião"
         class="text-[10px] font-bold text-purple-500 dark:text-purple-400 hover:underline">Online ↗</a>`
    : `<span class="text-[10px] text-slate-400 dark:text-slate-500">Presencial</span>`;

  // Ícone de pauta — só aparece se tiver pré-ata
  const pautaIcon = r.pre_ata ? `
    <button onclick="togglePreAta(${r.id})" title="Ver pauta"
      class="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded hover:bg-slate-100 dark:hover:bg-white/10 text-slate-300 dark:text-slate-600 hover:text-cyan-500 dark:hover:text-cyan-400 transition-colors">
      <svg id="chevron-${r.id}" class="w-3.5 h-3.5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
      </svg>
    </button>` : `<span class="w-6 flex-shrink-0"></span>`;

  // Pauta expansiva
  const pautaConteudo = r.pre_ata ? `
    <div id="preata-${r.id}" class="hidden px-3 pb-2">
      <p class="text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-white/[0.03] rounded-lg px-3 py-2 leading-relaxed whitespace-pre-wrap border border-slate-100 dark:border-white/5">${escapeHtml(r.pre_ata)}</p>
    </div>` : '';

  // RSVP — ícone + contagem inline
  const rsvpSection = podeConfirmar ? `
    <button id="rsvp-btn-${r.id}" onclick="confirmarPresenca(${r.id}, ${criadorDaReuniao})" title="${euConfirmei ? 'Cancelar presença' : 'Confirmar presença'}"
      class="flex-shrink-0 flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold transition-all border
      ${euConfirmei
      ? 'bg-emerald-50 border-emerald-200 text-emerald-600 dark:bg-emerald-900/30 dark:border-emerald-700/40 dark:text-emerald-400 hover:bg-red-50 hover:border-red-200 hover:text-red-500 dark:hover:bg-red-900/20 dark:hover:border-red-700/40 dark:hover:text-red-400'
      : 'bg-transparent border-slate-200 text-slate-400 dark:border-white/10 dark:text-slate-500 hover:bg-emerald-50 hover:border-emerald-200 hover:text-emerald-600 dark:hover:bg-emerald-900/20 dark:hover:border-emerald-700/40 dark:hover:text-emerald-400'}">
      <svg class="w-2.5 h-2.5" fill="${euConfirmei ? 'currentColor' : 'none'}" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/>
      </svg>
      <span id="rsvp-count-${r.id}">${confirmados}</span>
    </button>` : (confirmados > 0 ? `
    <span class="flex-shrink-0 text-[10px] text-slate-400 dark:text-slate-500">✓ <span id="rsvp-count-${r.id}">${confirmados}</span></span>` : `<span id="rsvp-count-${r.id}" class="hidden"></span>`);

  // Nomes dos participantes — só para o criador, em linha discreta abaixo
  const nomesHtml = (criadorDaReuniao && participantes.length > 0) ? `
    <div id="rsvp-nomes-${r.id}" class="flex flex-wrap gap-1 px-3 pb-1.5">
      ${participantes.map(n => `<span class="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400 font-medium">${escapeHtml(n)}</span>`).join('')}
    </div>` : `<div id="rsvp-nomes-${r.id}"></div>`;

  // Botão de cancelar — somente o criador, só quando a reunião ainda pode ser cancelada
  const podeCancelar = criadorDaReuniao &&
    (r.statusDinamico === 'Agendada' || r.statusDinamico === 'Em andamento');
  const cancelBtn = podeCancelar ? `
    <button onclick="solicitarCancelamento(${r.id}, '${escapeHtml(r.titulo).replace(/'/g, '&#39;')}')" title="Cancelar reunião"
      class="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-slate-300 dark:text-slate-600 hover:text-orange-500 dark:hover:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-900/20 transition-colors">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"/>
      </svg>
    </button>` : '';

  // Motivo de cancelamento (expansivo)
  const motivoHtml = (r.statusDinamico === 'Cancelada' && r.motivo_cancelamento) ? `
    <div class="px-3 pb-2">
      <p class="text-[10px] text-red-400/80 italic bg-red-50 dark:bg-red-900/10 rounded px-2 py-1 border border-red-100 dark:border-red-900/30">Motivo: ${escapeHtml(r.motivo_cancelamento)}</p>
    </div>` : '';

  // Botão de exclusão — ícone pequeno, só para admin
  const deleteBtn = isAdmin ? `
    <button onclick="cancelarReserva(${r.id}, '${escapeHtml(r.titulo).replace(/'/g, '&#39;')}')" title="Apagar reunião"
      class="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-slate-300 dark:text-slate-600 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
      </svg>
    </button>` : '';

  return `
    <div id="card-reserva-${r.id}" class="border-b border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-white/[0.02] transition-colors${r.statusDinamico === 'Cancelada' ? ' opacity-60' : ''}">
      <div class="flex items-center gap-2 px-3 py-2">

        <!-- Horário -->
        <div class="flex-shrink-0 w-[68px]">
          <p class="text-[10px] text-slate-400 font-mono leading-none">${dataDDMMYYYY}</p>
          <p class="text-xs font-bold text-blue-600 dark:text-canaa-cyan leading-snug mt-0.5">${r.horaInicio}<span class="text-slate-400 dark:text-slate-500 font-normal text-[10px]">→${r.horaFim}</span></p>
        </div>

        <!-- Título + gestor -->
        <div class="flex-1 min-w-0">
          <p class="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate leading-snug${r.statusDinamico === 'Cancelada' ? ' line-through' : ''}">${titulo}</p>
          <p class="text-[10px] text-slate-400 dark:text-slate-500 truncate">${gestor}</p>
        </div>

        <!-- Status + Tipo -->
        <div class="flex-shrink-0 flex flex-col items-end gap-0.5 min-w-[58px] text-right">
          ${statusBadge}
          ${tipoBadge}
        </div>

        <!-- Ações: pauta + rsvp + cancelar + delete -->
        <div class="flex-shrink-0 flex items-center gap-0.5 ml-1">
          ${pautaIcon}
          ${rsvpSection}
          ${cancelBtn}
          ${deleteBtn}
        </div>

      </div>
      ${pautaConteudo}
      ${nomesHtml}
      ${motivoHtml}
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

// ------------------------------------------------------------
// CANCELAR REUNIÃO (somente o criador)
// ------------------------------------------------------------

/** Abre o modal de confirmação com campo de motivo para cancelar uma reunião */
function solicitarCancelamento(id, titulo) {
  mostrarModal('aviso', `Cancelar a reunião "${titulo}"?`);

  // Limpa botões anteriores
  document.getElementById('adminConfirmarBtn')?.remove();
  document.getElementById('adminCancelarBtn')?.remove();
  document.getElementById('cancelMotivoPainel')?.remove();

  const barWrap = document.getElementById('modalBarWrap');
  const modalCard = document.getElementById('modalCard');

  // Textarea de motivo
  const motivoPainel = document.createElement('div');
  motivoPainel.id = 'cancelMotivoPainel';
  motivoPainel.className = 'mt-3';
  motivoPainel.innerHTML = `
    <textarea id="cancelMotivoTexto" rows="2" maxlength="300" placeholder="Motivo do cancelamento (opcional)"
      class="w-full text-xs rounded-lg bg-white/5 border border-white/10 text-slate-300 placeholder-slate-500 px-3 py-2 resize-none focus:outline-none focus:border-orange-400 transition-colors"></textarea>
    <p class="text-[10px] text-slate-500 mt-0.5 text-right">Máx. 300 caracteres</p>
  `;

  // Botões
  const botoesDiv = document.createElement('div');
  botoesDiv.className = 'flex gap-2 mt-3 justify-end';

  const btnNao = document.createElement('button');
  btnNao.id = 'adminCancelarBtn';
  btnNao.textContent = 'Não';
  btnNao.className = 'px-4 py-1.5 text-xs font-bold rounded-lg bg-white/10 hover:bg-white/20 text-slate-300 transition-all';
  btnNao.onclick = () => { motivoPainel.remove(); botoesDiv.remove(); fecharModal(); };

  const btnSim = document.createElement('button');
  btnSim.id = 'adminConfirmarBtn';
  btnSim.textContent = 'Sim, cancelar';
  btnSim.className = 'px-4 py-1.5 text-xs font-bold rounded-lg bg-orange-500 hover:bg-orange-600 text-white transition-all';
  btnSim.onclick = () => {
    const motivo = document.getElementById('cancelMotivoTexto')?.value.trim() || '';
    motivoPainel.remove();
    botoesDiv.remove();
    fecharModal();
    executarCancelamento(id, motivo);
  };

  botoesDiv.appendChild(btnNao);
  botoesDiv.appendChild(btnSim);
  barWrap ? modalCard.insertBefore(motivoPainel, barWrap) : modalCard.appendChild(motivoPainel);
  barWrap ? modalCard.insertBefore(botoesDiv, barWrap) : modalCard.appendChild(botoesDiv);
}

/** Chama a API para cancelar a reunião e atualiza o card inline */
async function executarCancelamento(id, motivo) {
  try {
    const res = await fetch(`${URL_API}/reservas/${id}/cancelar`, {
      method: 'PATCH',
      headers: headersAuth(),
      body: JSON.stringify({ motivo })
    });
    if (checar401(res.status)) return;
    const dados = await res.json();

    if (res.ok) {
      mostrarModal('sucesso', dados.mensagem, true);
      carregarDashboard();
      carregarLista(abaAtiva);
      carregarAnalytics();
    } else {
      mostrarModal('erro', dados.mensagem || 'Erro ao cancelar a reunião.');
    }
  } catch (err) {
    console.error('Erro ao cancelar reunião:', err);
    mostrarModal('erro', 'Erro ao conectar com o servidor.');
  }
}


/** Toggle de RSVP via PATCH /api/reservas/:id/presenca */
async function confirmarPresenca(reservaId, criador = false) {
  const usuario = obterUsuario();
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

    if (btn) {
      // Classes para estado confirmado
      const clsOn = 'bg-emerald-50 border-emerald-200 text-emerald-600 dark:bg-emerald-900/30 dark:border-emerald-700/40 dark:text-emerald-400 hover:bg-red-50 hover:border-red-200 hover:text-red-500 dark:hover:bg-red-900/20 dark:hover:border-red-700/40 dark:hover:text-red-400';
      const clsOff = 'bg-transparent border-slate-200 text-slate-400 dark:border-white/10 dark:text-slate-500 hover:bg-emerald-50 hover:border-emerald-200 hover:text-emerald-600 dark:hover:bg-emerald-900/20 dark:hover:border-emerald-700/40 dark:hover:text-emerald-400';

      // Remove ambos os conjuntos de classes e aplica o novo estado
      btn.classList.remove(...clsOn.split(' '), ...clsOff.split(' '));
      btn.classList.add(...(dados.confirmou ? clsOn : clsOff).split(' '));

      // Atualiza o título (tooltip) do botão
      btn.title = dados.confirmou ? 'Cancelar presença' : 'Confirmar presença';

      // Atualiza o fill do SVG dentro do botão
      const svg = btn.querySelector('svg');
      if (svg) svg.setAttribute('fill', dados.confirmou ? 'currentColor' : 'none');
    }

    // Atualiza contagem
    if (count) count.textContent = dados.confirmados;

    // Atualiza a lista de nomes inline (visível somente para o criador)
    if (criador && usuario) {
      let nomesDiv = document.getElementById(`rsvp-nomes-${reservaId}`);

      if (dados.confirmou) {
        if (nomesDiv) {
          // Evita duplicação: remove chip anterior do mesmo usuário se existir
          const chipExistente = nomesDiv.querySelector(`[data-uid="${usuario.id}"]`);
          if (!chipExistente) {
            const chip = document.createElement('span');
            chip.dataset.uid = usuario.id;
            chip.className = 'text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400 font-medium';
            chip.textContent = escapeHtml(usuario.nome);
            nomesDiv.appendChild(chip);
          }
        }
      } else {
        // Remove o chip do usuário logado
        if (nomesDiv) {
          const chip = nomesDiv.querySelector(`[data-uid="${usuario.id}"]`);
          chip?.remove();
        }
      }
    }

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
  // Usa o modal customizado em vez do window.confirm nativo
  mostrarModal('aviso', 'Deseja apagar todas as reuniões com status "Concluída"? Esta ação não pode ser desfeita.');

  // Remove botões anteriores se existirem
  document.getElementById('adminConfirmarBtn')?.remove();
  document.getElementById('adminCancelarBtn')?.remove();

  const barWrap = document.getElementById('modalBarWrap');
  const modalCard = document.getElementById('modalCard');

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
      const res = await fetch(`${URL_API}/historico/concluidas`, {
        method: 'DELETE',
        headers: headersAuth()
      });
      if (checar401(res.status)) return;
      const dados = await res.json();
      mostrarModal('sucesso', dados.mensagem, true);
      carregarDashboard();
      carregarLista(abaAtiva);
      carregarAnalytics();
    } catch (err) {
      console.error('Erro ao apagar histórico:', err);
      mostrarModal('erro', 'Erro ao conectar com o servidor.');
    }
  };

  botoesDiv.appendChild(btnCancelar);
  botoesDiv.appendChild(btnConfirmar);
  barWrap ? modalCard.insertBefore(botoesDiv, barWrap) : modalCard.appendChild(botoesDiv);
}

// ------------------------------------------------------------
// ATUALIZAÇÃO EM TEMPO REAL — Server-Sent Events
// ------------------------------------------------------------

/** Conecta ao endpoint SSE e recarrega os dados ao receber eventos */
function iniciarSSE() {
  const sse = new EventSource(`${URL_API.replace('/api', '')}/api/eventos`);

  sse.addEventListener('atualizacao', () => {
    carregarDashboard();
    carregarLista(abaAtiva);
    carregarAnalytics();
  });

  sse.onerror = () => {
    // O EventSource reconecta automaticamente — apenas loga o erro sem alertar
    console.warn('SSE: conexão perdida, aguardando reconexão automática...');
  };
}

// ------------------------------------------------------------
// INICIALIZAÇÃO
// ------------------------------------------------------------
window.onload = () => {
  init();
  // Inicia o listener de atualizações em tempo real (somente se logado)
  if (obterToken()) iniciarSSE();

  // Polling a cada 60s para capturar mudanças de status pelo passar do tempo
  // (início/fim de reuniões), que o SSE não detecta pois só dispara em ações no banco
  if (obterToken()) {
    setInterval(() => {
      carregarDashboard();
      carregarLista(abaAtiva);
    }, 60 * 1000);
  }

  // Verifica se a integração com Notion está ativa (somente para admins)
  const usuario = obterUsuario();
  if (usuario?.role === 'admin') verificarStatusNotion();
};

// ------------------------------------------------------------
// NOTION — Sincronização com banco de dados do Notion
// ------------------------------------------------------------

/** Verifica no backend se o Notion está configurado e atualiza o badge no card admin */
async function verificarStatusNotion() {
  const badge = document.getElementById('notionStatusBadge');
  const btn = document.getElementById('btnSyncNotion');
  if (!badge) return;

  try {
    const res = await fetch(`${URL_API}/notion/status`, { headers: headersAuth() });
    if (!res.ok) throw new Error();
    const { configurado } = await res.json();

    if (configurado) {
      badge.textContent = '● Conectado';
      badge.className = 'ml-auto text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400';
    } else {
      badge.textContent = '● Não configurado';
      badge.className = 'ml-auto text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400';
      if (btn) btn.disabled = true;
    }
  } catch {
    badge.textContent = '● Erro';
    badge.className = 'ml-auto text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400';
  }
}

/** Sincroniza todas as reservas futuras com o Notion (botão no card admin) */
async function sincronizarNotion() {
  const btn = document.getElementById('btnSyncNotion');
  if (btn) { btn.disabled = true; btn.textContent = 'Sincronizando...'; }

  try {
    const res = await fetch(`${URL_API}/notion/sync`, {
      method: 'POST',
      headers: headersAuth()
    });
    if (checar401(res.status)) return;
    const dados = await res.json();

    if (res.ok) {
      mostrarModal('sucesso', dados.mensagem, true);
    } else {
      mostrarModal('erro', dados.mensagem || 'Erro ao sincronizar com o Notion.');
    }
  } catch (err) {
    console.error('Erro ao sincronizar com Notion:', err);
    mostrarModal('erro', 'Erro ao conectar com o servidor.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Sincronizar com Notion'; }
  }
}