const nodemailer = require("nodemailer");
const config = require("../config");

let transport = null;
function getTransport() {
  if (!config.smtp.host) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return transport;
}

/** Sends an email; when SMTP is not configured the message is printed to the log instead. */
async function sendMail({ to, subject, text, html }) {
  const t = getTransport();
  if (!t) {
    console.log(`\n[mail] SMTP not configured — email to ${to}\nSubject: ${subject}\n${text}\n`);
    return { logged: true };
  }
  return t.sendMail({ from: config.smtp.from, to, subject, text, html });
}

module.exports = { sendMail };
