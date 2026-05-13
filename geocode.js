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

  // 1차: 지하철역 카테고리(SW8) 우선 검색
  // 2차(폴백): 일부 역(강남역·창동역·노원역 등)은 SW8 카테고리에 없거나 다르게 등록되어 있음.
  //          카테고리 없이 일반 키워드로 재검색 후 "역" 포함 결과를 우선 선택.
  const baseUrl = 'https://dapi.kakao.com/v2/local/search/keyword.json';
  const headers = { 'Authorization': `KakaoAK ${KAKAO_KEY}` };

  async function kakaoSearch(qs) {
    const r = await fetch(`${baseUrl}?${qs}`, { headers });
    const text = await r.text();
    if (!r.ok) {
      const err = new Error(`Kakao HTTP ${r.status} - ${text.slice(0, 300)}`);
      err.status = r.status;
      err.bodyText = text;
      throw err;
    }
    try { return JSON.parse(text); }
    catch { throw new Error(`Kakao response parse failed: ${text.slice(0, 200)}`); }
  }

  try {
    // 1차 — SW8 카테고리 (지하철역만)
    let data = await kakaoSearch(`query=${encodeURIComponent(query)}&category_group_code=SW8&size=1`);
    let doc = data.documents?.[0];
    let matchedBy = 'SW8';

    // 2차 — 카테고리 없이 일반 검색, "역" 포함 결과 우선
    if (!doc) {
      data = await kakaoSearch(`query=${encodeURIComponent(query)}&size=10`);
      const docs = data.documents || [];
      doc = docs.find(d => d.place_name && d.place_name.includes('역'))
         || docs.find(d => (d.category_name || '').includes('지하철'))
         || docs[0];
      matchedBy = doc ? 'general' : null;
    }

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
      matchedBy,
    });
  } catch (e) {
    // 카카오 내부 메시지는 로그에만 남기고 외부 응답에는 노출하지 않음
    console.error('[geocode] Kakao call failed:', e.message);
    return res.status(502).json({
      error: 'Geocode failed',
      message: e.status ? `Upstream HTTP ${e.status}` : 'Network or upstream error',
    });
  }
}
