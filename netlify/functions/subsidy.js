// netlify/functions/subsidy.js
// v3: teslacharger.co.kr/subsidy 페이지에서 region+trim "총 보조금"을 파싱
// 실패 시 manual 모드로 fallback

const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12시간 캐시 (보조금은 변동 가능)
let cache = { ts: 0, map: {} };

function resp(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

function normalize(s) {
  return (s || "").trim().replace(/\s+/g, " ");
}

function now() { return Date.now(); }

const TRIM_LABEL = {
  M3_STD: "Model 3 Standard RWD",
  M3_LR: "Model 3 Premium Long Range RWD",
  M3_PERF: "Model 3 Performance",
  MY_RWD: "Model Y Premium RWD",
  MY_LR: "Model Y Premium Long Range",
};

async function fetchTeslaChargerText() {
  // 서버 사이드라 CORS 상관 없음
  const url = "https://teslacharger.co.kr/subsidy";
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/html,*/*" },
  });
  if (!r.ok) throw new Error(`teslacharger HTTP ${r.status}`);
  const html = await r.text();
  // HTML 그대로 파싱하기보다, 텍스트 기반으로 찾기 쉽게 태그를 줄이는 간단 처리
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

function parseSubsidyWon(pageText, region, trim) {
  const reg = normalize(region);
  const label = TRIM_LABEL[trim];
  if (!label) return { ok: false, reason: "UNKNOWN_TRIM" };

  const idxReg = pageText.indexOf(reg);
  if (idxReg < 0) return { ok: false, reason: "REGION_NOT_FOUND" };

  // 지역 근처 1만자 정도 블록에서 트림/총보조금 찾기
  const block = pageText.slice(Math.max(0, idxReg - 20000), idxReg + 20000);

  const idxModel = block.indexOf(label);
  if (idxModel < 0) return { ok: false, reason: "TRIM_NOT_FOUND_IN_REGION_BLOCK" };

  const win = block.slice(Math.max(0, idxModel - 2000), idxModel + 4000);

  // "총 보조금 336만원" 형태를 우선 매칭
  let m = win.match(/총\s*보조금\s*([0-9,]+)\s*만원/);
  if (m) return { ok: true, won: parseInt(m[1].replace(/,/g, ""), 10) * 10000 };

  // 혹시 "만원"만 노출되는 경우 fallback
  m = win.match(/([0-9,]+)\s*만원/);
  if (m) return { ok: true, won: parseInt(m[1].replace(/,/g, ""), 10) * 10000 };

  // 마지막 fallback: 원 표기
  m = win.match(/([0-9,]+)\s*원/);
  if (m) return { ok: true, won: parseInt(m[1].replace(/,/g, ""), 10) };

  return { ok: false, reason: "MONEY_NOT_FOUND" };
}

exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};
  const region = normalize(qs.region);
  const trim = (qs.trim || "").trim();

  if (!region || !trim) {
    return resp(400, { ok: false, error: "region and trim are required" });
  }

  const key = `${region}||${trim}`;

  // 캐시 hit
  if (cache.map[key] != null && (now() - cache.ts) < CACHE_TTL_MS) {
    return resp(200, { ok: true, source: "cache", updatedAt: cache.ts, region, trim, subsidyWon: cache.map[key] });
  }

  try {
    const text = await fetchTeslaChargerText();
    const parsed = parseSubsidyWon(text, region, trim);

    if (!parsed.ok) {
      return resp(200, {
        ok: false,
        mode: "manual",
        source: "teslacharger",
        region,
        trim,
        reason: parsed.reason,
        message: "자동조회 실패. (지역 표기/페이지 구조 변경 가능) 공식(ev.or.kr)에서 확인 후 수동 입력/저장해줘.",
      });
    }

    cache.ts = now();
    cache.map[key] = parsed.won;

    return resp(200, {
      ok: true,
      source: "teslacharger",
      updatedAt: cache.ts,
      region,
      trim,
      subsidyWon: parsed.won,
    });
  } catch (e) {
    return resp(200, {
      ok: false,
      mode: "manual",
      source: "teslacharger",
      region,
      trim,
      message: "자동조회 실패(네트워크/차단/구조변경). ev.or.kr에서 수동 확인 후 입력/저장해줘.",
      error: String(e?.message || e),
    });
  }
};
