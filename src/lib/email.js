// Lightweight no-op email helper for local/dev environments.
// Avoids importing external providers during local tests.

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export const templates = {
  procurementSubmitted: (request, recipient) => ({
    subject: `Procurement Submitted — ${request.referenceNo}`,
    html: `<p>Dear ${recipient.name},</p><p>A procurement request ${request.referenceNo} has been submitted.</p>`,
  }),
  procurementDecision: (request, decision, comment) => ({
    subject: `Procurement ${decision} — ${request.referenceNo}`,
    html: `<p>Your procurement request ${request.referenceNo} has been ${decision.toLowerCase()}.</p><p>${comment || ''}</p>`,
  }),
  procurementOfficerVerified: (request, recipient) => ({
    subject: `Procurement Verified — ${request.referenceNo}`,
    html: `<p>Dear ${recipient.name},</p><p>Procurement request ${request.referenceNo} has been verified by the Procurement Officer and is awaiting your final approval.</p>`,
  }),
}

export async function sendEmail({ to, subject, html }) {
  console.log('sendEmail stub called', { to, subject })
  return { ok: true }
}

export async function sendGMCommunication({ to, subject, bodyHtml, sentByPA = true, paName = 'PA' }) {
  const attributionLine = sentByPA
    ? `<p style="margin-top:16px;padding-top:12px;border-top:1px solid #d1d5db;color:#374151;font-size:0.95rem;">Sent on behalf of the General Manager by ${escapeHtml(paName)}</p>`
    : ''

  return sendEmail({
    to,
    subject,
    html: `${bodyHtml}${attributionLine}`,
  })
}
