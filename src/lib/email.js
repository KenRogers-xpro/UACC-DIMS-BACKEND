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
  welcome: (user, tempPassword) => ({
    subject: 'Welcome to UACC DIMS',
    html: `<p>Dear ${escapeHtml(user.name)},</p>
           <p>An account has been created for you on the UACC Digital Information and Management System.</p>
           <p>Email: ${escapeHtml(user.email)}<br/>Temporary password: ${escapeHtml(tempPassword)}</p>
           <p>Please sign in and change your password at your earliest convenience.</p>`,
  }),
  passwordReset: (user, tempPassword) => ({
    subject: 'UACC DIMS — Your password has been reset',
    html: `<p>Dear ${escapeHtml(user.name)},</p>
           <p>Your password was reset by an IT Administrator.</p>
           <p>New temporary password: ${escapeHtml(tempPassword)}</p>
           <p>Please sign in and change it as soon as possible.</p>`,
  }),
}

// NOTE: sendEmail() below is a no-op stub (logs and returns ok:true, never
// actually delivers anything) — that was already true before this change,
// not something introduced here. These two wrappers exist for
// users.routes.js to call, matching the directive's naming, but until
// sendEmail() is wired to a real provider (RESEND_API_KEY is present in
// .env but unused — untested whether it's even valid, given this session's
// track record with third-party credentials), no email actually reaches
// anyone. The temp password still gets logged server-side by the stub, so
// it's recoverable from logs during development, but this is not a
// substitute for real delivery.
export async function sendWelcomeEmail(user, tempPassword) {
  const { subject, html } = templates.welcome(user, tempPassword)
  return sendEmail({ to: user.email, subject, html })
}

export async function sendPasswordResetEmail(user, tempPassword) {
  const { subject, html } = templates.passwordReset(user, tempPassword)
  return sendEmail({ to: user.email, subject, html })
}

export async function sendEmail({ to, subject, html }) {
  console.log('sendEmail stub called (no real delivery configured):', { to, subject, html })
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
