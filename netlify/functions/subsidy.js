exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const region = (params.region || "").trim();
  const trim = (params.trim || "").trim();

  if (!region || !trim) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: false, error: "region and trim are required" }),
    };
  }

  // ✅ MVP: 아직 ev.or.kr 파싱은 안정화 전이라, 일단 "manual"로 응답
  // 다음 단계에서 실제 ev.or.kr 데이터를 긁는 버전으로 교체할 거임.
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify({
      ok: false,
      mode: "manual",
      message: "자동조회 기능 준비중. ev.or.kr에서 보조금 합계를 확인해 수동 입력하세요.",
      region,
      trim,
    }),
  };
};
