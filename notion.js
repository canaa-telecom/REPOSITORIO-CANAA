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
 * Colunas do banco Notion:
 *   Titulo       → Title
 *   Data         → Date (intervalo: horaInicio → horaFim)
 *   Status       → Status nativo do Notion
 *   Pauta        → Rich Text
 *   Responsável  → Rich Text
 *   Confirmados  → Rich Text
 */
function montarPropriedades(reserva, participantes = [], statusDinamico = 'Agendada') {
    const nomesTexto = participantes.length > 0 ? participantes.join(', ') : '';

    // Mapeia o status do sistema para os nomes REAIS das opções criadas no Notion
    const statusMap = {
        'Agendada': 'Agendada',
        'Em andamento': 'Em andamento',
        'Concluída': 'Concluído',
    };
    const statusNotion = statusMap[statusDinamico];

    const props = {
        // 1. Título da reunião
        'Titulo': {
            title: [{ text: { content: reserva.titulo || 'Sem título' } }]
        },

        // 2. Data com hora de início e hora de fim 
        'Data': {
            date: reserva.data ? {
                start: reserva.horaInicio
                    ? `${reserva.data}T${reserva.horaInicio}:00`
                    : reserva.data,
                end: reserva.horaFim
                    ? `${reserva.data}T${reserva.horaFim}:00`
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

    // 3. Status — só inclui se o nome existir no Notion (evita erro de opção inválida)
    if (statusNotion) {
        props['Status'] = { status: { name: statusNotion } };
    }

    return props;
}

/**
 * Cria uma nova página no banco do Notion com todos os dados da reserva.
 *
 * @param {object}   reserva       - Objeto da reserva (com gestor, horaInicio, horaFim, etc.)
 * @param {string[]} participantes - Nomes de quem confirmou presença
 * @param {string}   statusDinamico - 'Agendada' | 'Em andamento' | 'Concluída'
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
    const statusMap = {
        'Agendada': 'Agendada',
        'Em andamento': 'Em andamento',
        'Concluída': 'Concluído',   // Notion usa "Concluído"
    };
    const statusNotion = statusMap[statusDinamico];

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
 *
 * @param {Array} reservas - Array com objetos de reserva (incluindo gestor e participantesNomes)
 */
async function sincronizarTodasReservas(reservas) {
    if (!notionConfigurado()) return 0;

    let criadas = 0;
    for (const r of reservas) {
        const nomes = Array.isArray(r.participantesNomes)
            ? r.participantesNomes
            : (r.participantesNomes ? r.participantesNomes.split('||') : []);

        const status = r.statusDinamico || 'Agendada';
        const id = await criarPaginaNotion(r, nomes, status);
        if (id) criadas++;
    }
    return criadas;
}

module.exports = {
    criarPaginaNotion,
    atualizarPaginaNotion,
    atualizarConfirmadosNotion,
    arquivarPaginaNotion,
    sincronizarTodasReservas,
    notionConfigurado
};
