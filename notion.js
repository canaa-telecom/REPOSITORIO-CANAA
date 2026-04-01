const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

// Avisa UMA VEZ na inicialização se o Notion não estiver configurado
const _notionAtivo = !!(process.env.NOTION_TOKEN && process.env.NOTION_DATABASE_ID);
if (!_notionAtivo) {
    console.warn('⚠️  Notion: NOTION_TOKEN ou NOTION_DATABASE_ID não configurado no .env. Integração desativada.');
}

/**
 * Verifica se a integração com o Notion está configurada.
 * Não emite warnings repetitivos — o aviso é emitido apenas na inicialização do módulo.
 */
function notionConfigurado() {
    return _notionAtivo;
}

/**
 * Mapeia o status interno para o nome EXATO da opção criada no Notion.
 *
 * As opções devem existir no banco "Calendário de Reuniões" com estes nomes:
 *   "Agendado" | "Realizada" | "Cancelado"
 */
const STATUS_MAP = {
    'Agendada':      'Agendado',   // Reunião futura ou não iniciada
    'Em andamento':  'Agendado',   // Mantém Agendado durante execução (sem opção própria)
    'Concluída':     'Realizada',  // Nome usado no banco da empresa
    'Cancelada':     'Cancelado',  // Nome usado no banco da empresa
};

/**
 * Retorna o offset do fuso horário local no formato ±HH:MM.
 * Ex.: Brasil UTC-3 → "-03:00"
 * Necessário para o Notion não interpretar os horários como UTC.
 */
function tzOffset() {
    const off = -new Date().getTimezoneOffset(); // minutos, positivo p/ UTC+
    const sign = off >= 0 ? '+' : '-';
    const abs = Math.abs(off);
    const hh = String(Math.floor(abs / 60)).padStart(2, '0');
    const mm = String(abs % 60).padStart(2, '0');
    return `${sign}${hh}:${mm}`;
}

/**
 * Propriedades do banco "Agendamento de Reuniões" (conta empresa).
 * Nomes e tipos obtidos via API (notion.js buscar_notion_db.js):
 *
 *   "Qual o objetivo da reunião?" → title    (campo título)
 *   "09/02/2026"                  → date     (data/hora da reunião, start→end)
 *   "Status"                      → status   (Agendado | Realizada | Cancelado)
 *   "Observações"                 → rich_text (pré-ata / notas)
 *   "Link da reunião:"            → rich_text (note o ":" no final do nome!)
 *   "Motivo do agendamento"        → rich_text (motivo / cancelamento)
 *
 * Campos IGNORADOS (não podem ser preenchidos via API):
 *   "Responsável" / "Participantes" → tipo people (requer UUID Notion)
 *   "Pauta da Reunião"            → tipo url (seria link externo p/ doc)
 *   "Ata da reunião"              → tipo files
 */
function montarPropriedades(reserva, participantes = [], statusDinamico = 'Agendada') {
    const statusNotion = STATUS_MAP[statusDinamico];

    // PostgreSQL retorna colunas em minúsculas — normaliza antes de usar
    const horaInicio = reserva.horainicio || reserva.horaInicio || '';
    const horaFim    = reserva.horafim    || reserva.horaFim    || '';

    // Monta texto de responsável + participantes para o campo Observações
    const linhas = [];
    if (reserva.gestor) linhas.push(`Responsável: ${reserva.gestor}`);
    if (participantes.length > 0) linhas.push(`Participantes: ${participantes.join(', ')}`);
    const observacoesTexto = linhas.join('\n');

    const props = {
        // 1. Título da reunião
        'Qual o objetivo da reunião?': {
            title: [{ text: { content: reserva.titulo || 'Sem título' } }]
        },

        // 2. Data/hora da reunião (campo tem nome "09/02/2026" no banco)
        '09/02/2026': {
            date: reserva.data ? {
                start: horaInicio
                    ? `${reserva.data}T${horaInicio}:00${tzOffset()}`
                    : reserva.data,
                end: horaFim
                    ? `${reserva.data}T${horaFim}:00${tzOffset()}`
                    : null
            } : null
        },

        // 3. Responsável (nome) + Participantes como texto em Observações
        'Observações': {
            rich_text: [{ text: { content: observacoesTexto } }]
        },

        // 4. Pré-ata / motivo da reunião
        'Motivo do agendamento': {
            rich_text: [{ text: { content: reserva.pre_ata || '' } }]
        },

        // 5. Link da reunião (nome inclui ":" no final — exato!)
        'Link da reunião:': {
            rich_text: [{ text: { content: reserva.link_reuniao || '' } }]
        },
    };

    // 6. Status
    if (statusNotion) {
        props['Status'] = { status: { name: statusNotion } };
    } else {
        console.warn(`⚠️  Notion: status desconhecido ignorado — "${statusDinamico}"`);
    }

    return props;
}


/**
 * Cria uma nova página no banco do Notion com todos os dados da reserva.
 *
 * @param {object}   reserva        - Objeto da reserva (com gestor, horaInicio, horaFim, etc.)
 * @param {string[]} participantes  - Nomes de quem confirmou presença
 * @param {string}   statusDinamico - 'Agendada' | 'Em andamento' | 'Concluída'
 * @returns {string|null}           - ID da página criada no Notion, ou null em caso de erro
 */
async function criarPaginaNotion(reserva, participantes = [], statusDinamico = 'Agendada') {
    if (!notionConfigurado()) return null;

    try {
        const pagina = await notion.pages.create({
            parent: { database_id: DATABASE_ID },
            properties: montarPropriedades(reserva, participantes, statusDinamico)
        });

        console.log(`✅ Notion: página criada — #${reserva.id} "${reserva.titulo}" [${statusDinamico}]`);
        return pagina.id;

    } catch (err) {
        console.error('❌ Notion: erro ao criar página:', err.message);
        return null;
    }
}

/**
 * Atualiza APENAS o status de uma página existente no Notion.
 * Chamado pelo timer periódico para refletir mudanças automáticas de status.
 *
 * @param {string} notionPageId  - ID da página no Notion
 * @param {string} statusDinamico - 'Agendada' | 'Em andamento' | 'Concluída'
 */
async function atualizarStatusNotion(notionPageId, statusDinamico) {
    if (!notionConfigurado() || !notionPageId) return false;

    const statusNotion = STATUS_MAP[statusDinamico];
    if (!statusNotion) {
        console.warn(`⚠️  Notion: status desconhecido ignorado — "${statusDinamico}"`);
        return false;
    }

    try {
        await notion.pages.update({
            page_id: notionPageId,
            properties: {
                'Status': { status: { name: statusNotion } }
            }
        });
        console.log(`🔄 Notion: status atualizado → página ${notionPageId} [${statusDinamico}]`);
        return true;
    } catch (err) {
        console.error('❌ Notion: erro ao atualizar status:', err.message);
        return false;
    }
}

/**
 * Atualiza os campos de uma página existente no Notion.
 * Útil para sincronizar status e confirmados após mudanças.
 *
 * @param {string}   notionPageId  - ID da página no Notion
 * @param {string[]} participantes - Nomes de quem confirmou presença
 * @param {string}   statusDinamico
 */
async function atualizarPaginaNotion(notionPageId, participantes = [], statusDinamico = 'Agendada') {
    if (!notionConfigurado() || !notionPageId) return;

    const statusNotion = STATUS_MAP[statusDinamico];

    try {
        await notion.pages.update({
            page_id: notionPageId,
            properties: {
                ...(statusNotion ? { 'Status': { status: { name: statusNotion } } } : {}),
            }
        });
        console.log(`✅ Notion: atualizada página ${notionPageId} → [${statusDinamico}]`);
    } catch (err) {
        console.error('❌ Notion: erro ao atualizar página:', err.message);
    }
}


/**
 * Cancela uma página no Notion: atualiza o Status para "Cancelada"
 * e preenche o campo "Motivo do Cancelamento".
 *
 * @param {string} notionPageId - ID da página no Notion
 * @param {string} motivo       - Motivo do cancelamento (pode ser vazio)
 */
async function cancelarPaginaNotion(notionPageId, motivo = '') {
    if (!notionConfigurado() || !notionPageId) return;

    const statusNotion = STATUS_MAP['Cancelada'];

    try {
        await notion.pages.update({
            page_id: notionPageId,
            properties: {
                ...(statusNotion ? { 'Status': { status: { name: statusNotion } } } : {}),
                // Registra o motivo do cancelamento em Observações
                'Observações': {
                    rich_text: [{ text: { content: motivo ? `Cancelada: ${motivo}` : 'Reunião cancelada.' } }]
                }
            }
        });
        console.log(`✅ Notion: reunião cancelada → página ${notionPageId} | motivo: "${motivo || 'sem motivo'}"`)
    } catch (err) {
        console.error('❌ Notion: erro ao cancelar página:', err.message);
    }
}

/**
 * Arquiva (exclui logicamente) uma página no Notion.
 */
async function arquivarPaginaNotion(notionPageId) {
    if (!notionConfigurado() || !notionPageId) return;

    try {
        await notion.pages.update({ page_id: notionPageId, archived: true });
        console.log(`🗑️  Notion: página ${notionPageId} arquivada.`);
    } catch (err) {
        console.error('❌ Notion: erro ao arquivar página:', err.message);
    }
}

/**
 * Sincroniza um lote de reservas para o Notion (POST /api/notion/sync).
 * Faz UPSERT: se a reserva já possui notion_page_id, atualiza a página existente;
 * caso contrário, cria uma nova página e retorna o ID para ser salvo no banco.
 *
 * @param {Array} reservas - Array com objetos de reserva (notion_page_id, gestor, participantesNomes, statusDinamico)
 * @returns {{ criadas: number, atualizadas: number, novasIds: Array<{id, notionPageId}> }}
 */
async function sincronizarTodasReservas(reservas) {
    if (!notionConfigurado()) return { criadas: 0, atualizadas: 0, novasIds: [] };

    let criadas = 0;
    let atualizadas = 0;
    const novasIds = [];

    for (const r of reservas) {
        const nomes = Array.isArray(r.participantesNomes)
            ? r.participantesNomes
            : (r.participantesNomes ? r.participantesNomes.split('||') : []);

        const status = r.statusDinamico || 'Agendada';

        if (r.notion_page_id) {
            // Página já existe no Notion — apenas atualiza
            await atualizarPaginaNotion(r.notion_page_id, nomes, status);
            atualizadas++;
        } else {
            // Ainda não tem página — cria uma nova
            const notionPageId = await criarPaginaNotion(r, nomes, status);
            if (notionPageId) {
                criadas++;
                novasIds.push({ id: r.id, notionPageId, status });
            }
        }
    }

    return { criadas, atualizadas, novasIds };
}

module.exports = {
    criarPaginaNotion,
    atualizarStatusNotion,
    atualizarPaginaNotion,
    cancelarPaginaNotion,
    arquivarPaginaNotion,
    sincronizarTodasReservas,
    notionConfigurado
};
