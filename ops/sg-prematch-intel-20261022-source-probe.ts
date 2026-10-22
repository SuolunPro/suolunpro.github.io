import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";
const db=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{db:{schema:"ninety_core"},auth:{persistSession:false,autoRefreshToken:false}});
Deno.serve(async(req:Request)=>{
 if(req.method!=="POST")return Response.json({ok:false,error:"METHOD_NOT_ALLOWED"},{status:405});
 const token=req.headers.get("x-ninety-collector-token")||"";
 if(token.length<32)return Response.json({ok:false,error:"UNAUTHORIZED"},{status:401});
 const auth=await db.rpc("soren_collector_token_valid_v1",{p_token:token});
 if(auth.error||auth.data!==true)return Response.json({ok:false,error:"UNAUTHORIZED"},{status:401});
 const base="https://www.okooo.com/soccer/match/1347741/";
 const headers={"user-agent":"Mozilla/5.0 (compatible; NinetyPrematchIntel/1.0)","accept-language":"zh-CN,zh;q=0.9"};
 const results=[];
 for(const path of ["history/","qingbao/"]){
  try {
   const r=await fetch(base+path,{headers,signal:AbortSignal.timeout(12000)});
   const body=(await r.text()).slice(0,200000);
   results.push({path,status:r.status,bytes:body.length,hasWafMarker:/阿里云|请求被拦截|访问拦截|安全防护|request.blocked/i.test(body),hasPublicIntel:/qingbaozhan-content|content-qingbaozhan/.test(body)});
  }catch(e){results.push({path,error:String(e).slice(0,120)})}
 }
 return Response.json({ok:true,checkedAt:new Date().toISOString(),sourceMid:1347741,results},{headers:{"Cache-Control":"no-store"}});
});
