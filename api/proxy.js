/**
 * Vercel Serverless Function — 공공데이터 API 프록시
 *
 * 호출 경로: /api/proxy?url=<인코딩된 대상 URL>
 *
 * 역할:
 *   - 서울 열린데이터광장·data.go.kr 등 CORS 차단 API의 우회
 *   - SSRF 방어 (사설망·로컬 호스트 차단)
 *
 * 배포: GitHub에 push만 하면 Vercel이 자동 인식·배포
 */

const BLOCKED_HOSTS = [
  'localhost', '127.', '0.0.0.0', '169.254.',
  '10.', '192.168.',
  '172.16.', '172.17.', '172.18.', '172.19.',
  '172.20.', '172.21.', '172.22.', '172.23.',
  '172.24.', '172.25.', '172.26.', '172.27.',
  '172.28.', '172.29.', '172.30.', '172.31.',
];

function isBlocked(targetUrl) {
  try {
    const host = new URL(targetUrl).hostname;
    return BLOCKED_HOSTS.some((p) => {
      const clean = p.replace(/\.$/, '');
      return host === clean || host.startsWith(p);
    });
  } catch {
    return true;
  }
}

// 로그에 키 노출 방지를 위한 마스킹
function maskKey(url) {
  return url
    .replace(/serviceKey=[^&]+/i, 'serviceKey=***')
    .replace(/\/[0-9a-zA-Z]{30,}\//, '/***/');
}

export default async function handler(req, res) {
  // CORS 허용
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }
  if (isBlocked(targetUrl)) {
    console.log('[proxy] BLOCKED:', maskKey(targetUrl).slice(0, 100));
    return res.status(403).json({ error: 'Target host blocked for security' });
  }

  console.log('[proxy] →', maskKey(targetUrl).slice(0, 120));

  try {
    // 타임아웃 25초 (Vercel 무료 플랜 한도 10초보다 짧게)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);

    const upstream = await fetch(targetUrl, {
      headers: {
        'Accept': 'application/json, application/xml, text/xml, */*',
        'User-Agent': 'ElevatorTrafficLight-Vercel/1.0',
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const contentType = upstream.headers.get('content-type') || 'application/json';
    const body = await upstream.text();

    console.log('[proxy] ←', upstream.status, `${body.length} bytes`);

    res.setHeader('Content-Type', contentType);
    return res.status(upstream.status).send(body);
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Upstream timed out (>9s)' : e.message;
    console.error('[proxy] ERROR:', msg);
    return res.status(502).json({ error: 'Proxy fetch failed', message: msg });
  }
}
