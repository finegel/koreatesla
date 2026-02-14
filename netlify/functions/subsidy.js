// netlify/functions/subsidy.js
// v2: ev.or.kr에서 지역/트림 보조금 "가능하면" 자동 추출 + 24h 캐시 + 실패 시 manual 모드

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
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

function now() { return Date.now(); }
function normalize(s) { return (s || "").trim().replace(/\s+/g, " "); }

const TRIM_ALIASES = {
  M3_STD: ["Model 3 Standard RWD", "Model 3 Standard", "모델 3", "스탠다드", "RWD"],
  M3_LR: ["Model 3 Premium Long Range RWD", "Model 3 Long Range", "롱레인지", "Long Range"],
  M3_PERF: ["Model 3 Performance", "퍼포먼스", "Performance"],
  MY_RWD: ["Model Y Premium RWD", "Model Y RWD", "모델 Y", "Premium RWD", "RWD"],
  MY_LR: ["Model Y Premium Long Range", "Model Y Long Range", "Long Range", "롱레인지", "AWD"],
};

function parseWonFromWindow(txt) {
  // 우선순위: "총 보조금 336만원" -> 3,360,000원
  let m = txt.match(/총\s*보조금\s*([0-9,]+)\s*만원/);
  if (m) return parseInt(m[1].replace(/,/g, ""), 10) * 10000;

  // "국비 168만원 지방비 168만원" 식이면 합산 필요할 수 있으나
  // v2는 총액 패턴 우선, 없으면 만원/원 단일 값이라도 잡아줌.
  m = txt.match(/([0-9,]+)\s*원/);
  if (m) {
    const v = parseInt(m[1].replace(/,/g, ""), 10);
    if (v > 100000) return v;
  }

  m = txt.match(/([0-9,]+)\s*만원/);
  if (m) return parseInt(m[1].replace(/,/g, ""), 10) * 10000;

  return null;
}

async function fetchHtml() {
  const url = "https://ev.or.kr/nportal/buySupprt/initPsLocalCarPirceAction.do";
  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!r.ok) throw new Error(`ev.or.kr HTTP ${r.status}`);
  return await r.text();
}

function tryExtract(html, region, trim) {
  const reg = normalize(region);
  const idxReg = html.indexOf(reg);
  if (idxReg < 0) return { ok: false, reason: "REGION_NOT_FOUND" };

  // region 근처 큰 블록을 잡고
  const start = Math.max(0, idxReg - 80000);
  const end = Math.min(html.length, idxReg + 80000);
  const block = html.slice(start, end);

  const aliases = TRIM_ALIASES[trim] || [];
  // 트림 문자열이 직접 안 나오면, 모델명(예: Model 3)만이라도 매칭해서 금액을 찾는 fallback
  const fallbackAliases = trim.startsWith("M3") ? ["Model 3", "모델 3"] : ["Model Y", "모델 Y"];

  // 1) 트림 별칭으로 최대한 정확히 찾기
  for (const a of aliases) {
    const idx = block.toLowerCase().indexOf(a.toLowerCase());
    if (idx >= 0) {
      const win = block.slice(Math.max(0, idx - 2000), idx + 4000);
      const won = parseWonFromWindow(win);
      if (won != null) return { ok: true, won, method: `alias:${a}` };
    }
  }

  // 2) 모델명으로라도 잡고 근처 금액
  for (const a of fallbackAliases) {
    const idx = block.toLowerCase().indexOf(a.toLowerCase());
    if (idx >= 0) {
      const win = block.slice(Math.max(0, idx - 2000), idx + 4000);
      const won = parseWonFromWindow(win);
      if (won != null) return { ok: true, won, method: `fallback:${a}` };
    }
  }

  return { ok: false, reason: "TRIM_OR_MONEY_NOT_FOUND" };
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
    return resp(200, {
      ok: true,
      source: "cache",
      updatedAt: cache.ts,
      region,
      trim,
      subsidyWon: cache.map[key],
    });
  }

  // 캐시 만료면 새로 시도
  try {
    const html = await fetchHtml();
    const out = tryExtract(html, region, trim);

    if (!out.ok) {
      return resp(200, {
        ok: false,
        mode: "manual",
        region,
        trim,
        reason: out.reason,
        message:
          "자동 조회가 실패했어. ev.or.kr에서 해당 지역/차종 보조금(국비+지방비 합계)을 확인해 수동 입력 후 저장해줘.",
      });
    }

    cache.ts = now();
    cache.map[key] = out.won;

    return resp(200, {
      ok: true,
      source: "ev_or_kr",
      method: out.method,
      updatedAt: cache.ts,
      region,
      trim,
      subsidyWon: out.won,
    });
  } catch (e) {
    return resp(200, {
      ok: false,
      mode: "manual",
      region,
      trim,
      message:
        "자동 조회 실패(네트워크/차단/구조변경). ev.or.kr에서 수동 확인 후 입력해줘.",
      error: String(e?.message || e),
    });
  }
};
