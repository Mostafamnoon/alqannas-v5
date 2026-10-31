(function(g){'use strict';
const P=g.SIVTradePlan||(typeof require==='function'?require('./trade-plan-core.js'):null),R=g.SIVResearch||(typeof require==='function'?require('./research-engine.js'):null),E=g.SIVMarketEngine||(typeof require==='function'?require('./wide-engine.js'):null),M=60000,H=60*M;
class PlanEngine{
 constructor(options={}){this.clock=options.clock||(()=>Date.now());this.r=new R(options);this.e=new E(options);this.books=new Map();this.busy=false;}
 restoreBooks(list){for(const b of list||[])if(b?.symbol&&['Binance Spot','MEXC Spot'].includes(b.venue)&&this.clock()-b.receivedAt>=0&&this.clock()-b.receivedAt<=180*M){const id=b.venue+'|'+b.symbol;if(!this.books.has(id)||this.books.get(id).receivedAt<b.receivedAt)this.books.set(id,b);}}
 async load(value,venue='Binance Spot',options={}){
  if(this.busy)throw Error('خطة أخرى قيد الدراسة');this.busy=true;this.r.requests=[];this.r.failures={};const symbol=R.helpers.normalize(value),source=venue==='MEXC Spot'?'mexc':'binance',startedAt=this.clock(),gaps=[];
  try{
   const rawInfo=await this.r.request(source,'/api/v3/exchangeInfo',{symbol}),info=rawInfo.symbols?.find(i=>i.symbol===symbol&&i.quoteAsset==='USDT'&&i.isSpotTradingAllowed===true&&(source==='mexc'?String(i.status)==='1':i.status==='TRADING'));
   if(!info)throw Error('الزوج ليس Spot/USDT نشطاً متاحاً على المنصة المختارة');
   const clock=await this.r.request(source,'/api/v3/time'),now=this.clock();if(!Number.isFinite(clock.serverTime)||now-clock.serverTime<0||now-clock.serverTime>120000)throw Error('وقت المنصة قديم أو مستقبلي');
   const T=Math.floor(clock.serverTime/M)*M,Q=Math.floor(T/(15*M))*15*M,Hour=Math.floor(T/H)*H,Four=Math.floor(T/(4*H))*4*H,opts={mexc:source==='mexc',taker:source!=='mexc'};
   const specs=[['minutes',()=>this.r.candles(source,symbol,'1m',M,121,T-1,undefined,opts)],['btc',()=>this.r.candles(source,'BTCUSDT','1m',M,121,T-1,undefined,opts)],['fifteen',()=>this.r.candles(source,symbol,'15m',15*M,193,Q-1,undefined,opts)],['hours',()=>this.r.candles(source,symbol,source==='mexc'?'60m':'1h',H,169,Hour-1,undefined,opts)],['fourHours',()=>this.r.candles(source,symbol,'4h',4*H,181,Four-1,undefined,opts)],['bookRaw',()=>this.r.request(source,'/api/v3/depth',{symbol,limit:1000})],['trades',()=>this.r.request(source,'/api/v3/trades',{symbol,limit:1})]];
   const values={};for(let i=0;i<specs.length;i++){try{values[specs[i][0]]=await specs[i][1]();}catch(error){gaps.push(specs[i][0]+': '+error.message);}}
   for(const required of ['minutes','btc','fifteen','hours','fourHours'])if(!values[required])throw Error('تعذر بناء خطة من تاريخ ناقص: '+required);
   const frames=Object.fromEntries([['1m',M],['5m',5*M],['15m',15*M],['30m',30*M],['1h',H]].map(([k,d])=>{const v=R.helpers.summarize(values.minutes,d,M,venue),b=R.helpers.summarize(values.btc,d,M,venue+' BTCUSDT');return[k,{...v,relativeBTC:v.returnPct-b.returnPct}];}));
   let depth=null;if(values.bookRaw)try{const id=venue+'|'+symbol,previous=this.books.get(id),book=E.helpers.bookMetrics(values.bookRaw,symbol,this.clock(),previous?{...previous,venue:'Binance Spot'}:null);book.venue=venue;depth=book;this.books.set(id,book);}catch(e){gaps.push('الدفتر: '+e.message);}
   const vals=values.hours.slice(-49,-1).map(b=>b.quoteVolume).sort((a,b)=>a-b),den=(vals[23]+vals[24])/2,rvol=den>0?values.hours.at(-1).quoteVolume/den:null;
   let oi=null,identity={name:info.fullName||info.baseAsset,baseAsset:info.baseAsset,venue,contractAddress:info.contractAddress||null,scope:'هوية زوج المنصة'};
   let matched=source==='binance';if(source==='mexc')try{const bi=await this.r.active(symbol);const cg=await this.r.identity(bi),second=await this.r.mexc(symbol,bi,cg);matched=second.identityMatched===true;if(matched)identity={...identity,coinId:cg.coinId,identityEvidence:second.identityEvidence};else gaps.push('لم تثبت هوية الأصل بين MEXC وعقد Binance؛ OI محجوب');}catch(e){gaps.push('مطابقة هوية OI: '+e.message);}
   if(matched)try{oi=await this.e.derivatives(symbol);oi.identityMatched=true;}catch(e){gaps.push('OI: '+e.message);}
   const trade=values.trades?.at(-1),age=this.clock()-trade?.time,lastTrade=trade&&Number(trade.price)>0&&Number.isFinite(age)&&age>=0&&age<=120000?{price:Number(trade.price),time:trade.time,source:venue+' trades'}:null;if(!lastTrade)gaps.push('آخر تنفيذ لحظي حديث غير متاح؛ السعر المستخدم إغلاق الدقيقة');
   if(source==='mexc')gaps.push('CVD وضغط مشتريات المنفذين غير متاحين من شموع MEXC؛ لا يُستنتجان من السعر والحجم');
   const input={symbol,venue,serverTime:clock.serverTime,minutes:values.minutes,fifteen:values.fifteen,hours:values.hours,fourHours:values.fourHours,frames,rvol,oi,depth,gaps,tickSize:Number(info.filters?.find(f=>f.filterType==='PRICE_FILTER')?.tickSize)||null,sourceRequests:[...this.r.requests,...this.e.requests]};
   const plan=P.build(input,options,this.clock());plan.identity=identity;plan.lastTrade=lastTrade;plan.startedAt=startedAt;plan.receivedAt=this.clock();plan.rvolHourEnd=values.hours.at(-1).time;plan.lastFourHour={close:values.fourHours.at(-1).close,time:values.fourHours.at(-1).time};return plan;
  }finally{this.busy=false;}
 }
}
g.SIVPlanEngine=PlanEngine;if(typeof module!=='undefined'&&module.exports)module.exports=PlanEngine;
})(typeof window!=='undefined'?window:globalThis);
