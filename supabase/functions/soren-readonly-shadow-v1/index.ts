// Independent shadow endpoint. NOT connected to the customer site.
// Explicit secret-gated probe only; no RPCs, INSERT/UPDATE/UPSERT/DELETE, or job scheduling.
// Keep this endpoint undeployed until review and comparison gates pass.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";
import { choosePrematchShadow } from "./picker.js";

const noStore={"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"};
function response(body:unknown,status=200):Response{
  return new Response(JSON.stringify(body),{status,headers:noStore});
}
const db=createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  {auth:{persistSession:false,autoRefreshToken:false}},
);
Deno.serve(async req=>{
  if(req.method!=="GET")return response({ok:false,error:"METHOD_NOT_ALLOWED"},405);
  const shadowKey=Deno.env.get("SOREN_SHADOW_READ_KEY");
  if(!shadowKey||shadowKey.length<32)return response({ok:false,error:"SHADOW_NOT_CONFIGURED"},503);
  if(req.headers.get("x-soren-shadow-key")!==shadowKey)
    return response({ok:false,error:"FORBIDDEN"},403);
  const url=new URL(req.url),date=String(url.searchParams.get("date")??"");
  if(!/^20\d{2}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(date)
     ||Number.isNaN(Date.parse(date+"T00:00:00Z")))
    return response({ok:false,error:"INVALID_POOL_DATE"},400);
  try{
    const queryTimeoutMs=9000;
    const [matches,updates,freezes]=await Promise.all([
      db.from("soren_matches")
        .select("id,pool_date,match_no,home_team,away_team,kickoff_at,is_world_cup")
        .eq("pool_date",date).eq("is_world_cup",false).order("match_no").limit(200)
        .abortSignal(AbortSignal.timeout(queryTimeoutMs)),
      db.from("soren_prematch_updates_v1")
        .select("match_no,source_frozen_at,captured_at,snapshot").eq("pool_date",date)
        .order("source_frozen_at",{ascending:false})
        .order("captured_at",{ascending:false}).limit(5000)
        .abortSignal(AbortSignal.timeout(queryTimeoutMs)),
      db.from("soren_sale_freezes_v1")
        .select("match_no,source_frozen_at,captured_at,locked_at,snapshot").eq("pool_date",date)
        .limit(200).abortSignal(AbortSignal.timeout(queryTimeoutMs))
    ]);
    if(matches.error||updates.error||freezes.error)
      return response({ok:false,error:"SHADOW_READ_UNAVAILABLE"},503);
    if((matches.data?.length??0)>=200||(updates.data?.length??0)>=5000||(freezes.data?.length??0)>=200)
      return response({ok:false,error:"SHADOW_RESULT_LIMIT_REACHED"},503);
    const byMatch=new Map<string,Record<string,unknown>[]>();
    for(const row of updates.data??[]){
      const no=String(row.match_no??"").padStart(3,"0");
      if(!byMatch.has(no))byMatch.set(no,[]);
      byMatch.get(no)!.push(row as Record<string,unknown>);
    }
    const byFreeze=new Map((freezes.data??[]).map(x=>[String(x.match_no??"").padStart(3,"0"),x]));
    const at=Date.now();
    const rows=(matches.data??[]).map(match=>choosePrematchShadow(
      match,byMatch.get(String(match.match_no??"").padStart(3,"0"))??[],
      byFreeze.get(String(match.match_no??"").padStart(3,"0"))??null,at
    ));
    const blocked=rows.filter(x=>x.safe!==true);
    return response({
      ok:true,shadowOnly:true,eligibleForCustomerTraffic:false,
      date,readAt:new Date(at).toISOString(),
      matched:rows.length,safe:rows.length-blocked.length,blocked:blocked.length,
      blockers:blocked.map(x=>({no:x.no,status:x.status})),
      rows
    });
  }catch(_e){
    return response({ok:false,error:"SHADOW_READ_TIMEOUT_OR_FAILURE"},503);
  }
});
