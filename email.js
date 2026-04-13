// ── email.js ─────────────────────────────────────────────────
// Módulo de envio de e-mails via SMTP (Nodemailer / Locaweb)
// ─────────────────────────────────────────────────────────────
const nodemailer = require('nodemailer');


// ── Transporte SMTP ─────────────────────────────────────────
let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    console.warn('⚠️  E-mail: SMTP não configurado. Defina SMTP_HOST, SMTP_USER e SMTP_PASS no .env');
    return null;
  }

  transporter = nodemailer.createTransport({
    host,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user, pass },
    tls: { rejectUnauthorized: false }
  });

  return transporter;
}

// ── Template HTML de convite ─────────────────────────────────

/** Sanitiza strings para uso seguro dentro de HTML (previne HTML injection nos e-mails) */
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Gera URLs para adicionar o evento ao Google Calendar e Outlook Web.
 */
function gerarLinksCalendario({ tituloReuniao, data, horaInicio, horaFim, nomeOrganizador, sala, modalidade, linkReuniao }) {
  if (!data || !horaInicio || !horaFim) return null;

  // Formata datas para o padrão YYYYMMDDTHHMMSS (sem timezone — horário local)
  const [ano, mes, dia] = data.split('-');
  const [hIni, mIni] = horaInicio.split(':');
  const [hFim, mFim] = horaFim.split(':');

  const dtInicio = `${ano}${mes}${dia}T${hIni}${mIni}00`;
  const dtFim    = `${ano}${mes}${dia}T${hFim}${mFim}00`;

  const local = modalidade === 'presencial' ? (sala || 'Sala de Reunião') : (linkReuniao || 'Online');
  const descricao = `Reunião organizada por ${nomeOrganizador}. Local: ${local}`;

  const params = new URLSearchParams({
    action : 'TEMPLATE',
    text   : tituloReuniao,
    dates  : `${dtInicio}/${dtFim}`,
    details: descricao,
    location: local
  });
  const googleUrl = `https://calendar.google.com/calendar/render?${params.toString()}`;

  const outlookParams = new URLSearchParams({
    subject  : tituloReuniao,
    startdt  : `${ano}-${mes}-${dia}T${hIni}:${mIni}:00`,
    enddt    : `${ano}-${mes}-${dia}T${hFim}:${mFim}:00`,
    body     : descricao,
    location : local
  });
  const outlookUrl = `https://outlook.live.com/calendar/0/deeplink/compose?${outlookParams.toString()}`;

  return { googleUrl, outlookUrl };
}

function templateConvite({ nomeParticipante, tituloReuniao, data, horaInicio, horaFim, modalidade, linkReuniao, nomeOrganizador, preAta, sala, tokenRecuso, baseUrl }) {
  const dataFormatada = (() => {
    if (!data) return '—';
    const [ano, mes, dia] = data.split('-');
    const dias = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
    const meses = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
    const d = new Date(`${ano}-${mes}-${dia}T12:00:00`);
    return `${dias[d.getDay()]}, ${parseInt(dia)} de ${meses[parseInt(mes) - 1]} de ${ano}`;
  })();

  const isOnline = modalidade === 'online';
  const modalidadeLabel = isOnline ? '🌐 Online' : '🏢 Presencial';
  const corPrincipal = '#1d4ed8';
  const corAcento = '#06b6d4';
  const nomeSala = !isOnline ? (sala || 'Sala de Reunião') : null;

  const linkBtn = isOnline && linkReuniao ? `
    <tr>
      <td align="center" style="padding: 8px 0 24px;">
        <a href="${escHtml(linkReuniao)}"
          style="display:inline-block; background: linear-gradient(135deg, #7c3aed, #06b6d4);
                 color: #ffffff; text-decoration: none; font-weight: 700; font-size: 13px;
                 padding: 12px 28px; border-radius: 8px; letter-spacing: 0.05em;">
          🎥 Entrar na Reunião Online
        </a>
      </td>
    </tr>` : '';

  // Links de calendário
  const calLinks = gerarLinksCalendario({ tituloReuniao, data, horaInicio, horaFim, nomeOrganizador, sala: nomeSala, modalidade, linkReuniao });
  const calendarBlock = calLinks ? `
    <tr>
      <td align="center" style="padding: 8px 32px 20px;">
        <p style="margin: 0 0 10px; font-size: 10px; font-weight: 700; text-transform: uppercase;
                   letter-spacing: 0.12em; color: #64748b;">📅 Adicionar à Agenda</p>
        <table cellpadding="0" cellspacing="0" style="margin: 0 auto;">
          <tr>
            <td style="padding-right: 8px;">
              <a href="${escHtml(calLinks.googleUrl)}" target="_blank"
                style="display:inline-block; background: #ffffff; border: 1px solid #e2e8f0;
                       color: #1d4ed8; text-decoration: none; font-weight: 700; font-size: 11px;
                       padding: 8px 16px; border-radius: 8px; letter-spacing: 0.03em;">
                🗓 Google Agenda
              </a>
            </td>
            <td>
              <a href="${escHtml(calLinks.outlookUrl)}" target="_blank"
                style="display:inline-block; background: #ffffff; border: 1px solid #e2e8f0;
                       color: #0078d4; text-decoration: none; font-weight: 700; font-size: 11px;
                       padding: 8px 16px; border-radius: 8px; letter-spacing: 0.03em;">
                📆 Outlook
              </a>
            </td>
          </tr>
        </table>
      </td>
    </tr>` : '';

  const recusoBlock = tokenRecuso && baseUrl ? `
    <tr>
      <td align="center" style="padding: 0 32px 24px;">
        <p style="margin: 0 0 10px; font-size: 10px; font-weight: 700; text-transform: uppercase;
                   letter-spacing: 0.12em; color: #64748b;">Não poderá participar?</p>
        <a href="${baseUrl}/api/presenca/recusar?token=${tokenRecuso}"
          style="display:inline-block; background: #ffffff; border: 1px solid #fecaca;
                 color: #dc2626; text-decoration: none; font-weight: 600; font-size: 11px;
                 padding: 8px 20px; border-radius: 8px; letter-spacing: 0.02em;">
          🚫 Recusar Presença
        </a>
      </td>
    </tr>` : '';

  const pautaBlock = preAta ? `
    <tr>
      <td style="padding: 0 32px 20px;">
        <div style="background: #f8fafc; border-left: 3px solid ${corAcento}; border-radius: 6px; padding: 12px 16px;">
          <p style="margin: 0 0 6px; font-size: 10px; font-weight: 700; text-transform: uppercase;
                     letter-spacing: 0.12em; color: #64748b;">Pauta / Pré-Ata</p>
          <p style="margin: 0; font-size: 13px; color: #334155; line-height: 1.6; white-space: pre-wrap;">${escHtml(preAta)}</p>
        </div>
      </td>
    </tr>` : '';

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Convite de Reunião — Canaã Telecom</title>
</head>
<body style="margin:0; padding:0; background:#f1f5f9; font-family: 'Segoe UI', Arial, sans-serif;">

  <!-- Wrapper -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9; padding: 32px 16px;">
    <tr>
      <td align="center">

        <!-- Card principal -->
        <table width="560" cellpadding="0" cellspacing="0"
          style="max-width:560px; width:100%; background:#ffffff; border-radius:16px;
                 box-shadow: 0 4px 24px rgba(0,0,0,0.08); overflow:hidden;">

          <!-- Header com gradiente -->
          <tr>
            <td style="background: linear-gradient(135deg, #080e1f 0%, #0f1c3f 60%, #1d4ed8 100%); padding: 0;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding: 28px 32px 20px;">
                    <!-- Logo + nome -->
                    <table cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding-right: 10px;">
                          <div style="width:36px; height:36px; background: linear-gradient(135deg, #1d4ed8, #06b6d4);
                                      border-radius: 8px; display:flex; align-items:center; justify-content:center;">
                            <span style="color:#fff; font-size:18px; font-weight:900; line-height:36px; display:block; text-align:center;">C</span>
                          </div>
                        </td>
                        <td>
                          <p style="margin:0; font-size:13px; font-weight:800; color:#ffffff;
                                     letter-spacing:0.12em; text-transform:uppercase; line-height:1.2;">Canaã Telecom</p>
                          <p style="margin:0; font-size:10px; color:rgba(255,255,255,0.5); letter-spacing:0.08em;">Central de Reservas</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 0 32px 28px;">
                    <!-- Badge -->
                    <div style="display:inline-block; background:rgba(6,182,212,0.15); border:1px solid rgba(6,182,212,0.3);
                                border-radius:20px; padding:4px 12px; margin-bottom:12px;">
                      <span style="font-size:10px; font-weight:700; color:#06b6d4; letter-spacing:0.1em; text-transform:uppercase;">
                        📅 Convite de Reunião
                      </span>
                    </div>
                    <h1 style="margin:0; font-size:22px; font-weight:800; color:#ffffff; line-height:1.3;">
                      ${escHtml(tituloReuniao)}
                    </h1>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Saudação -->
          <tr>
            <td style="padding: 28px 32px 4px;">
              <p style="margin:0; font-size:15px; color:#1e293b; line-height:1.6;">
                Olá, <strong style="color:${corPrincipal};">${escHtml(nomeParticipante)}</strong>! 👋
              </p>
              <p style="margin:8px 0 0; font-size:14px; color:#475569; line-height:1.6;">
                <strong>${escHtml(nomeOrganizador)}</strong> agendou uma reunião e solicitou a sua presença.
              </p>
            </td>
          </tr>

          <!-- Detalhes da reunião -->
          <tr>
            <td style="padding: 20px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0"
                style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; overflow:hidden;">

                <!-- Linha: Data -->
                <tr>
                  <td style="padding:14px 18px; border-bottom:1px solid #e2e8f0;">
                    <table cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="width:32px; vertical-align:middle;">
                          <span style="font-size:18px;">📆</span>
                        </td>
                        <td style="vertical-align:middle; padding-left:8px;">
                          <p style="margin:0; font-size:10px; font-weight:700; text-transform:uppercase;
                                     letter-spacing:0.1em; color:#94a3b8;">Data</p>
                          <p style="margin:2px 0 0; font-size:14px; font-weight:600; color:#1e293b;">${dataFormatada}</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Linha: Horário -->
                <tr>
                  <td style="padding:14px 18px; border-bottom:1px solid #e2e8f0;">
                    <table cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="width:32px; vertical-align:middle;">
                          <span style="font-size:18px;">🕐</span>
                        </td>
                        <td style="vertical-align:middle; padding-left:8px;">
                          <p style="margin:0; font-size:10px; font-weight:700; text-transform:uppercase;
                                     letter-spacing:0.1em; color:#94a3b8;">Horário</p>
                          <p style="margin:2px 0 0; font-size:14px; font-weight:600; color:#1e293b;">
                            ${horaInicio} <span style="color:#94a3b8; font-weight:400;">até</span> ${horaFim}
                          </p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Linha: Modalidade / Local -->
                <tr>
                  <td style="padding:14px 18px;">
                    <table cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="width:32px; vertical-align:middle;">
                          <span style="font-size:18px;">${isOnline ? '💻' : '📍'}</span>
                        </td>
                        <td style="vertical-align:middle; padding-left:8px;">
                          <p style="margin:0; font-size:10px; font-weight:700; text-transform:uppercase;
                                     letter-spacing:0.1em; color:#94a3b8;">Modalidade</p>
                          <p style="margin:2px 0 0; font-size:14px; font-weight:600; color:${isOnline ? '#7c3aed' : '#1d4ed8'};">
                            ${modalidadeLabel}${nomeSala ? ` — ${escHtml(nomeSala)}` : ''}
                          </p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

              </table>
            </td>
          </tr>

          <!-- Botão entrar (só online) -->
          ${linkBtn}

          <!-- Botões de calendário -->
          ${calendarBlock}

          <!-- Botão Recusar -->
          ${recusoBlock}

          <!-- Pauta / Pré-Ata -->
          ${pautaBlock}

          <!-- Divider -->
          <tr>
            <td style="padding: 0 32px;">
              <div style="height:1px; background:#e2e8f0;"></div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 20px 32px 28px;">
              <p style="margin:0; font-size:12px; color:#94a3b8; line-height:1.6;">
                Este é um aviso automático do sistema de reservas da Canaã Telecom.<br>
                Não responda este e-mail.
              </p>
            </td>
          </tr>

          <!-- Barra inferior colorida -->
          <tr>
            <td style="height:5px; background: linear-gradient(90deg, #1d4ed8, #06b6d4, #7c3aed); border-radius:0 0 16px 16px;"></td>
          </tr>

        </table>

        <!-- Rodapé externo -->
        <p style="margin:16px 0 0; font-size:11px; color:#94a3b8;">
          © 2026 Canaã Telecom — Sistema de Reserva de Sala
        </p>

      </td>
    </tr>
  </table>

</body>
</html>`;
}

// ── Função pública: Enviar e-mail de convite ─────────────────

/**
 * Envia e-mail de convite para um participante de reunião.
 * @param {object} params
 * @param {string} params.emailDestinatario - E-mail do participante
 * @param {string} params.nomeParticipante  - Nome do participante
 * @param {string} params.tituloReuniao     - Título da reunião
 * @param {string} params.data              - Data no formato YYYY-MM-DD
 * @param {string} params.horaInicio        - Hora de início HH:MM
 * @param {string} params.horaFim           - Hora de fim HH:MM
 * @param {string} params.modalidade        - 'presencial' | 'online'
 * @param {string} [params.linkReuniao]     - Link da reunião (opcional, para online)
 * @param {string} params.nomeOrganizador   - Nome do criador da reunião
 * @param {string} [params.preAta]          - Pré-ata / pauta (opcional)
 * @param {string} [params.sala]            - Nome da sala (opcional, para presencial)
 * @returns {Promise<boolean>} true se enviado com sucesso
 */
async function enviarConviteReuniao(params) {
  const t = getTransporter();
  if (!t) return false;

  const html = templateConvite(params);

  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || '"Canaã Telecom" <noreply@canaatelecom.com.br>',
      to: params.emailDestinatario,
      subject: `📅 Você foi convidado: ${params.tituloReuniao}`,
      html
    });
    console.log(`📧 E-mail enviado para ${params.emailDestinatario} — "${params.tituloReuniao}"`);
    return true;
  } catch (err) {
    console.error(`❌ Falha ao enviar e-mail para ${params.emailDestinatario}:`, err.message);
    return false;
  }
}

/**
 * Envia notificação ao organizador informando que um participante recusou o convite.
 */
async function enviarNotificacaoRecuso({ emailOrganizador, nomeOrganizador, nomeParticipante, tituloReuniao, data }) {
  const t = getTransporter();
  if (!t) return false;

  const dataFormatada = (() => {
    if (!data) return '—';
    const [ano, mes, dia] = data.split('-');
    return `${dia}/${mes}/${ano}`;
  })();

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Recusa de Convite</title>
</head>
<body style="margin:0; padding:0; background:#f8fafc; font-family: sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="500" style="background:#ffffff; border-radius:12px; box-shadow:0 10px 15px -3px rgba(0,0,0,0.1); overflow:hidden;">
          <tr>
            <td style="background:#ef4444; padding:20px; text-align:center;">
              <h2 style="margin:0; color:#ffffff; font-size:18px;">🚫 Convite Recusado</h2>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <p style="margin:0; font-size:15px; color:#334155; line-height:1.6;">
                Olá, <strong>${escHtml(nomeOrganizador)}</strong>,
              </p>
              <p style="margin:16px 0 0; font-size:14px; color:#475569; line-height:1.6;">
                O participante <strong>${escHtml(nomeParticipante)}</strong> informou que <strong>não poderá comparecer</strong> à reunião abaixo:
              </p>
              <div style="margin-top:24px; padding:16px; background:#f1f5f9; border-radius:8px;">
                <p style="margin:0; font-size:13px; font-weight:700; color:#1e293b;">${escHtml(tituloReuniao)}</p>
                <p style="margin:4px 0 0; font-size:12px; color:#64748b;">Data: ${dataFormatada}</p>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 32px; text-align:center;">
              <p style="margin:0; font-size:11px; color:#94a3b8;">
                Este é um aviso automático do Sistema de Reservas Canaã Telecom.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || '"Canaã Telecom" <noreply@canaatelecom.com.br>',
      to: emailOrganizador,
      subject: `🚫 Recusa de Convite: ${tituloReuniao}`,
      html
    });
    console.log(`📧 Notificação de recusa enviada para ${emailOrganizador} (Organizador)`);
    return true;
  } catch (err) {
    console.error(`❌ Falha ao enviar notificação de recusa para ${emailOrganizador}:`, err.message);
    return false;
  }
}

module.exports = { enviarConviteReuniao, enviarNotificacaoRecuso };
