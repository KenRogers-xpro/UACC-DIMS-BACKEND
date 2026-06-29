import Resend from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)

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
  return resend.emails.send({
    from: 'no-reply@uacc-dims.example',
    to,
    subject,
    html,
  })
}
