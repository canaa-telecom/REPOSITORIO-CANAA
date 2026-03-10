const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

/**
 * Verifica se a integração com o Notion está configurada.
 */
function notionConfigurado() {
    if (!process.env.NOTION_TOKEN || !process.env.NOTION_DATABASE_ID) {
        console.warn('⚠️  Notion: NOTION_TOKEN ou NOTION_DATABASE_ID não configurado no .env.');
        return false;
    }
    return true;
}

/**
 * Mapeia o status interno para o nome EXATO da opção criada no Notion.
 *
 * As opções devem existir no banco Notion com estes nomes exatos:
 *   "Agendada" | "Em andamento" | "Concluído"
 */
const STATUS_MAP = {
    'Agendada': 'Agendada',
    'Em andamento': 'Em andamento',
    'Concluída': 'Concluído',   // Notion usa "Concluído" (masculino)
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
 * Colunas do banco Notion esperadas:
 *   Titulo       → Title
 *   Data         → Date (intervalo: horaInicio → horaFim)
 *   Status       → Status nativo do Notion
 *   Pauta        → Rich Text
 *   Responsável  → Rich Text
 *   Confirmados  → Rich Text
 */
function montarPropriedades(reserva, participantes = [], statusDinamico = 'Agendada') {
    const nomesTexto = participantes.length > 0 ? participantes.join(', ') : '';
    const statusNotion = STATUS_MAP[statusDinamico];

    const props = {
        // 1. Título da reunião
        'Titulo': {
            title: [{ text: { content: reserva.titulo || 'Sem título' } }]
        },

        // 2. Data com hora de início e hora de fim (com fuso horário local)
        'Data': {
            date: reserva.data ? {
                start: reserva.horaInicio
                    ? `${reserva.data}T${reserva.horaInicio}:00${tzOffset()}`
                    : reserva.data,
                end: reserva.horaFim
                    ? `${reserva.data}T${reserva.horaFim}:00${tzOffset()}`
                    : null
            } : null
        },

        // 4. Pauta / Pré-Ata
        'Pauta': {
            rich_text: [{ text: { content: reserva.pre_ata || '' } }]
        },

        // 5. Responsável (quem criou o agendamento)
        'Responsável': {
            rich_text: [{ text: { content: reserva.gestor || '' } }]
        },

        // 6. Confirmados (nomes de quem confirmou presença)
        'Confirmados': {
            rich_text: [{ text: { content: nomesTexto } }]
        }
    };

    // 3. Status — só inclui se o mapeamento existir (evita erro de opção inválida)
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

    const nomesTexto = participantes.length > 0 ? participantes.join(', ') : '';
    const statusNotion = STATUS_MAP[statusDinamico];

    try {
        await notion.pages.update({
            page_id: notionPageId,
            properties: {
                ...(statusNotion ? { 'Status': { status: { name: statusNotion } } } : {}),
                'Confirmados': { rich_text: [{ text: { content: nomesTexto } }] }
            }
        });
        console.log(`✅ Notion: atualizada página ${notionPageId} → [${statusDinamico}] | ${nomesTexto || 'sem confirmados'}`);
    } catch (err) {
        console.error('❌ Notion: erro ao atualizar página:', err.message);
    }
}

// Mantém alias para compatibilidade com chamadas existentes no server.js
const atualizarConfirmadosNotion = atualizarPaginaNotion;

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
    atualizarConfirmadosNotion,
    arquivarPaginaNotion,
    sincronizarTodasReservas,
    notionConfigurado
};
