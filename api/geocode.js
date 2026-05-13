/**
 * Vercel Serverless Function — 카카오 지오코딩 프록시
 *
 * 호출 경로: /api/geocode?q=<역명>
 *
 * 역할:
 *   - 카카오 REST API 키를 서버에서 안전하게 보관 (환경변수)
 *   - 시민이 직접 카카오 키를 입력하지 않아도 작동
 *
 * 환경변수: KAKAO_REST_API_KEY
 *   Vercel 대시보드 → Settings → Environment Variables
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: 'Missing q parameter (역명 또는 시설명)' });
  }

  const KAKAO_KEY = process.env.KAKAO_REST_API_KEY;
  if (!KAKAO_KEY) {
    return res.status(500).json({
      error: 'Server not configured',
      hint: 'Vercel 환경변수에 KAKAO_REST_API_KEY를 등록하세요',
    });
  }

  // 카카오 키워드 검색 — 지하철역 카테고리(SW8) 우선
  const url = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(query)}&category_group_code=SW8&size=1`;

  try {
    const r = await fetch(url, {
      headers: { 'Authorization': `KakaoAK ${KAKAO_KEY}` },
    });
    const data = await r.json();

    // 우리 앱이 쓰기 좋도록 간소화된 응답
    const doc = data.documents?.[0];
    if (!doc) {
      return res.status(404).json({ error: 'No match', query });
    }
    return res.status(200).json({
      query,
      name: doc.place_name,
      address: doc.address_name,
      category: doc.category_name,
      lat: parseFloat(doc.y),
      lng: parseFloat(doc.x),
    });
  } catch (e) {
    return res.status(502).json({ error: 'Geocode failed', message: e.message });
  }
}
