// Vercel Edge Middleware for the dev deployment.
// 1. Password-only gate (SITE_PASSWORD env var).
// 2. /go/whatsapp redirects to WhatsApp using WHATSAPP_NUMBER env var.
// 3. POST /api/contact forwards the form to FormSubmit using CONTACT_EMAIL env var.
// No phone number or email address lives in this repo.
export const config = { matcher: '/(.*)' };

const COOKIE = 'tp_auth';
const LOGIN_PATH = '/__login';

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function loginPage(showError) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Thumbsprint · Private preview</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0b;color:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  form{width:min(360px,90vw);padding:32px;border:1px solid #27272a;border-radius:16px;background:#121214}
  h1{font-size:18px;margin:0 0 6px}
  p{margin:0 0 20px;color:#a1a1aa;font-size:14px}
  input{width:100%;box-sizing:border-box;padding:12px 14px;border-radius:10px;border:1px solid #3f3f46;background:#09090b;color:#fff;font-size:16px}
  input:focus{outline:none;border-color:#f5f5f5}
  button{margin-top:14px;width:100%;padding:12px;border:0;border-radius:10px;background:#f5f5f5;color:#0a0a0b;font-weight:600;font-size:15px;cursor:pointer}
  .err{color:#f87171;font-size:13px;margin:10px 0 0}
</style></head><body>
<form method="post" action="${LOGIN_PATH}">
  <h1>Private preview</h1>
  <p>Enter the password to view this site.</p>
  <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password" required>
  ${showError ? '<p class="err">Wrong password, try again.</p>' : ''}
  <button type="submit">Continue</button>
</form>
</body></html>`;
}

function htmlResponse(body, status) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// Routes that use private contact details from env vars.
async function handleContactRoutes(request, url) {
  if (url.pathname === '/go/whatsapp') {
    const number = (process.env.WHATSAPP_NUMBER || '').replace(/\D/g, '');
    if (!number) return new Response('WhatsApp is not configured. Set WHATSAPP_NUMBER in Vercel.', { status: 503 });
    const text = encodeURIComponent("Hi Thumbsprint, I'd like a free thumbnail redesign. My channel: ");
    return Response.redirect(`https://wa.me/${number}?text=${text}`, 302);
  }

  if (url.pathname === '/api/contact' && request.method === 'POST') {
    const email = process.env.CONTACT_EMAIL;
    if (!email) return json({ ok: false, error: 'Contact form is not configured. Set CONTACT_EMAIL in Vercel.' }, 503);
    let body;
    try { body = await request.json(); } catch { return json({ ok: false, error: 'Bad request' }, 400); }
    const clean = (v) => String(v || '').slice(0, 2000);
    if (!clean(body.name) || !clean(body.channel)) return json({ ok: false, error: 'Name and channel are required' }, 400);
    const payload = {
      name: clean(body.name),
      channel: clean(body.channel),
      plan: clean(body.plan),
      message: clean(body.message),
      _subject: 'Thumbsprint request: ' + clean(body.plan),
      _template: 'table',
      _captcha: 'false',
    };
    try {
      const r = await fetch(`https://formsubmit.co/ajax/${email}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || String(data.success) === 'false') return json({ ok: false, error: data.message || 'send failed' }, 502);
      return json({ ok: true });
    } catch {
      return json({ ok: false, error: 'send failed' }, 502);
    }
  }
  return null;
}

export default async function middleware(request) {
  const pass = process.env.SITE_PASSWORD || process.env.BASIC_AUTH_PASSWORD;
  if (!pass) {
    return new Response(
      'Password protection is not configured. Set SITE_PASSWORD in Vercel project settings, then redeploy.',
      { status: 503, headers: { 'Content-Type': 'text/plain' } }
    );
  }

  const url = new URL(request.url);
  const token = await sha256(pass + '|thumbsprint-preview');
  const cookies = request.headers.get('cookie') || '';
  const loggedIn = cookies.split(';').some((c) => c.trim() === `${COOKIE}=${token}`);

  if (loggedIn) {
    const handled = await handleContactRoutes(request, url);
    return handled || undefined; // undefined lets the static site through
  }

  if (request.method === 'POST' && url.pathname === LOGIN_PATH) {
    const form = await request.formData();
    if (form.get('password') === pass) {
      return new Response(null, {
        status: 303,
        headers: {
          Location: '/',
          'Set-Cookie': `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
        },
      });
    }
    return htmlResponse(loginPage(true), 401);
  }

  return htmlResponse(loginPage(false), 401);
}
