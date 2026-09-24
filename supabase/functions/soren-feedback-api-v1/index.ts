import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

/* Isolated feedback API: never writes to predictions, membership or referrals.
   Supabase user JWT is verified on every request; admin role is checked on server. */
const db=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  {auth:{persistSession:false,autoRefreshToken:false}});
const origin="https://suolunpro.github.io";
const cors={"Access-Control-Allow-Origin":origin,"Access-Control-Allow-Headers":"authorization,apikey,content-type",
  "Access-Control-Allow-Methods":"GET,POST,OPTIONS","Vary":"Origin"};
const reply=(body:Record<string,unknown>,status=200)=>new Response(JSON.stringify(body),{
  status,headers:{...cors,"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});
const categories=new Set(["功能建议","网站问题","会员咨询","其他反馈"]);
const statuses=new Set(["replied","resolved"]);
const mineColumns="id,category,content,status,admin_reply,created_at,replied_at,updated_at";
const adminColumns=mineColumns+",user_id";
async function payload(req:Request):Promise<Record<string,unknown>|null>{
  const raw=await req.text();
  if(raw.length>8000)return null;
  try{const value=JSON.parse(raw);return value&&typeof value==="object"&&!Array.isArray(value)?value:null}catch{return null}
}
Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors});
  if(!["GET","POST"].includes(req.method))return reply({ok:false,error:"METHOD_NOT_ALLOWED"},405);
  const token=req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if(!token)return reply({ok:false,error:"LOGIN_REQUIRED"},401);
  try{
    const {data:auth,error:authError}=await db.auth.getUser(token);
    if(authError||!auth.user?.id)return reply({ok:false,error:"LOGIN_REQUIRED"},401);
    const userId=auth.user.id;
    const url=new URL(req.url);
    const action=url.searchParams.get("action");
    const scope=url.searchParams.get("scope")||"mine";
    const needsAdmin=scope==="admin"||action==="reply";
    let isAdmin=false;
    if(needsAdmin){
      const {data:admin,error}=await db.from("soren_admin_members_v1")
        .select("user_id").eq("user_id",userId).maybeSingle();
      if(error){console.error("FEEDBACK_ADMIN_CHECK",error.message);return reply({ok:false,error:"SERVICE_UNAVAILABLE"},503)}
      isAdmin=!!admin;
      if(!isAdmin)return reply({ok:false,error:"FORBIDDEN"},403);
    }
    if(req.method==="GET"){
      if(action||!["mine","admin"].includes(scope))return reply({ok:false,error:"INVALID_QUERY"},400);
      const filter=url.searchParams.get("filter")||"all";
      if(!["all","pending","replied","resolved"].includes(filter))return reply({ok:false,error:"INVALID_FILTER"},400);
      let q=db.from("soren_customer_feedback_v1")
        .select(scope==="admin"?adminColumns:mineColumns,{count:"exact"})
        .order("created_at",{ascending:false}).limit(50);
      if(scope==="mine")q=q.eq("user_id",userId);
      if(filter!=="all")q=q.eq("status",filter);
      const {data,error,count}=await q;
      if(error){console.error("FEEDBACK_LIST",error.message);return reply({ok:false,error:"SERVICE_UNAVAILABLE"},503)}
      let pendingCount:null|number=null;
      if(scope==="admin"){
        const pending=await db.from("soren_customer_feedback_v1")
          .select("id",{head:true,count:"exact"}).eq("status","pending");
        if(pending.error){console.error("FEEDBACK_COUNT",pending.error.message);return reply({ok:false,error:"SERVICE_UNAVAILABLE"},503)}
        pendingCount=pending.count??0;
      }
      return reply({ok:true,items:data??[],count:count??0,pendingCount});
    }
    const body=await payload(req);
    if(!body)return reply({ok:false,error:"INVALID_BODY"},400);
    if(action==="create"){
      const category=body.category,content=body.content;
      if(typeof category!=="string"||!categories.has(category)||typeof content!=="string")
        return reply({ok:false,error:"INVALID_FEEDBACK"},400);
      const clean=content.normalize("NFC").trim();
      if(!clean||Array.from(clean).length>500)return reply({ok:false,error:"INVALID_LENGTH"},400);
      const {data,error}=await db.from("soren_customer_feedback_v1")
        .insert({user_id:userId,category,content:clean}).select(mineColumns).single();
      if(error){
        if(error.message.includes("FEEDBACK_RATE_LIMIT"))return reply({ok:false,error:"RATE_LIMIT"},429);
        console.error("FEEDBACK_CREATE",error.message);
        return reply({ok:false,error:"SUBMIT_FAILED"},503);
      }
      return reply({ok:true,item:data},201);
    }
    if(action==="reply"&&isAdmin){
      const id=body.id,content=body.reply,status=body.status;
      if(typeof id!=="number"||!Number.isSafeInteger(id)||id<1||
        typeof content!=="string"||typeof status!=="string"||!statuses.has(status))
        return reply({ok:false,error:"INVALID_REPLY"},400);
      const clean=content.normalize("NFC").trim();
      if(!clean||Array.from(clean).length>1000)return reply({ok:false,error:"INVALID_LENGTH"},400);
      const now=new Date().toISOString();
      const {data,error}=await db.from("soren_customer_feedback_v1")
        .update({admin_reply:clean,status,replied_by:userId,replied_at:now,updated_at:now})
        .eq("id",id).select(adminColumns).maybeSingle();
      if(error){console.error("FEEDBACK_REPLY",error.message);return reply({ok:false,error:"REPLY_FAILED"},503)}
      if(!data)return reply({ok:false,error:"NOT_FOUND"},404);
      return reply({ok:true,item:data});
    }
    return reply({ok:false,error:"INVALID_ACTION"},400);
  }catch(error){
    console.error("FEEDBACK_UNEXPECTED",error);
    return reply({ok:false,error:"SERVICE_UNAVAILABLE"},503);
  }
});