// Lightweight no-op email helper for local/dev environments.
// Avoids importing external providers during local tests.

export const templates = {
  procurementSubmitted: (request, recipient) => ({
    subject: `Procurement Submitted — ${request.referenceNo}`,
    html: `<p>Dear ${recipient.name},</p><p>A procurement request ${request.referenceNo} has been submitted.</p>`,
  }),
  procurementDecision: (request, decision, comment) => ({
    subject: `Procurement ${decision} — ${request.referenceNo}`,
    html: `<p>Your procurement request ${request.referenceNo} has been ${decision.toLowerCase()}.</p><p>${comment || ''}</p>`,
  }),
}

export async function sendEmail({ to, subject, html }) {
  console.log('sendEmail stub called', { to, subject })
  return { ok: true }
}
