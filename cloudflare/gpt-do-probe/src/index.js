export class PredictionStore {
  constructor(state) { this.state=state; }
  async fetch(request) {
    const url=new URL(request.url);
    if(url.pathname==='/probe') {
      const key='probe:deployment';
      await this.state.storage.put(key,{ok:true});
      const value=await this.state.storage.get(key);
      await this.state.storage.delete(key);
      return Response.json({ok:value?.ok===true});
    }
    return new Response('Not found',{status:404});
  }
}
export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    if(url.pathname!=='/health') return new Response('Not found',{status:404});
    const id=env.PREDICTION_STORE.idFromName('deployment-check');
    const res=await env.PREDICTION_STORE.get(id).fetch('https://internal/probe');
    return Response.json({worker:true,storage:res.ok && (await res.json()).ok});
  }
};
