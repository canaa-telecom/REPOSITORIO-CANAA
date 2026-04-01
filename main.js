
const URL_API = `${window.location.origin}/api`;

// Aba ativa na lista de agendamentos
let abaAtiva = 'proximos';

// ── Controle de requisições concorrentes ─────────────────────
const _abort = { dashboard: null, lista: null };

function abortarESolicitar(chave) {
  if (_abort[chave]) { _abort[chave].abort(); }
  _abort[chave] = new AbortController();
  return _abort[chave].signal;
}

// Cache do último conteúdo renderizado — evita re-render desnecessário
const _cacheJson = { dashboard: null, proximos: null, historico: null, analytics: null };

// Dados brutos do histórico (para filtragem em memória)
let _dadosBrutosHistorico = [];

// Controla se a lista já teve sua primeira carga (evita "Carregando..." em background)
const _listaCarregada = { proximos: false, historico: false };

// Referência única de conexão SSE — evita acúmulo ao pressionar F5
let _sseConexao = null;

// Debounce do SSE — atualiza apenas dashboard e analytics em background.
// A lista SÓ muda quando o usuário cria/cancela/apaga uma reunião, não por polling.
let _sseDebounceTimer = null;
function dispararAtualizacao({ incluirLista = false } = {}) {
  clearTimeout(_sseDebounceTimer);
  _sseDebounceTimer = setTimeout(() => {
    carregarDashboard();
    carregarAnalytics();
    if (incluirLista) carregarLista(abaAtiva, false); // false = background, sem flash
  }, 300);
}

// Fecha a conexão SSE ao sair da página
window.addEventListener('beforeunload', () => {
  if (_sseConexao) { _sseConexao.close(); _sseConexao = null; }
});

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

// ── 2. INICIALIZAÇÃO ──────────────────────────────────────────────────────────
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

  // Carrega lista de usuários para o seletor de participantes
  carregarUsuariosParticipantes();

  // Fecha o dropdown de participantes ao clicar fora
  document.addEventListener('click', (e) => {
    const chips = document.getElementById('participantesChips');
    const dropdown = document.getElementById('participantesDropdown');
    if (chips && dropdown && !chips.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.classList.add('hidden');
    }

    // Fecha o dropdown de filtros ao clicar fora do painel de filtros
    const painelFiltros = document.getElementById('painelFiltrosHistorico');
    const filtrosCorpo  = document.getElementById('filtrosCorpo');
    if (filtrosCorpo?.classList.contains('filtros-aberto') &&
        painelFiltros && !painelFiltros.contains(e.target)) {
      filtrosCorpo.classList.remove('filtros-aberto');
      const chevron = document.getElementById('chevronFiltros');
      if (chevron) chevron.style.transform = '';
    }
  });

  // Carrega tudo
  carregarDashboard();
  carregarLista('proximos');
  carregarAnalytics();

  // Inicializa posição da bolinha conforme tema atual
  const isDark = document.documentElement.classList.contains('dark');
  atualizarToggle(isDark);
}

// ── 3. TEMA ─────────────────────────────────────────────────────────────────────

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

// ── 4. MODAL POPUP ──────────────────────────────────────────────────────────────

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

// ── 5. FORMULÁRIO DINÂMICO — Modalidade ────────────────────────────────────────

/** Exibe/oculta o campo de link e de sala conforme a modalidade selecionada */
function alternarModalidade() {
  const modalidade = document.getElementById('selectModalidade').value;
  document.getElementById('boxLink').classList.toggle('hidden', modalidade !== 'online');
  document.getElementById('boxSala').classList.toggle('hidden', modalidade === 'online');
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

// ── 6. ENVIAR NOVA RESERVA ──────────────────────────────────────────────────────
async function agendarReuniao(event) {
  event.preventDefault();

  const titulo = document.getElementById('inputTitulo').value.trim();
  const data = document.getElementById('inputData').value;
  const horaInicio = document.getElementById('inputInicio').value;
  const horaFim = document.getElementById('inputFim').value;
  const modalidade = document.getElementById('selectModalidade').value;
  // Sala só é relevante para presencial; online envia null
  const sala = modalidade === 'presencial'
    ? (document.getElementById('selectSala')?.value || 'Sala de Reunião')
    : null;
  const link_reuniao = document.getElementById('inputLink').value.trim() || null;
  const pre_ata = document.getElementById('inputPreAta').value.trim() || null;

  // Coleta os IDs dos participantes selecionados
  const participanteIds = Array.from(
    document.querySelectorAll('.participante-check:checked')
  ).map(el => parseInt(el.value));

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
      body: JSON.stringify({ titulo, data, horaInicio, horaFim, modalidade, sala, link_reuniao, pre_ata, participanteIds })
    });

    if (checar401(resposta.status)) return;
    const resultado = await resposta.json();

    if (!resposta.ok) {
      const tipo = resultado.tipoConflito === 'participante' ? 'aviso' : 'erro';
      mostrarModal(tipo, resultado.mensagem);
    } else {
      mostrarModal('sucesso', resultado.mensagem, true);
      document.getElementById('formReserva').reset();
      document.getElementById('boxLink').classList.add('hidden');
      document.getElementById('boxSala').classList.remove('hidden'); // reseta visibilidade da sala
      limparParticipantes();
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

// ── PARTICIPANTES — Seletor no formulário ──────────────────────────────────────

/** Busca todos os usuários do sistema e popula a lista de participantes */
async function carregarUsuariosParticipantes() {
  try {
    const res = await fetch(`${URL_API}/usuarios`, { headers: headersAuth() });
    if (!res.ok) return;
    const usuarios = await res.json();

    const lista = document.getElementById('participantesLista');
    if (!lista) return;

    lista.innerHTML = usuarios.map(u => `
      <label class="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-slate-50 dark:hover:bg-white/5 transition-colors">
        <input type="checkbox" value="${u.id}" onchange="toggleParticipante(this, ${u.id}, '${escapeHtml(u.nome)}')"
          class="participante-check w-4 h-4 accent-blue-600 cursor-pointer" />
        <span class="text-xs text-slate-700 dark:text-slate-200">${escapeHtml(u.nome)}</span>
      </label>
    `).join('');
  } catch (err) {
    console.error('Erro ao carregar usuários:', err);
  }
}

/** Adiciona ou remove um chip de participante na área de seleção */
function toggleParticipante(checkbox, id, nome) {
  const chipsContainer = document.getElementById('participantesChips');
  const placeholder = document.getElementById('participantesPlaceholder');

  if (checkbox.checked) {
    // Cria chip
    const chip = document.createElement('span');
    chip.id = `chip-participante-${id}`;
    chip.dataset.uid = id;
    chip.className = 'flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 border border-blue-200 dark:border-blue-700/50';
    chip.innerHTML = `${escapeHtml(nome)} <button type="button" onclick="removerParticipante(${id})" class="ml-0.5 text-blue-400 hover:text-red-500 transition-colors font-bold leading-none">×</button>`;
    chipsContainer.appendChild(chip);
  } else {
    // Remove chip
    document.getElementById(`chip-participante-${id}`)?.remove();
  }

  // Mostra/oculta placeholder
  const temChips = chipsContainer.querySelectorAll('[data-uid]').length > 0;
  if (placeholder) placeholder.classList.toggle('hidden', temChips);
}

/** Remove um participante desmarcando o checkbox e eliminando o chip */
function removerParticipante(id) {
  document.getElementById(`chip-participante-${id}`)?.remove();
  const checkbox = document.querySelector(`.participante-check[value="${id}"]`);
  if (checkbox) checkbox.checked = false;

  const chipsContainer = document.getElementById('participantesChips');
  const placeholder = document.getElementById('participantesPlaceholder');
  const temChips = chipsContainer?.querySelectorAll('[data-uid]').length > 0;
  if (placeholder) placeholder.classList.toggle('hidden', temChips);
}

/** Limpa todos os participantes selecionados (usado após o agendamento) */
function limparParticipantes() {
  // Desmarca todos os checkboxes
  document.querySelectorAll('.participante-check').forEach(cb => cb.checked = false);
  // Remove chips
  const chipsContainer = document.getElementById('participantesChips');
  if (chipsContainer) {
    chipsContainer.querySelectorAll('[data-uid]').forEach(c => c.remove());
  }
  // Mostra placeholder
  const placeholder = document.getElementById('participantesPlaceholder');
  if (placeholder) placeholder.classList.remove('hidden');
  // Fecha dropdown
  document.getElementById('participantesDropdown')?.classList.add('hidden');
}

// ── 7. DASHBOARD — Banner e cards de métricas ──────────────────────────────────
async function carregarDashboard() {
  try {
    const resStatus = await fetch(`${URL_API}/status`, { headers: headersAuth() });
    if (checar401(resStatus.status)) return;
    const status = await resStatus.json();

    // ── BANNER (multi-sala) ──────────────────────────────────
    const banner     = document.getElementById('bannerStatus');
    const bannerTit  = document.getElementById('bannerTitulo');
    const bannerDot  = document.getElementById('bannerDot');
    const chipsEl    = document.getElementById('bannerSalasChips');

    const salas        = Array.isArray(status.salas) ? status.salas : [];
    const temDadosSalas = salas.length > 0;
    // Se não temos dados de salas, usa o campo legado como fallback seguro
    const todasLivres   = temDadosSalas ? salas.every(s => s.livre) : (status.salaLivre !== false);
    const algumOcupada  = salas.some(s => !s.livre);

    const bannerBase = 'flex items-center gap-2 sm:gap-3 px-4 sm:px-6 py-2 text-xs font-medium transition-all duration-700 border-b flex-wrap';

    if (todasLivres) {
      banner.className = `${bannerBase} bg-emerald-500/10 border-emerald-400/20`;
      bannerTit.textContent = 'SALAS LIVRES';
      bannerTit.className = 'font-bold uppercase tracking-widest text-emerald-400';
      bannerDot.className = 'w-2 h-2 rounded-full bg-emerald-400 status-dot-green flex-shrink-0';
    } else {
      banner.className = `${bannerBase} bg-red-600/10 border-red-400/20`;
      const qtdOcupadas = salas.filter(s => !s.livre).length;
      // Evita falso positivo: 0===0 quando salas=[]
      if (!temDadosSalas) {
        bannerTit.textContent = 'SALA OCUPADA';
      } else if (qtdOcupadas === salas.length) {
        bannerTit.textContent = 'SALAS OCUPADAS';
      } else {
        bannerTit.textContent = `${qtdOcupadas} SALA${qtdOcupadas > 1 ? 'S' : ''} OCUPADA${qtdOcupadas > 1 ? 'S' : ''}`;
      }
      bannerTit.className = 'font-bold uppercase tracking-widest text-red-400';
      bannerDot.className = 'w-2 h-2 rounded-full bg-red-400 status-dot-red flex-shrink-0';
    }

    // Renderiza chips por sala
    if (chipsEl && salas.length > 0) {
      chipsEl.innerHTML = salas.map(s => {
        if (s.livre) {
          return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0"></span>${escapeHtml(s.nome)}
          </span>`;
        } else {
          const ra = s.reservaAtiva;
          const fim = ra?.horafim || ra?.horaFim || '—';
          const titulo = ra?.titulo ? ` · ${escapeHtml(ra.titulo)}` : '';
          return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-500/10 text-red-400 border border-red-500/20">
            <span class="w-1.5 h-1.5 rounded-full bg-red-400 flex-shrink-0"></span>${escapeHtml(s.nome)}${titulo}<span class="opacity-60 font-normal">até ${fim}</span>
          </span>`;
        }
      }).join('');
    }

    // ── BANNER REUNIÃO ONLINE ─────────────────────────────────
    const bannerOnline = document.getElementById('bannerOnline');
    if (bannerOnline) {
      const online = status.reuniaoOnlineAtiva;
      if (online) {
        const oIni = online.horainicio || online.horaInicio || '—';
        const oFim = online.horafim   || online.horaFim   || '—';
        bannerOnline.classList.remove('hidden');
        document.getElementById('bannerOnlineTitulo').textContent = online.titulo;
        document.getElementById('bannerOnlineGestor').textContent = `por ${online.gestor}`;
        document.getElementById('bannerOnlineHorarioTexto').textContent = `${oIni} → ${oFim}`;
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
    if (algumOcupada) {
      const primeiraOcupada = salas.find(s => !s.livre);
      document.title = `🔴 OCUPADA: ${primeiraOcupada?.reservaAtiva?.titulo || 'Em uso'} — Canaã Telecom`;
    } else if (status.reuniaoOnlineAtiva) {
      document.title = `🟣 ONLINE: ${status.reuniaoOnlineAtiva.titulo} — Canaã Telecom`;
    } else {
      document.title = '🟢 SALAS LIVRES — Canaã Telecom';
    }

    const relogio = document.getElementById('relogioAoVivo');
    if (relogio) relogio.textContent = `🕐 ${status.horaAtual}`;

    // ── CARD KPI — Sala Status ────────────────────────────────
    const cardStatus  = document.getElementById('cardSalaStatus');
    const labelStatus = document.getElementById('cardSalaLabel');
    const detalheStatus = document.getElementById('cardSalaDetalhe');
    const dotStatus   = document.getElementById('statusDot');

    const qtdLivres  = salas.filter(s => s.livre).length;
    const totalSalas = salas.length; // NÃO usa || 3: se vazio, usa texto descritivo

    if (todasLivres) {
      cardStatus.className = 'p-4 border-r border-slate-200 dark:border-white/10 transition-all duration-500';
      labelStatus.textContent = 'STATUS DAS SALAS';
      detalheStatus.textContent = totalSalas > 0 ? `${qtdLivres}/${totalSalas} Livres` : 'Disponível';
      dotStatus.className = 'w-2 h-2 rounded-full bg-emerald-400 status-dot-green';
      detalheStatus.className = 'text-lg font-display font-bold text-emerald-400';
      labelStatus.className = 'text-[10px] font-bold uppercase tracking-widest text-slate-400';
    } else {
      cardStatus.className = 'p-4 border-r border-slate-200 dark:border-white/10 transition-all duration-500';
      labelStatus.textContent = 'STATUS DAS SALAS';
      const qtdOcup = totalSalas > 0 ? totalSalas - qtdLivres : 1;
      detalheStatus.textContent = totalSalas > 0
        ? `${qtdOcup}/${totalSalas} Ocupada${qtdOcup > 1 ? 's' : ''}`
        : 'Ocupada';
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
      const pIni = status.proximaReuniao.horainicio || status.proximaReuniao.horaInicio || '—';
      cardTitulo.textContent = `Próx: ${pIni}`;
    } else {
      cardTitulo.textContent = 'Nenhuma';
    }

    document.getElementById('countReunioesHoje').textContent = status.reunioesHoje;
    document.getElementById('countPendentes').textContent = status.pendentes;

  } catch (err) {
    console.error('Erro ao carregar dashboard:', err);
  }
}


// ── 8. CONTROLE DE ABAS ─────────────────────────────────────────────────────────

/** Alterna entre as abas "Próximos" e "Histórico" */
function trocarAba(aba) {
  abaAtiva = aba;

  const btnProximos = document.getElementById('tab-btn-proximos');
  const btnHistorico = document.getElementById('tab-btn-historico');

  const estiloAtivo = 'tab-btn flex-1 py-3.5 px-4 text-sm font-semibold uppercase tracking-widest transition-all duration-200 text-blue-600 dark:text-canaa-cyan border-b-2 border-blue-600 dark:border-canaa-cyan bg-blue-50/50 dark:bg-canaa-cyan/5';
  const estiloInativo = 'tab-btn flex-1 py-3.5 px-4 text-sm font-semibold uppercase tracking-widest transition-all duration-200 text-slate-500 dark:text-slate-400 border-b-2 border-transparent hover:bg-slate-50 dark:hover:bg-white/5';

  const cabecalho = document.getElementById('cabecalhoLista');
  const painelFiltros = document.getElementById('painelFiltrosHistorico');

  if (aba === 'proximos') {
    btnProximos.className = estiloAtivo;
    btnHistorico.className = estiloInativo;
    if (cabecalho) cabecalho.classList.remove('hidden');
    if (painelFiltros) painelFiltros.classList.add('hidden');
  } else {
    btnProximos.className = estiloInativo;
    btnHistorico.className = estiloAtivo;
    if (cabecalho) cabecalho.classList.add('hidden');
    if (painelFiltros) painelFiltros.classList.remove('hidden');
  }

  carregarLista(aba, true); // true = é troca de aba, mostra "Carregando..."
}

// ── 9. CARREGAR LISTA DE RESERVAS ───────────────────────────────────────────────

/** Carrega a lista de acordo com a aba: 'proximos' ou 'historico'
 *  @param {string} aba - 'proximos' ou 'historico'
 *  @param {boolean} [primeiro=true] - se true, mostra "Carregando..." (troca de aba / primeira carga)
 */
async function carregarLista(aba, primeiro) {
  if (primeiro === undefined) primeiro = !_listaCarregada[aba];

  const lista = document.getElementById('listaReservas');
  const signal = abortarESolicitar('lista');

  // MELHORIA UX: Se já temos dados em cache, renderizamos IMEDIATAMENTE.
  // Isso remove o "Carregando..." chato ao trocar de abas que já foram visitadas.
  if (primeiro && _cacheJson[aba]) {
    const dadosCache = JSON.parse(_cacheJson[aba]);
    lista.innerHTML = dadosCache.length === 0
      ? `<div class="text-center py-8 text-slate-400 text-sm">Nenhum agendamento encontrado.</div>`
      : dadosCache.map(r => aba === 'historico' ? renderCartaoHistorico(r) : renderCartaoReserva(r)).join('');
    inicializarAcoesLote();
    atualizarBarraAcaoLote();
  } 
  // Caso contrário, se é a primeira vez ou não temos cache, mostramos o loader
  else if (primeiro) {
    lista.innerHTML = '<div class="text-center py-8 text-slate-400 text-sm">Carregando...</div>';
  }

  try {
    const endpoint = aba === 'historico' ? `${URL_API}/historico` : `${URL_API}/reservas`;
    const res = await fetch(endpoint, { headers: headersAuth(), signal });

    if (checar401(res.status)) return;

    if (res.status === 403) {
      lista.innerHTML = `<div class="text-center py-8 text-orange-400 text-sm">Acesso restrito — somente administradores.</div>`;
      return;
    }

    const reservas = await res.json();
    const novoJson = JSON.stringify(reservas);

    // Armazena dados brutos para filtragem no histórico
    if (aba === 'historico') _dadosBrutosHistorico = reservas;

    // Se os dados não mudaram, não toca no DOM — evita qualquer piscar.
    // Mas agora, se viemos de um "Carregando..." (sem cache), precisamos renderizar.
    // Com a lógica acima, se novoJson === cacheJson, o DOM já está atualizado via cache.
    if (novoJson === _cacheJson[aba]) return;

    _cacheJson[aba] = novoJson;
    _listaCarregada[aba] = true;

    lista.innerHTML = reservas.length === 0
      ? `<div class="text-center py-8 text-slate-400 text-sm">Nenhum agendamento encontrado.</div>`
      : reservas.map(r => aba === 'historico' ? renderCartaoHistorico(r) : renderCartaoReserva(r)).join('');

    inicializarAcoesLote();
    atualizarBarraAcaoLote();

    // Reaaplica os filtros do histórico se estiverem ativos (evita perda após SSE)
    if (aba === 'historico') {
      const temFiltro = [
        document.getElementById('filtroDataInicio')?.value,
        document.getElementById('filtroDataFim')?.value,
        document.getElementById('filtroStatus')?.value,
        document.getElementById('filtroSala')?.value
      ].some(v => v && v !== '');
      if (temFiltro) aplicarFiltrosHistorico();
    }
  } catch (err) {
    if (err.name === 'AbortError') return; // Cancelado intencionalmente
    console.error('Erro ao carregar lista:', err);
    // Se falhou e estávamos mostrando "Carregando", avisamos
    if (lista.innerHTML.includes('Carregando')) {
      lista.innerHTML = `<div class="text-center py-8 text-red-400 text-sm">Erro ao carregar lista.</div>`;
    }
  }
}

/** Formata uma data ISO (YYYY-MM-DD) para DD/MM/YYYY */
function formatarData(iso) {
  if (!iso) return '—';
  const [ano, mes, dia] = iso.split('-');
  return `${dia}/${mes}/${ano}`;
}

/** Card compacto para o histórico — título, data/horário, sala e badge de status real */
function renderCartaoHistorico(r) {
  const usuario = obterUsuario();
  const isAdmin = usuario?.role === 'admin';
  const titulo = escapeHtml(r.titulo);
  const data = formatarData(r.data);
  // Normaliza colunas que o PostgreSQL retorna em minúsculas
  const horaIni = r.horainicio || r.horaInicio || '—';
  const horaFi  = r.horafim    || r.horaFim    || '—';
  const salaLabel = r.modalidade === 'online' ? 'Online' : (r.sala || 'Sala de Reunião');
  const badgesHistorico = {
    'Concluída':    '<span class="text-xs font-semibold text-slate-400 dark:text-slate-500 bg-slate-100 dark:bg-white/5 px-2 py-0.5 rounded-full flex-shrink-0">Concluída</span>',
    'Cancelada':   '<span class="text-xs font-semibold text-red-400 bg-red-50 dark:bg-red-900/20 px-2 py-0.5 rounded-full flex-shrink-0 line-through">Cancelada</span>',
    'Em andamento':'<span class="text-xs font-semibold text-emerald-500 bg-emerald-50 dark:bg-emerald-900/20 px-2 py-0.5 rounded-full flex-shrink-0">Em andamento</span>',
    'Agendada':    '<span class="text-xs font-semibold text-blue-500 bg-blue-50 dark:bg-blue-900/20 px-2 py-0.5 rounded-full flex-shrink-0">Agendada</span>',
  };
  const badge = badgesHistorico[r.statusDinamico] || badgesHistorico['Concluída'];
  const motivoHtml = (r.statusDinamico === 'Cancelada' && r.motivo_cancelamento) ? `
    <p class="text-[10px] text-red-400/70 italic px-4 pb-1.5 leading-relaxed">Motivo: ${escapeHtml(r.motivo_cancelamento)}</p>` : '';
  return `
    <div class="border-b border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-white/[0.02] transition-colors relative">
      <div class="flex items-center gap-3 px-4 py-2.5">
        ${isAdmin ? `<label class="relative flex items-center cursor-pointer flex-shrink-0">
          <input type="checkbox" value="${r.id}" onchange="atualizarBarraAcaoLote()" class="check-reserva peer sr-only" />
          <div class="w-4 h-4 border-2 border-slate-300 dark:border-slate-500 rounded bg-white dark:bg-[#0c1220] peer-checked:bg-blue-600 peer-checked:border-blue-600 transition-all flex items-center justify-center">
            <svg class="w-3 h-3 text-white opacity-0 peer-checked:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" /></svg>
          </div>
        </label>` : ''}
        <div class="flex-1 min-w-0">
          <p class="text-sm font-semibold dark:text-slate-100 truncate ${r.statusDinamico === 'Cancelada' ? 'line-through opacity-60' : ''}">${titulo}</p>
          <p class="text-xs text-slate-400 font-mono">${data} &nbsp;${horaIni}<span class="text-slate-300 dark:text-slate-600"> → </span>${horaFi}
            <span class="text-[10px] text-slate-300 dark:text-slate-600 ml-1">· ${escapeHtml(salaLabel)}</span>
          </p>
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
  const salaLabel = r.modalidade === 'online' ? null : (r.sala || 'Sala de Reunião');
  const tipoBadge = r.modalidade === 'online'
    ? `<a href="${r.link_reuniao || '#'}" target="_blank" title="Abrir link da reunião"
         class="text-[10px] font-bold text-purple-500 dark:text-purple-400 hover:underline">Online ↗</a>`
    : `<span class="text-[10px] text-slate-400 dark:text-slate-500" title="${escapeHtml(salaLabel)}">${escapeHtml(salaLabel)}</span>`;

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

  // Contagem de participantes — exibe apenas ícone + número, sem botão de RSVP
  const rsvpSection = confirmados > 0
    ? `<span class="flex-shrink-0 flex items-center gap-1 text-[10px] text-slate-400 dark:text-slate-500">
        <svg class="w-2.5 h-2.5 text-emerald-500" fill="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>
        <span id="rsvp-count-${r.id}">${confirmados}</span>
      </span>`
    : `<span id="rsvp-count-${r.id}" class="hidden"></span>`;

  // Nomes dos participantes — visível para todos
  const nomesHtml = participantes.length > 0 ? `
    <div id="rsvp-nomes-${r.id}" class="flex flex-wrap gap-1 px-3 pb-1.5">
      ${participantes.map(n => `<span class="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400 font-medium">${escapeHtml(n)}</span>`).join('')}
    </div>` : `<div id="rsvp-nomes-${r.id}"></div>`;

  // Botão de cancelar — somente o criador, só quando a reunião ainda pode ser cancelada
  const podeCancelar = criadorDaReuniao &&
    (r.statusDinamico === 'Agendada' || r.statusDinamico === 'Em andamento');
  const cancelBtn = podeCancelar ? `
    <button onclick="solicitarCancelamento(${r.id}, '${escapeHtml(r.titulo)}')" title="Cancelar reunião"
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
    <button onclick="cancelarReserva(${r.id}, '${escapeHtml(r.titulo)}')" title="Apagar reunião"
      class="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-slate-300 dark:text-slate-600 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
      </svg>
    </button>` : '';

  return `
    <div id="card-reserva-${r.id}" class="border-b border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-white/[0.02] transition-colors${r.statusDinamico === 'Cancelada' ? ' opacity-60' : ''} relative">
      <div class="flex items-center gap-2 px-3 py-2">

        <!-- Checkbox Admin -->
        ${isAdmin ? `<div class="flex-shrink-0 flex items-center justify-center w-6">
          <label class="relative flex items-center cursor-pointer">
            <input type="checkbox" value="${r.id}" onchange="atualizarBarraAcaoLote()" class="check-reserva peer sr-only" />
            <div class="w-4 h-4 border-2 border-slate-300 dark:border-slate-500 rounded bg-white dark:bg-[#0c1220] peer-checked:bg-blue-600 peer-checked:border-blue-600 transition-all flex items-center justify-center">
              <svg class="w-3 h-3 text-white opacity-0 peer-checked:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" /></svg>
            </div>
          </label>
        </div>` : ''}

        <!-- Horário -->
        <div class="flex-shrink-0 w-[68px]">
          <p class="text-[10px] text-slate-400 font-mono leading-none">${dataDDMMYYYY}</p>
          <p class="text-xs font-bold text-blue-600 dark:text-canaa-cyan leading-snug mt-0.5">${r.horaInicio || r.horainicio || '—'}<span class="text-slate-400 dark:text-slate-500 font-normal text-[10px]">→${r.horaFim || r.horafim || '—'}</span></p>
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

// ── CANCELAR REUNIÃO — somente o criador ────────────────────────────────────────

/**
 * Helper interno: injeta botões Sim/Não no modal ativo.
 * @param {string} textoBotao  - Label do botão de confirmação
 * @param {string} classeBotao - Classes Tailwind do botão de confirmação
 * @param {Function} onConfirmar - Callback ao clicar em Sim
 * @param {boolean} [comMotivo] - Se true, injeta textarea de motivo antes dos botões
 */
function _modalConfirmar(textoBotao, classeBotao, onConfirmar, comMotivo = false) {
  document.getElementById('adminConfirmarBtn')?.remove();
  document.getElementById('adminCancelarBtn')?.remove();
  document.getElementById('cancelMotivoPainel')?.remove();

  const barWrap   = document.getElementById('modalBarWrap');
  const modalCard = document.getElementById('modalCard');
  const inserir   = el => barWrap ? modalCard.insertBefore(el, barWrap) : modalCard.appendChild(el);

  let motivoPainel = null;
  if (comMotivo) {
    motivoPainel = document.createElement('div');
    motivoPainel.id = 'cancelMotivoPainel';
    motivoPainel.className = 'mt-3';
    motivoPainel.innerHTML = `
      <textarea id="cancelMotivoTexto" rows="2" maxlength="300" placeholder="Motivo do cancelamento (opcional)"
        class="w-full text-xs rounded-lg bg-white/5 border border-white/10 text-slate-300 placeholder-slate-500 px-3 py-2 resize-none focus:outline-none focus:border-orange-400 transition-colors"></textarea>
      <p class="text-[10px] text-slate-500 mt-0.5 text-right">Máx. 300 caracteres</p>
    `;
    inserir(motivoPainel);
  }

  const botoesDiv = document.createElement('div');
  botoesDiv.className = `flex gap-2 ${comMotivo ? 'mt-3' : 'mt-4'} justify-end`;

  const btnNao = document.createElement('button');
  btnNao.id = 'adminCancelarBtn';
  btnNao.textContent = 'Não';
  btnNao.className = 'px-4 py-1.5 text-xs font-bold rounded-lg bg-white/10 hover:bg-white/20 text-slate-300 transition-all';
  btnNao.onclick = () => { motivoPainel?.remove(); botoesDiv.remove(); fecharModal(); };

  const btnSim = document.createElement('button');
  btnSim.id = 'adminConfirmarBtn';
  btnSim.textContent = textoBotao;
  btnSim.className = classeBotao;
  btnSim.onclick = () => {
    const motivo = comMotivo ? (document.getElementById('cancelMotivoTexto')?.value.trim() || '') : null;
    motivoPainel?.remove();
    botoesDiv.remove();
    fecharModal();
    onConfirmar(motivo);
  };

  botoesDiv.appendChild(btnNao);
  botoesDiv.appendChild(btnSim);
  inserir(botoesDiv);
}

function solicitarCancelamento(id, titulo) {
  mostrarModal('aviso', `Cancelar a reunião "${titulo}"?`);
  _modalConfirmar(
    'Sim, cancelar',
    'px-4 py-1.5 text-xs font-bold rounded-lg bg-orange-500 hover:bg-orange-600 text-white transition-all',
    (motivo) => executarCancelamento(id, motivo),
    true
  );
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
      invalidarCacheLista(abaAtiva); // Invalida apenas a aba atual
      carregarDashboard();
      carregarLista(abaAtiva, true);
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
async function confirmarPresenca(reservaId) {
  const usuario = obterUsuario();
  try {
    const res = await fetch(`${URL_API}/reservas/${reservaId}/presenca`, {
      method: 'PATCH',
      headers: headersAuth()
    });
    if (checar401(res.status)) return;
    const dados = await res.json();

    // Atualiza o contador inline, sem recarregar a lista
    const count = document.getElementById(`rsvp-count-${reservaId}`);
    if (count) count.textContent = dados.confirmados;

    // Atualiza a lista de nomes inline
    if (usuario) {
      const nomesDiv = document.getElementById(`rsvp-nomes-${reservaId}`);

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

// ── 10. ANALYTICS ───────────────────────────────────────────────────────────────
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

// ── ADMIN — Apagar reunião individual ──────────────────────────────────────────
async function cancelarReserva(id, titulo) {
  mostrarModal('aviso', `Deseja apagar definitivamente a reunião "${titulo}"? Esta ação não pode ser desfeita.`);
  _modalConfirmar(
    'Sim, apagar',
    'px-4 py-1.5 text-xs font-bold rounded-lg bg-red-500 hover:bg-red-600 text-white transition-all',
    async () => {
      try {
        const res = await fetch(`${URL_API}/reservas/${id}`, { method: 'DELETE', headers: headersAuth() });
        if (checar401(res.status)) return;
        const dados = await res.json();
        document.getElementById(`card-reserva-${id}`)?.remove();
        mostrarModal('sucesso', dados.mensagem, true);
        carregarDashboard();
        carregarAnalytics();
      } catch { mostrarModal('erro', 'Erro ao apagar a reunião.'); }
    }
  );
}

// ── ADMIN — Apagar todas as reuniões concluídas ──────────────────────────────
async function apagarConcluidas() {
  mostrarModal('aviso', 'Deseja apagar todas as reuniões com status "Concluída"? Esta ação não pode ser desfeita.');
  _modalConfirmar(
    'Sim, apagar',
    'px-4 py-1.5 text-xs font-bold rounded-lg bg-red-500 hover:bg-red-600 text-white transition-all',
    async () => {
      try {
        const res = await fetch(`${URL_API}/historico/concluidas`, { method: 'DELETE', headers: headersAuth() });
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
    }
  );
}

// ------------------------------------------------------------
// AÇÕES EM LOTE (ADMIN)
// ------------------------------------------------------------

function inicializarAcoesLote() {
  const usuario = obterUsuario();
  const temChecks = document.querySelectorAll('.check-reserva').length > 0;

  // Próximos: usa containerCheckTodasProximos
  const containerProximos = document.getElementById('containerCheckTodasProximos');
  const checkProximos = document.getElementById('checkTodasProximos');
  if (containerProximos && checkProximos) {
    checkProximos.checked = false;
    if (usuario?.role === 'admin' && temChecks && abaAtiva === 'proximos') {
      containerProximos.classList.remove('hidden');
    } else {
      containerProximos.classList.add('hidden');
    }
  }

  // Histórico: usa containerCheckTodas
  const containerHistorico = document.getElementById('containerCheckTodas');
  const checkHistorico = document.getElementById('checkTodas');
  if (containerHistorico && checkHistorico) {
    checkHistorico.checked = false;
    if (usuario?.role === 'admin' && temChecks && abaAtiva === 'historico') {
      containerHistorico.classList.remove('hidden');
    } else {
      containerHistorico.classList.add('hidden');
    }
  }
}

function toggleSelecaoTodas(checkbox) {
  const checks = document.querySelectorAll('.check-reserva');
  checks.forEach(c => c.checked = checkbox.checked);
  atualizarBarraAcaoLote();
}

function atualizarBarraAcaoLote() {
  const selecionadas = document.querySelectorAll('.check-reserva:checked').length;
  const total = document.querySelectorAll('.check-reserva').length;
  const barra = document.getElementById('barraAcaoLote');
  const texto = document.getElementById('textoAcaoLote');

  // Sincroniza o estado do "selecionar todos" da aba ativa
  const idCheck = abaAtiva === 'historico' ? 'checkTodas' : 'checkTodasProximos';
  const checkEl = document.getElementById(idCheck);
  if (checkEl && total > 0) {
    checkEl.checked = (selecionadas === total);
  }

  if (selecionadas > 0) {
    texto.textContent = `${selecionadas} selecionada(s)`;
    barra.classList.remove('hidden');
    barra.classList.add('flex');
  } else {
    barra.classList.add('hidden');
    barra.classList.remove('flex');
  }
}

async function cancelarSelecionadas() {
  const selecionadas = Array.from(document.querySelectorAll('.check-reserva:checked')).map(c => parseInt(c.value));
  if (selecionadas.length === 0) return;
  mostrarModal('aviso', `Cancelar as ${selecionadas.length} reuniões selecionadas?`);
  _modalConfirmar(
    'Sim, cancelar',
    'px-4 py-1.5 text-xs font-bold rounded-lg bg-orange-500 hover:bg-orange-600 text-white transition-all',
    async (motivo) => {
      try {
        const res = await fetch(`${URL_API}/reservas/multiplas/cancelar`, {
          method: 'PATCH',
          headers: headersAuth(),
          body: JSON.stringify({ ids: selecionadas, motivo })
        });
        if (checar401(res.status)) return;
        const dados = await res.json();
        if (res.ok) {
          mostrarModal('sucesso', dados.mensagem, true);
          carregarDashboard();
          carregarLista(abaAtiva);
          carregarAnalytics();
        } else {
          mostrarModal('erro', dados.mensagem || 'Erro ao cancelar as reuniões.');
        }
      } catch (err) {
        console.error('Erro:', err);
        mostrarModal('erro', 'Erro ao conectar com o servidor.');
      }
    },
    true
  );
}

async function apagarSelecionadas() {
  const selecionadas = Array.from(document.querySelectorAll('.check-reserva:checked')).map(c => parseInt(c.value));
  if (selecionadas.length === 0) return;
  mostrarModal('aviso', `Deseja apagar definitivamente as ${selecionadas.length} reuniões selecionadas?`);
  _modalConfirmar(
    'Sim, apagar',
    'px-4 py-1.5 text-xs font-bold rounded-lg bg-red-500 hover:bg-red-600 text-white transition-all',
    async () => {
      try {
        const res = await fetch(`${URL_API}/reservas/multiplas`, {
          method: 'DELETE',
          headers: headersAuth(),
          body: JSON.stringify({ ids: selecionadas })
        });
        if (checar401(res.status)) return;
        const dados = await res.json();
        if (res.ok) {
          mostrarModal('sucesso', dados.mensagem, true);
          carregarDashboard();
          carregarLista(abaAtiva);
          carregarAnalytics();
        } else {
          mostrarModal('erro', dados.mensagem || 'Erro ao apagar as reuniões.');
        }
      } catch (err) {
        console.error('Erro:', err);
        mostrarModal('erro', 'Erro ao conectar com o servidor.');
      }
    }
  );
}

// ── ATUALIZAÇÃO EM TEMPO REAL — Server-Sent Events ─────────────────────────────
function iniciarSSE() {
  if (_sseConexao) { _sseConexao.close(); _sseConexao = null; }
  _sseConexao = new EventSource(`${URL_API.replace('/api', '')}/api/eventos`);
  _sseConexao.addEventListener('atualizacao', () => dispararAtualizacao({ incluirLista: true }));
  _sseConexao.onerror = () => console.warn('SSE: conexão perdida, aguardando reconexão...');
}

/** Invalida o cache de uma aba e força a próxima carga a renderizar de novo */
function invalidarCacheLista(aba) {
  if (aba) { _cacheJson[aba] = null; } else { _cacheJson.proximos = null; _cacheJson.historico = null; }
}

// ── FILTROS DO HISTÓRICO ────────────────────────────────────────────────────────

/** Aplica os filtros sobre os dados brutos do histórico e re-renderiza a lista */
function aplicarFiltrosHistorico() {
  if (abaAtiva !== 'historico') return;

  const dataInicio = document.getElementById('filtroDataInicio')?.value || '';
  const dataFim    = document.getElementById('filtroDataFim')?.value    || '';
  const status     = document.getElementById('filtroStatus')?.value     || '';
  const sala       = document.getElementById('filtroSala')?.value       || '';

  let filtrados = _dadosBrutosHistorico.slice();

  if (dataInicio) filtrados = filtrados.filter(r => r.data >= dataInicio);
  if (dataFim)    filtrados = filtrados.filter(r => r.data <= dataFim);
  if (status)     filtrados = filtrados.filter(r => r.statusDinamico === status);
  if (sala) {
    if (sala === 'online') {
      filtrados = filtrados.filter(r => r.modalidade === 'online');
    } else {
      filtrados = filtrados.filter(r => r.modalidade === 'presencial' && (r.sala || 'Sala de Reunião') === sala);
    }
  }

  const lista = document.getElementById('listaReservas');
  lista.innerHTML = filtrados.length === 0
    ? `<div class="text-center py-8 text-slate-400 text-sm">Nenhum resultado encontrado para os filtros aplicados.</div>`
    : filtrados.map(r => renderCartaoHistorico(r)).join('');

  // Exibe o botão "Limpar filtros" se houver filtro ativo
  const temFiltro = dataInicio || dataFim || status || sala;
  const btnLimpar = document.getElementById('btnLimparFiltros');
  if (btnLimpar) {
    btnLimpar.classList.toggle('hidden', !temFiltro);
    btnLimpar.classList.toggle('flex', !!temFiltro);
  }

  inicializarAcoesLote();
  atualizarBarraAcaoLote();
}

/** Limpa todos os filtros e restaura a lista completa */
function limparFiltrosHistorico() {
  const ids = ['filtroDataInicio', 'filtroDataFim', 'filtroStatus', 'filtroSala'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const btnLimpar = document.getElementById('btnLimparFiltros');
  if (btnLimpar) { btnLimpar.classList.add('hidden'); btnLimpar.classList.remove('flex'); }
  aplicarFiltrosHistorico();
}

/**
 * Expande/colapsa o painel de inputs de filtro do histórico.
 * Usa classe CSS 'filtros-aberto' para animação suave via max-height + opacity.
 */
function toggleFiltrosHistorico() {
  const corpo   = document.getElementById('filtrosCorpo');
  const chevron = document.getElementById('chevronFiltros');
  if (!corpo) return;

  const aberto = corpo.classList.contains('filtros-aberto');
  corpo.classList.toggle('filtros-aberto', !aberto);
  if (chevron) chevron.style.transform = aberto ? '' : 'rotate(90deg)';
}

// ── INICIALIZAÇÃO ──────────────────────────────────────────────────────────────
window.onload = () => {
  init();
  if (obterToken()) iniciarSSE();

  // Polling a cada 60s: só atualiza dashboard e analytics (status de sala pelo tempo)
  // A lista não muda sozinha com o tempo — só muda por ação no banco (SSE cuida disso)
  if (obterToken()) {
    setInterval(() => { dispararAtualizacao({ incluirLista: false }); }, 60 * 1000);
  }

  const usuario = obterUsuario();
  if (usuario?.role === 'admin') verificarStatusNotion();
};

// ── NOTION — Sincronização ──────────────────────────────────────────────────────

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

// ── ADMIN — Gerenciamento de Usuários ──────────────────────────────────────────

/** Abre/fecha o painel de usuários e carrega a lista se aberto */
function togglePainelUsuarios() {
  const painel = document.getElementById('painelUsuarios');
  painel.classList.toggle('hidden');
  if (!painel.classList.contains('hidden')) {
    carregarUsuariosAdmin();
  }
}

/** Busca todos os usuários do servidor e renderiza na lista de admin */
async function carregarUsuariosAdmin() {
  const lista = document.getElementById('listaUsuariosAdmin');
  try {
    const res = await fetch(`${URL_API}/admin/usuarios`, { headers: headersAuth() });
    if (checar401(res.status)) return;
    const usuarios = await res.json();

    if (usuarios.length === 0) {
      lista.innerHTML = '<p class="text-[10px] text-slate-500 italic text-center py-2">Nenhum usuário encontrado.</p>';
      return;
    }

    lista.innerHTML = usuarios.map(u => `
      <div class="group flex items-center justify-between p-2 rounded-lg bg-slate-50 dark:bg-white/5 border border-slate-100 dark:border-white/5 hover:border-blue-500/30 transition-all">
        <div class="min-w-0">
          <p class="text-[11px] font-bold text-slate-700 dark:text-slate-200 truncate">${escapeHtml(u.nome)}</p>
          <p class="text-[9px] text-slate-400 truncate">${escapeHtml(u.email)} • <span class="uppercase font-black text-blue-500/70">${u.role}</span></p>
        </div>
        <div class="flex items-center gap-1">
          <button onclick="editarUsuario(${JSON.stringify(u).replace(/"/g, '&quot;')})" title="Editar Usuário"
            class="p-1.5 text-slate-300 hover:text-blue-500 transition-colors">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
            </svg>
          </button>
          <button onclick="excluirUsuario(${u.id}, '${escapeHtml(u.nome)}')" title="Excluir Usuário"
            class="p-1.5 text-slate-300 hover:text-red-500 transition-colors">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Erro ao carregar usuários:', err);
    lista.innerHTML = '<p class="text-[10px] text-red-400 text-center py-2">Erro ao carregar lista de usuários.</p>';
  }
}

/** Valida e envia o formulário de novo usuário */
async function salvarNovoUsuario(e) {
  e.preventDefault();
  
  const id = document.getElementById('edit-usuario-id').value;
  const nome = document.getElementById('usuNome').value.trim();
  const email = document.getElementById('usuEmail').value.trim();
  const senha = document.getElementById('usuSenha').value;
  const role = document.getElementById('usuRole').value;

  if (!nome || !email || (!id && !senha)) {
    mostrarModal('erro', 'Preencha todos os campos corretamente.');
    return;
  }

  const isEdicao = !!id;
  const url = isEdicao ? `${URL_API}/admin/usuarios/${id}` : `${URL_API}/admin/usuarios`;
  const metodo = isEdicao ? 'PUT' : 'POST';

  try {
    const res = await fetch(url, {
      method: metodo,
      headers: headersAuth(),
      body: JSON.stringify({ nome, email, senha, role })
    });
    
    if (checar401(res.status)) return;
    const dados = await res.json();

    if (res.ok) {
      mostrarModal('sucesso', dados.mensagem, true);
      limparFormularioUsuarios();
      carregarUsuariosAdmin();
      if (typeof carregarUsuariosParticipantes === 'function') carregarUsuariosParticipantes();
    } else {
      mostrarModal('erro', dados.mensagem || 'Erro ao salvar usuário.');
    }
  } catch (err) {
    console.error('Erro ao salvar usuário:', err);
    mostrarModal('erro', 'Erro ao conectar com o servidor.');
  }
}

/** Prepara o formulário para edição */
function editarUsuario(u) {
  document.getElementById('edit-usuario-id').value = u.id;
  document.getElementById('usuNome').value = u.nome;
  document.getElementById('usuEmail').value = u.email;
  document.getElementById('usuSenha').value = ''; // Não mostra a senha atual
  document.getElementById('usuSenha').required = false; // Senha opcional na edição
  document.getElementById('usuRole').value = u.role;
  
  document.getElementById('titulo-form-usuario').textContent = 'Editar Usuário';
  document.getElementById('btnSalvarUsuario').textContent = 'Salvar Alterações';
  document.getElementById('formNovoUsuario').classList.remove('hidden');
}

function limparFormularioUsuarios() {
  document.getElementById('edit-usuario-id').value = '';
  document.getElementById('usuNome').value = '';
  document.getElementById('usuEmail').value = '';
  document.getElementById('usuSenha').value = '';
  document.getElementById('usuSenha').required = true;
  document.getElementById('usuRole').value = 'gestor';
  document.getElementById('titulo-form-usuario').textContent = 'Novo Usuário';
  document.getElementById('btnSalvarUsuario').textContent = 'Criar Usuário';
  document.getElementById('formNovoUsuario').classList.add('hidden');
}

function excluirUsuario(id, nome) {
  mostrarModal('aviso', `Deseja realmente excluir o usuário "${escapeHtml(nome)}"? Esta ação não pode ser desfeita.`);
  _modalConfirmar(
    'Sim, excluir',
    'px-4 py-1.5 text-xs font-bold rounded-lg bg-red-500 hover:bg-red-600 text-white transition-all',
    async () => {
      try {
        const res = await fetch(`${URL_API}/admin/usuarios/${id}`, { method: 'DELETE', headers: headersAuth() });
        if (checar401(res.status)) return;
        const dados = await res.json();
        if (res.ok) {
          mostrarModal('sucesso', dados.mensagem, true);
          carregarUsuariosAdmin();
          if (typeof carregarUsuariosParticipantes === 'function') carregarUsuariosParticipantes();
        } else {
          mostrarModal('erro', dados.mensagem || 'Erro ao excluir usuário.');
        }
      } catch (err) {
        console.error('Erro ao excluir usuário:', err);
        mostrarModal('erro', 'Erro ao conectar com o servidor.');
      }
    }
  );
}