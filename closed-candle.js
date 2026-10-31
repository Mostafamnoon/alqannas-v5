(function(g){'use strict';
const M=60000,STEPS={'5m':5*M,'15m':15*M,'1h':60*M,'4h':240*M},finite=Number.isFinite;
function validate(point,interval,now=Date.now()){
 const step=STEPS[interval],b=point?.closedCandles?.[interval],clock=point?.serverTime;if(!step)return {valid:false,reason:'فريم الإغلاق غير مدعوم'};
 if(!b)return {valid:false,reason:point?.closedCandleGaps?.[interval]||'شمعة أصلية مغلقة غير متاحة'};
 if(!finite(clock)||now-clock<0||now-clock>120000||!finite(b.retrievedAt)||now-b.retrievedAt<0||now-b.retrievedAt>120000)return {valid:false,reason:'وقت التحقق من الإغلاق قديم أو مستقبلي'};
 const expected=Math.floor(clock/step)*step-1;if(b.closed!==true||b.interval!==interval||b.symbol!==point.symbol||b.venue!==point.venue||b.source!==point.venue+' native klines'||b.closeTime!==expected||b.openTime!==expected+1-step||!finite(b.close)||!(b.close>0))return {valid:false,reason:'الشمعة نشطة أو قديمة أو لا تطابق الزوج والمنصة والنهاية المطلوبة'};
 return {valid:true,bar:b};
}
async function attach(point,rules,request,clock=()=>Date.now()){
 const intervals=[...new Set((rules||[]).filter(x=>x.enabled!==false).flatMap(x=>x.type==='candleCloseBelow'||x.type==='candleCloseAbove'?[x.candleInterval]:x.stopMode==='candleClose'?[x.stopInterval]:[]))];point.closedCandles={};point.closedCandleGaps={};
 for(const interval of intervals){try{const step=STEPS[interval];if(!step)throw Error('فريم الإغلاق غير مدعوم');if(!finite(point.serverTime))throw Error('وقت المنصة غير متاح');const end=Math.floor(point.serverTime/step)*step-1,code=point.venue==='MEXC Spot'&&interval==='1h'?'60m':interval,raw=await request('/api/v3/klines',{symbol:point.symbol,interval:code,startTime:end+1-2*step,endTime:end,limit:2});if(!Array.isArray(raw)||raw.length!==2)throw Error('لا توجد شمعتان مغلقتان متصلتان');for(let i=0;i<raw.length;i++){const b=raw[i],close=point.venue==='MEXC Spot'&&b[6]===b[0]+step?b[6]-1:b[6];if(b[0]!==end+1-(2-i)*step||close!==b[0]+step-1||![1,2,3,4].every(k=>b[k]!==null&&String(b[k]).trim()!==''&&Number.isFinite(Number(b[k]))&&Number(b[k])>0)||Number(b[2])<Math.max(Number(b[1]),Number(b[4]))||Number(b[3])>Math.min(Number(b[1]),Number(b[4])))throw Error('شمعة أصلية غير صالحة');}const last=raw.at(-1);point.closedCandles[interval]={symbol:point.symbol,venue:point.venue,source:point.venue+' native klines',interval,closed:true,openTime:last[0],closeTime:end,close:Number(last[4]),retrievedAt:clock()};}catch(e){point.closedCandleGaps[interval]=e.message;}}
 return point;
}
function evaluate(alert,previous,current,state={},now=Date.now()){
 const next={...state};if(alert.enabled===false)return {state:next,event:null,quality:{valid:false,reason:'التنبيه متوقف'}};
 if(current?.valid===false||!(finite(current?.price)&&current.price>0)||!finite(current?.time)||now-current.time<0||now-current.time>120000)return {state:next,event:null,quality:{valid:false,reason:'قياس السعر الحالي غير صالح أو قديم'}};
 const q=validate(current,alert.candleInterval,now);if(!q.valid){next.quality=q.reason;return {state:next,event:null,quality:q};}
 if(alert.symbol!==current.symbol||alert.venue!==current.venue)return {state:next,event:null,quality:{valid:false,reason:'هوية التنبيه لا تطابق القياس'}};
 const level=typeof alert.level==='boolean'||alert.level===null?NaN:Number(alert.level);if(!(level>0))return {state:next,event:null,quality:{valid:false,reason:'مستوى إغلاق غير صالح'}};const b=q.bar;
 if(state.lastCandleCloseTime>=b.closeTime)return {state:next,event:null,quality:{valid:true,reason:'لا إغلاق جديد'}};
 const first=!state.initialized,active=(alert.type==='candleCloseBelow'?b.close<level:b.close>level)&&alert._compositePass!==false;next.initialized=true;next.lastCandleCloseTime=b.closeTime;next.lastPointTime=current.time;next.condition=active;next.quality=null;
 if(!active){next.armed=true;return {state:next,event:null,quality:q};}if(next.armed===undefined)next.armed=true;
 const cooled=!state.lastFiredAt||now-state.lastFiredAt>=Math.max(0,Number(alert.cooldownSeconds)||0)*1000;
 if((!state.firedOnce||alert.repeat)&&next.armed&&cooled&&(!first||alert.fireNow)){next.firedOnce=true;next.armed=false;next.lastFiredAt=now;return {state:next,quality:q,event:{type:'price-alert',alertId:alert.id,symbol:current.symbol,venue:current.venue,condition:alert.type,candleInterval:alert.candleInterval,price:b.close,currentPrice:current.price,source:b.source,sourceTime:b.closeTime,time:now,reason:'تحقق إغلاق '+alert.candleInterval+(alert.type==='candleCloseBelow'?' دون ':' فوق ')+level,rulesVersion:'closed-candle-v1',execution:false}};}
 return {state:next,event:null,quality:q};
}
const api={STEPS,validate,attach,evaluate};g.SIVClosedCandle=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
