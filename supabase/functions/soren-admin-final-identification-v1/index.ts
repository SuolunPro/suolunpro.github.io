import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

// Dedicated read-only administrator shadow view. No calls to the formal engine,
// customer API, freeze logic or warning writes.
const url=Deno.env.get("SUPABASE_URL")!;
const db=createClient(url,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{
  auth:{persistSession:false,autoRefreshToken:false}
});
const cors={
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Methods":"GET, OPTIONS",
  "Access-Control-Allow-Headers":"authorization, apikey, content-type, x-client-info",
};
const json=(obj:unknown,status=200)=>new Response(JSON.stringify(obj),{
  status,headers:{...cors,"Content-Type":"application/json; charset=utf-8",
    "Cache-Control":"private, no-store","Vary":"Authorization"}
});
const text=(v:unknown)=>String(v??"").trim();
const ms=(v:unknown)=>Date.parse(text(v));
const validBefore=(at:unknown,deadline:number,now:number)=>Number.isFinite(ms(at))&&ms(at)<deadline&&ms(at)<=now;
const nameOf=(v:unknown)=>v==="H"||v==="主胜"?"主队":v==="A"||v==="客胜"?"客队":null;
const dirLabel=(v:unknown)=>v==="H"?"主胜":v==="A"?"客胜":v==="D"?"平":text(v)||"未确认";
const opposite=(x:string)=>x==="主队"?"客队":x==="客队"?"主队":null;
const odds=(v:unknown)=>Number.isFinite(Number(v))&&Number(v)>1?Number(v):null;
const trim=(v:unknown,max=180)=>text(v).slice(0,max);
const safeRows=(r:any[],deadline:number,now:number,key="captured_at")=>r.filter(x=>validBefore(x[key],deadline,now));
const fresh=(at:unknown,now:number,hours=8)=>Number.isFinite(ms(at))&&now-ms(at)<=hours*3600e3;
function marketDirection(initial:any,current:any,now:number){
  if(!current||!initial||!fresh(current.captured_at,now,8))return "未确认";
  const ih=odds(initial.home_value),ia=odds(initial.away_value),ch=odds(current.home_value),ca=odds(current.away_value);
  if(ih===null||ia===null||ch===null||ca===null)return "未确认";
  if(ch-ih>=.09&&ia-ca>=.08)return "客队";
  if(ih-ch>=.09&&ca-ia>=.08)return "主队";
  return "无明确单边变化";
}
Deno.serve(async(req)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors});
  if(req.method!=="GET")return json({ok:false,error:"METHOD_NOT_ALLOWED"},405);
  const token=(req.headers.get("authorization")||"").match(/^Bearer\s+(.+)$/i)?.[1]??"";
  if(!token)return json({ok:false,error:"LOGIN_REQUIRED"},401);
  try{
    const {data:auth,error:authError}=await db.auth.getUser(token);
    if(authError||!auth.user?.id)return json({ok:false,error:"LOGIN_REQUIRED"},401);
    const {data:membership,error:memberError}=await db.rpc("soren_member_status_v1",{
      p_user:String(auth.user.id),p_invite_code:null
    });
    if(memberError)return json({ok:false,error:"MEMBERSHIP_UNAVAILABLE"},503);
    // The exact same server-authoritative administrator flag as the customer API.
    if(membership?.isAdmin!==true)return json({ok:false,error:"ADMIN_REQUIRED"},403);
    const parsed=new URL(req.url);
    const date=text(parsed.searchParams.get("date"));
    const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()).replace(/\//g,"-");
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date<new Date(Date.now()-16*864e5).toISOString().slice(0,10)||date>today)
      return json({ok:false,error:"DATE_OUT_OF_RANGE"},400);
    const {data:matches,error:matchError}=await db.from("soren_matches")
      .select("id,pool_date,match_no,league,home_team,away_team,kickoff_at,is_world_cup")
      .eq("pool_date",date).eq("is_world_cup",false)
      .order("match_no",{ascending:true}).limit(40);
    if(matchError)throw matchError;
    const pool=matches??[];
    if(!pool.length)return json({ok:true,date,generatedAt:new Date().toISOString(),rows:[],scope:"admin_shadow"});
    const ids=pool.map((m:any)=>Number(m.id));
    // Four bounded reads; never call collectors or recalculate the mother model.
    const [pr,ir,mr,wr]=await Promise.all([
      db.from("soren_predictions").select("match_id,ft_top1,ft_second,confidence,dq,recommendation_action,handicap_pick,frozen_at,created_at")
        .in("match_id",ids).order("frozen_at",{ascending:false}).limit(300),
      db.from("soren_intelligence_reports_v1")
        .select("match_id,source_code,source_url,headline,published_at,fetched_at,quality,highlights")
        .in("match_id",ids).order("published_at",{ascending:false}).limit(220),
      db.from("soren_market_snapshots")
        .select("match_id,source_code,market_type,snapshot_type,home_value,draw_value,away_value,captured_at,data_quality")
        .in("match_id",ids).eq("source_code","zucaijia_william").eq("market_type","FT_1X2")
        .order("captured_at",{ascending:false}).limit(400),
      db.from("soren_upset_warnings_v1")
        .select("match_no,risk_level,risk_score,warning_direction,source_frozen_at")
        .eq("pool_date",date).order("source_frozen_at",{ascending:false}).limit(180)
    ]);
    for(const r of [pr,ir,mr,wr])if(r.error)throw r.error;
    const now=Date.now();
    const rows=pool.map((m:any)=>{
      const deadline=ms(m.kickoff_at),matchId=Number(m.id);
      const preds=(pr.data??[]).filter((p:any)=>Number(p.match_id)===matchId
        &&validBefore(p.frozen_at,deadline,now)&&validBefore(p.created_at,deadline,now));
      const pred=preds[0]??null;
      const base=pred?nameOf(pred.ft_top1):null;
      const articles=(ir.data??[]).filter((x:any)=>Number(x.match_id)===matchId
        &&validBefore(x.published_at,deadline,now)&&validBefore(x.fetched_at,deadline,now));
      const foreign=articles.filter((x:any)=>{
        const h=x.highlights??{},summary=trim(h.summary_zh,700);
        // Exclude headline-only categorization and unsupported inferred labels.
        return text(x.source_code).startsWith("overseas_")&&summary.length>=15
          &&h.shadow_only===true&&now-ms(x.published_at)<120*3600e3;
      });
      const seen=new Set<string>(),facts:any[]=[];
      for(const x of foreign){
        const h=x.highlights??{},summary=trim(h.summary_zh,370);
        const key=summary.replace(/[，。？！,.!?\s]/g,"").slice(0,62);
        if(seen.has(key))continue;
        seen.add(key);
        facts.push({summary,benefit:text(h.benefit_side)||"不明确",source:trim(h.sourceName||h.originDomain||x.source_code,55),
          publishedAt:x.published_at,fetchedAt:x.fetched_at,url:trim(x.source_url,450)});
      }
      const useful=facts.filter(x=>x.benefit==="主队"||x.benefit==="客队");
      const sides=new Set(useful.map(x=>x.benefit));
      const lean=sides.size===1?[...sides][0]:null;
      const domestic=articles.filter((x:any)=>!text(x.source_code).startsWith("overseas_"))
        .map((x:any)=>({title:trim(x.headline,160),source:trim(x.source_code,70),
          publishedAt:x.published_at,fetchedAt:x.fetched_at})).slice(0,4);
      const prices=(mr.data??[]).filter((x:any)=>Number(x.match_id)===matchId
        &&validBefore(x.captured_at,deadline,now)&&x.data_quality==="verified");
      const initial=prices.find((x:any)=>x.snapshot_type==="initial")??null;
      const current=prices.find((x:any)=>x.snapshot_type==="current")??null;
      const market=marketDirection(initial,current,now);
      const warning=(wr.data??[]).find((w:any)=>text(w.match_no)===text(m.match_no)
        &&validBefore(w.source_frozen_at,deadline,now));
      let status="待确认",description="尚无足够的独立、及时证据形成联合识别方向。";
      const opposed=base&&lean===opposite(base);
      if(pred&&base&&lean){
        if(opposed&&market===opposite(base)){
          status="重点复核";description="核实过的海外消息与威廉赔率变化均不利于Top1，建议检查临场首发及亚洲盘；不能据此直接反选。";
        }else if(opposed&&market===base){
          status="情报与机构分歧";description="海外消息不利于Top1，但威廉赔率走势仍支持原方向；应核验时效与消息是否被市场消化。";
        }else if(opposed){
          status="情报风险提示";description="海外事实性消息不利于Top1，但市场尚无足够独立证据确认反转。";
        }else if(lean===base&&market===base){
          status="同向支持";description="海外事实消息与威廉赔率走势同向，仍不代表胜率保证，也不改变正式预测。";
        }else{
          status="有限支持";description="海外事实性消息偏向Top1，但机构尚未明确确认，暂不增加正式信心。";
        }
      }else if(facts.length>0&&sides.size>1){
        status="双方因素交错";description="双方各有利好或利空，不能机械按报道数量决定赛果。";
      }else if(pred&&market===base&&facts.length===0){
        status="市场单线支持";description="威廉赔率走势支持Top1，但海外可靠事实消息不足，无法称为多方共识。";
      }
      if(!pred){status="待确认";description="当前未取得合法赛前正式预测，不能生成识别方向。";}
      return {
        no:m.match_no,league:m.league,home:m.home_team,away:m.away_team,kickoff:m.kickoff_at,
        top1:pred?dirLabel(pred.ft_top1):"未确认",
        second:pred?dirLabel(pred.ft_second):"未确认",
        confidence:pred?.confidence??null,action:pred?.recommendation_action??null,
        status,description,lean:lean||"未确认",
        market:{direction:market,initial:initial?{home:initial.home_value,draw:initial.draw_value,away:initial.away_value,at:initial.captured_at}:null,
          current:current?{home:current.home_value,draw:current.draw_value,away:current.away_value,at:current.captured_at}:null},
        overseas:{count:facts.length,facts:facts.slice(0,5),ambiguous:foreign.length-facts.length},
        domestic:{count:domestic.length,items:domestic,coverage:domestic.length?"部分已归档":"澳客原文未同步至生产情报表"},
        warnings:{riskLevel:warning?.risk_level??"未确认",warningDirection:warning?.risk_level==="中"||warning?.risk_level==="高"?warning.warning_direction:null},
        evidenceAt:pred?.frozen_at??null,shadowOnly:true
      };
    });
    return json({ok:true,date,generatedAt:new Date().toISOString(),
      rows,scope:"administrator_only_shadow_v0.1",
      note:"试运行：目前仅交叉已归档的国内新闻、经摘要核验的海外情报和威廉赔率；完整澳客影子原文尚未跨库同步。不得将风险标签视为已触发正式冷门预警。"});
  }catch(error){
    console.error("ADMIN_FINAL_INTEL_FAILED",error);
    return json({ok:false,error:"SHADOW_READ_UNAVAILABLE"},503);
  }
});
