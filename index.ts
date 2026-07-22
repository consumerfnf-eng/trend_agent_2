// Supabase Edge Function — 주 1회 검색량 수집
// KR: 네이버 DataLab (공식 API · 무료) / GL·CN: SerpAPI 의 Google Trends (선택 · 유료 키 없으면 건너뜀)
//
// 배포:  supabase functions deploy search-signals --no-verify-jwt
// 키:    supabase secrets set NAVER_ID=... NAVER_SECRET=... SERVICE_KEY=<service_role> [SERPAPI_KEY=...]
// 주간 실행: SQL Editor 에서 (pg_cron + pg_net 확장 켠 뒤)
//   select cron.schedule('weekly-signals', '0 1 * * 1',
//     $$select net.http_post('https://<프로젝트>.functions.supabase.co/search-signals',
//       '{}'::jsonb, '{}'::jsonb)$$);

import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SERVICE_KEY")!;          // service_role — 서버에서만
const NAVER_ID = Deno.env.get("NAVER_ID") ?? "";
const NAVER_SECRET = Deno.env.get("NAVER_SECRET") ?? "";
const SERP = Deno.env.get("SERPAPI_KEY") ?? "";

const sb = createClient(SB_URL, SB_KEY);
const monday = (d: Date) => { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x.toISOString().slice(0, 10); };

Deno.serve(async () => {
  // FEED 에 1건이라도 연결된 활성 키워드만
  const { data: cnts } = await sb.from("v_entity_source_count").select("*");
  const withFeed = new Set((cnts ?? []).filter((r: any) => r.source_count >= 1).map((r: any) => r.entity_id));
  const { data: ents } = await sb.from("entities")
    .select("entity_id,name_kr,name_en,axis,status").eq("status", "Active");
  const targets = (ents ?? []).filter((e: any) => e.axis !== "movement" && withFeed.has(e.entity_id)).slice(0, 60);

  const end = new Date(); const start = new Date(end.getTime() - 120 * 86400e3);
  const rows: any[] = [];
  let naverOk = 0, gOk = 0, errs: string[] = [];

  // ── KR: 네이버 DataLab — 한 호출에 키워드그룹 최대 5개
  if (NAVER_ID && NAVER_SECRET) {
    for (let i = 0; i < targets.length; i += 5) {
      const grp = targets.slice(i, i + 5);
      try {
        const r = await fetch("https://openapi.naver.com/v1/datalab/search", {
          method: "POST",
          headers: { "Content-Type": "application/json",
            "X-Naver-Client-Id": NAVER_ID, "X-Naver-Client-Secret": NAVER_SECRET },
          body: JSON.stringify({
            startDate: start.toISOString().slice(0, 10),
            endDate: end.toISOString().slice(0, 10),
            timeUnit: "week",
            keywordGroups: grp.map((e: any) => ({
              groupName: e.entity_id,
              keywords: [e.name_kr, e.name_en].filter(Boolean).slice(0, 5),
            })),
          }),
        });
        if (!r.ok) { errs.push(`naver ${r.status}`); continue; }
        const j = await r.json();
        for (const g of j.results ?? [])
          for (const p of g.data ?? []) {
            rows.push({ entity_id: g.title, region: "KR", week: monday(new Date(p.period)),
              volume: p.ratio, source: "naver" });
            naverOk++;
          }
      } catch (e) { errs.push(`naver ${String(e).slice(0, 60)}`); }
    }
  } else errs.push("NAVER_ID/SECRET 미설정 — KR 건너뜀");

  // ── GL / CN: SerpAPI Google Trends (키 있을 때만 — 구글은 공식 API 가 없습니다)
  if (SERP) {
    for (const e of targets.slice(0, 25)) {           // 쿼터 절약
      for (const [region, geo] of [["GL", ""], ["CN", "CN"]] as const) {
        try {
          const q = encodeURIComponent(e.name_en || e.name_kr);
          const r = await fetch(`https://serpapi.com/search.json?engine=google_trends&q=${q}&date=today%203-m${geo ? `&geo=${geo}` : ""}&api_key=${SERP}`);
          if (!r.ok) continue;
          const j = await r.json();
          for (const p of j.interest_over_time?.timeline_data ?? []) {
            const v = p.values?.[0]?.extracted_value;
            if (v == null) continue;
            rows.push({ entity_id: e.entity_id, region, week: monday(new Date(p.date.split(" – ")[0] || p.date)),
              volume: v, source: "google" });
            gOk++;
          }
        } catch (_) { /* skip */ }
      }
    }
  } else errs.push("SERPAPI_KEY 미설정 — GL/CN 건너뜀 (수동 입력은 가능)");

  if (rows.length) {
    const { error } = await sb.from("search_signals")
      .upsert(rows, { onConflict: "entity_id,region,week" });
    if (error) errs.push(error.message);
  }
  return new Response(JSON.stringify({ keywords: targets.length, naver: naverOk, google: gOk, errs }),
    { headers: { "Content-Type": "application/json" } });
});
