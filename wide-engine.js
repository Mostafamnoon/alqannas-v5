(function(global){
'use strict';
const Base=global.SIVMarketEngine||(typeof require==='function'?require('./market-engine.js'):null),Research=global.SIVResearch||(typeof require==='function'?require('./research-engine.js'):null);
const M=60000,H=3600000,{pct,median,metrics,bookMetrics,MarketError}=Base.helpers;
const num=x=>x===null||x===undefined||typeof x==='boolean'||String(x).trim()===''?null:Number.isFinite(Number(x))?Number(x):null;
const key=(venue,symbol)=>venue+'|'+symbol;
const name=v=>v==='mexc'?'MEXC Spot':'Binance Spot';
function mexcBars(raw,step,count,end){
 const parsed=Research.helpers.parseBars(raw,step,end,{mexc:true,taker:false});
 if(parsed.length!==count||parsed[0].openTime!==end+1-count*step)throw new MarketError('عدد أو بداية شموع MEXC غير مكتمل');
 return parsed.map(b=>[b.openTime,String(b.open),String(b.high),String(b.low),String(b.close),String(b.baseVolume),b.time,String(b.quoteVolume),null,null,null]);
}
function mexcMetrics(bars,n){if(!bars||bars.length<n+1)return null;const current=bars.slice(-n),prior=bars.at(-n-1),previous=bars.slice(-2*n,-n),q=current.reduce((s,b)=>s+Number(b[7]),0),old=previous.length===n?previous.reduce((s,b)=>s+Number(b[7]),0):null;return {r:pct(Number(current.at(-1)[4]),Number(prior[4])),q,buy:null,buyShare:null,delta:null,deltaPct:null,previousQ:old,volumeChange:old>0?pct(q,old):null,trades:null,start:prior[6]+1,end:current.at(-1)[6],close:Number(current.at(-1)[4])};}
function pulse(row){
 Object.assign(row,Base.helpers.classify(row));
 const f=row.frames['5m'],g=row.frames['15m'],a=row.frames['30m'],h=row.frames['1h'];
 const early=f?.r>0&&g?.r>0&&f.relativeBTC>0&&g.relativeBTC>0&&(f.volumeChange>=50||g.volumeChange>=50)&&g.q>0;
 if(early&&['neutral','fading','watch'].includes(row.status))Object.assign(row,{status:'early',label:'نبضة مبكرة — مراقبة',reason:'تفوق على BTC في 5 و15 دقيقة مع توسع حجم إحداهما؛ تأكيد الاستمرار والسيولة مطلوب',confirmation:'استمرار القوة والحجم في 15 و30 دقيقة مع دفتر قابل للتداول',invalidation:'فقد القوة النسبية أو تقلص النشاط أو ضعف العمق',priority:3.6,signalTier:'pulse'});
 if(row.venue==='MEXC Spot'){
  row.direction='mixed';
  if(['early','supported'].includes(row.status)){row.label='نبضة نشاط — MEXC';row.reason+='؛ اتجاه ضغط المنفذين غير متاح من شموع MEXC';}
  if(row.status==='watch'&&a.r>0&&h.r>0)row.label='صعود وحجم يحتاجان تحققاً';
  row.quality.completeForReview=false;
 }
 if(row.frames['15m']?.q===0){row.status='neutral';row.label='لا تداول منفذ في آخر 15 دقيقة';row.priority=0;}
 row.notifyEligible=['early','supported','conflict'].includes(row.status)||(row.status==='sell')||(row.status==='watch'&&a.r>0&&h.r>0&&a.volumeChange>0&&h.volumeChange>0);
 return row;
}
class WideEngine extends Base{
 constructor(options={}){super(options);this.research=new Research({fetch:this.fetch,clock:this.clock,...(options.useProxy!==undefined?{useProxy:options.useProxy}:{})});this.mexcCatalog=null;this.mexcCatalogAt=0;this.discoveryPrevious=new Map();this.discoveryCursors={binance:0,mexc:0};this.discoverySeen=new Map();this.lastCoverage=null;this.pinnedVenues=[];this.followups=new Map();}
 restoreDiscovery(s){if(!s||typeof s!=='object')return;for(const v of ['binance','mexc'])if(Number.isInteger(s.cursors?.[v])&&s.cursors[v]>=0)this.discoveryCursors[v]=s.cursors[v];for(const [k,p]of Object.entries(s.previous||{}))if(/^(Binance|MEXC) Spot\|[A-Z0-9]+USDT$/.test(k)&&num(p.price)>0&&Number.isFinite(p.at)&&this.clock()-p.at>=0&&this.clock()-p.at<10*M)this.discoveryPrevious.set(k,p);for(const [k,p]of Object.entries(s.followups||{}))if(p&&Number.isFinite(p.until)&&p.until>this.clock()&&p.until-this.clock()<=10*M)this.followups.set(k,p);for(const [k,t]of Object.entries(s.seen||{}))if(Number.isFinite(t)&&this.clock()-t>=0&&this.clock()-t<86400000)this.discoverySeen.set(k,t);}
 exportDiscovery(){return {version:1,cursors:this.discoveryCursors,previous:Object.fromEntries(this.discoveryPrevious),seen:Object.fromEntries(this.discoverySeen),followups:Object.fromEntries(this.followups)};}
 restoreBooks(list){super.restoreBooks(list);if(Array.isArray(list))for(const b of list)if(b?.venue==='MEXC Spot'&&b.symbol&&this.clock()-b.receivedAt>=0&&this.clock()-b.receivedAt<=180*M)this.books.set(key(b.venue,b.symbol),b);}
 async source(v,route,params={},signal){return v==='mexc'?this.research.request('mexc',route,params,signal):this.request(route,params,false,signal);}
 async catalogFor(v,signal){if(v==='binance')return this.loadCatalog(signal);if(this.mexcCatalog&&this.clock()-this.mexcCatalogAt<15*M)return this.mexcCatalog;const d=await this.source(v,'/api/v3/exchangeInfo',{},signal);if(!Array.isArray(d.symbols))throw new MarketError('لم تصل قائمة MEXC');this.mexcCatalog=new Map(d.symbols.filter(s=>String(s.status)==='1'&&s.quoteAsset==='USDT'&&s.isSpotTradingAllowed===true).map(s=>[s.symbol,s]));this.mexcCatalogAt=this.clock();return this.mexcCatalog;}
 exclusion(info,v){if(!/^[A-Z0-9]{1,20}USDT$/.test(info.symbol))return 'unsupported-symbol-format';const x=Base.exclusions||{};if(['BTC','ETH'].includes(info.baseAsset))return 'reference';if(x.stable?.has(info.baseAsset))return 'stable-or-metal';if(x.leveraged?.has(info.baseAsset)||info.isETF===true)return 'leveraged';if(x.tokenizedStocks?.has(info.baseAsset))return 'tokenized-security';const evidence=(this.verifiedExclusions||[]).find(x=>x.symbol===info.symbol&&x.venue===name(v)&&Number.isFinite(x.sourceTime)&&this.clock()-x.sourceTime>=0&&this.clock()-x.sourceTime<=30*M);return evidence?'verified-exclusion':null;}
 isExcluded(symbol,venue='Binance Spot'){return (this.verifiedExclusions||[]).some(x=>x.symbol===symbol&&x.venue===venue&&Number.isFinite(x.sourceTime)&&this.clock()-x.sourceTime>=0&&this.clock()-x.sourceTime<=1800000);}
 async screen(v,signal){
  const catalog=await this.catalogFor(v,signal),raw=await this.source(v,'/api/v3/ticker/24hr',{},signal),clock=await this.source(v,'/api/v3/time',{},signal);if(!Number.isFinite(clock.serverTime)||!Array.isArray(raw))throw new MarketError('بيانات أو وقت '+name(v)+' غير صالح');
  let latest=null,priceGap=null;try{const prices=await this.source(v,'/api/v3/ticker/price',{},signal);if(!Array.isArray(prices))throw new MarketError('قائمة الأسعار غير صالحة');latest=new Map(prices.map(p=>[p.symbol,num(p.price)]));}catch(e){if(e.name==='AbortError')throw e;priceGap=e.message;}const at=this.clock(),tickers=new Map(raw.map(t=>[t.symbol,t])),all=[],eligible=[];
  for(const info of catalog.values()){
   const id=key(name(v),info.symbol),t=tickers.get(info.symbol),price=latest?.get(info.symbol)??num(t?.lastPrice),q=num(t?.quoteVolume),baseVol=num(t?.volume),open=num(t?.openPrice),p=num(t?.lastPrice)>0&&open>0?pct(num(t.lastPrice),open):null,previous=this.discoveryPrevious.get(id),elapsed=previous?at-previous.at:null,burst=elapsed>0&&elapsed<=5*M?pct(price,previous.price):null;
   let exclusion=this.exclusion(info,v);if(!t||!(price>0))exclusion=exclusion||'ticker-missing';else if(q===0||q===null&&baseVol===0)exclusion=exclusion||'no-volume';
   const entry={key:id,symbol:info.symbol,venue:name(v),source:v,screenedAt:at,tickerTime:num(t?.closeTime),priceSource:latest?'/api/v3/ticker/price':'/api/v3/ticker/24hr',priceSourceTime:null,price,quoteVolume:q,change24:p,screenPriceChange:burst,screenIntervalMs:elapsed,selected:false,status:exclusion?'excluded':'screened',reason:exclusion||'بانتظار اختيار الفحص العميق',lastCandleAt:this.discoverySeen.get(id)||null,info};
   all.push(entry);if(!exclusion)eligible.push(entry);
   if(price>0)this.discoveryPrevious.set(id,{price,at});
  }
  if(!eligible.length)throw new MarketError('سلة '+name(v)+' فارغة');
  return {source:v,venue:name(v),catalog,tickers,all,eligible,serverTime:clock.serverTime,screenedAt:at,catalogAt:v==='mexc'?this.mexcCatalogAt:this.catalogAt,priceGap};
 }
 select(screen,count,pinned){
  const list=screen.eligible,chosen=[],seen=new Set(),v=screen.source;
  const add=(x,reason)=>{if(x&&!seen.has(x.symbol)){seen.add(x.symbol);x.selected=true;x.reason=reason;chosen.push(x);}};
  for(const p of pinned){const symbol=typeof p==='string'?p:p.symbol,venue=typeof p==='string'?'Binance Spot':p.venue;if(venue===screen.venue)add(list.find(x=>x.symbol===symbol),'متابعة مثبتة');}
  const pinCount=chosen.length,quota=Math.max(4,count),rotate=Math.max(2,Math.ceil(quota*.4)),ranked=pinCount+Math.max(1,quota-rotate),sort=(f)=>[...list].sort((a,b)=>f(b)-f(a)||a.symbol.localeCompare(b.symbol));
  const channels=[sort(x=>Number.isFinite(x.screenPriceChange)?Math.abs(x.screenPriceChange):-Infinity),sort(x=>Number.isFinite(x.change24)?Math.abs(x.change24):-Infinity),sort(x=>x.quoteVolume??-Infinity),sort(x=>Number.isFinite(x.change24)?-Math.abs(x.change24):-Infinity)];
  let cursor=0;while(chosen.length<ranked&&cursor<list.length){for(let c=0;c<channels.length&&chosen.length<ranked;c++)add(channels[c][cursor],['تغير بين لقطتي السوق؛ يحتاج شموعاً','حركة يومية تستحق فحص الامتداد','تداول مرتفع','هدوء سعري مع تداول فعلي'][c]);cursor++;}
  const rotation=[...list].sort((a,b)=>a.symbol.localeCompare(b.symbol));let pos=this.discoveryCursors[v]%rotation.length,walk=0;while(chosen.length<quota+pinCount&&walk<rotation.length){add(rotation[pos],'دور الفحص الدوري لجميع الأزواج المتاحة');pos=(pos+1)%rotation.length;walk++;}this.discoveryCursors[v]=pos;
  return chosen;
 }
 async venueBars(v,symbol,T,signal,count=241){if(v==='binance')return this.bars(symbol,T,signal,count);const raw=await this.source(v,'/api/v3/klines',{symbol,interval:'1m',startTime:T-count*M,endTime:T-1,limit:count},signal),rows=mexcBars(raw,M,count,T-1),at=this.clock(),age=(at-(T-1))/1000;if(age<0||age>120)throw new MarketError('شموع MEXC قديمة أو مستقبلية');return {rows,receivedAt:at,age};}
 makeVenueRow(screen,entry,data,btc){if(screen.source==='binance')return pulse(super.makeRow(entry.symbol,data,btc,screen.tickers.get(entry.symbol)));const frames={};for(const [k,n]of [['1m',1],['5m',5],['15m',15],['30m',30],['1h',60],['4h',240]]){const f=mexcMetrics(data.rows,n),b=mexcMetrics(btc.rows,n);if(f){f.relativeBTC=b?f.r-b.r:null;f.relativeBTCSource='MEXC Spot BTCUSDT';}frames[k]=f;}const row={symbol:entry.symbol,baseAsset:entry.info.baseAsset,venue:screen.venue,price:frames['1m'].close,priceTime:frames['1m'].end,priceKind:'closed1m',context24h:{change:entry.change24,lastPrice:entry.price,quoteVolume:entry.quoteVolume,sourceTime:entry.tickerTime,source:'MEXC Spot ticker/24hr',alignedWithMinuteFrames:false},frames,rvol:null,depth:null,actualTrade:null,derivatives:null,largeTrades:null,freshness:{minuteFresh:true,minuteAgeSeconds:data.age,receivedAt:data.receivedAt},quality:{completeForReview:false,gaps:['MEXC: شراء المنفذين وCVD غير متاحين من الشموع','مقارنة دفتر حديثة لم تُفحص بعد','RVOL لم يُجلب بعد']},identity:{baseAsset:entry.info.baseAsset,name:entry.info.fullName||entry.info.baseAsset,quoteAsset:'USDT',status:entry.info.status,source:'MEXC exchangeInfo',contractAddress:entry.info.contractAddress||null,providerCoinId:null,instrument:'spot-asset',scope:'هوية زوج MEXC؛ لا دمج تلقائي مع رمز منصة أخرى'},candles:{interval:'1m',rows:data.rows.slice(-120)}};return pulse(row);}
 async deepen(row,T,signal){if(row.venue==='Binance Spot'){await this.deepRow(row,T,signal);return pulse(row);}const end=Math.floor(T/H)*H-1;try{const raw=await this.source('mexc','/api/v3/klines',{symbol:row.symbol,interval:'60m',startTime:end+1-49*H,endTime:end,limit:49},signal),hours=mexcBars(raw,H,49,end),den=median(hours.slice(0,-1).map(b=>Number(b[7])));row.rvol=den>0?Number(hours.at(-1)[7])/den:null;row.rvolHourEnd=end;row.frames.native1h=mexcMetrics(hours,1);}catch(e){if(e.name==='AbortError')throw e;row.quality.gaps.push('RVOL: '+e.message);}
 try{const raw=await this.source('mexc','/api/v3/depth',{symbol:row.symbol,limit:1000},signal),at=this.clock(),id=key(row.venue,row.symbol),previous=this.books.get(id),same=previous?{...previous,venue:'Binance Spot'}:null,book=bookMetrics(raw,row.symbol,at,same);book.venue=row.venue;row.depth=book;this.books.set(id,book);}catch(e){if(e.name==='AbortError')throw e;row.quality.gaps.push('الدفتر: '+e.message);}
 row.quality.gaps=row.quality.gaps.filter(x=>!['مقارنة دفتر حديثة لم تُفحص بعد','RVOL لم يُجلب بعد'].includes(x));if(!row.depth?.ranges?.['1%']?.comparable)row.quality.gaps.push('تقاطع غير مكتمل: مقارنة عمق صالحة غير متاحة');if(row.rvol===null)row.quality.gaps.push('RVOL غير متاح');return pulse(row);
 }
 async scan({limit=50,pinned=[],deepLimit=8,signal:external}={}){
  if(this.busy)throw new MarketError('فحص جارٍ بالفعل');this.busy=true;this.controller=new AbortController();const signal=this.controller.signal,abort=()=>this.cancel();external?.addEventListener('abort',abort,{once:true});if(external?.aborted)abort();this.requests=[];this.failureStreak=0;this.research.requests=[];this.research.failures={};const startedAt=this.clock(),rows=[],errors=[],sources=[],all=[];
  try{
   const screened=await Promise.allSettled(['binance','mexc'].map(v=>this.screen(v,signal)));
   for(let i=0;i<screened.length;i++){const r=screened[i],v=['binance','mexc'][i];if(r.status==='fulfilled'){sources.push(r.value);all.push(...r.value.all);}else{if(r.reason.name==='AbortError')throw r.reason;errors.push({venue:name(v),stage:'screen',message:r.reason.message});}}
   if(!sources.length)throw new MarketError('تعذر تحديث البيانات على Binance وMEXC');
   const T=Math.floor(Math.min(...sources.map(s=>s.serverTime))/M)*M;if(this.clock()-(T-1)<0||this.clock()-(T-1)>120000)throw new MarketError('نهاية المسح المشتركة قديمة أو مستقبلية');
   const refs={};for(const s of sources){try{refs[s.source]=await this.venueBars(s.source,'BTCUSDT',T,signal);}catch(e){if(e.name==='AbortError')throw e;errors.push({venue:s.venue,symbol:'BTCUSDT',message:'تعذر مرجع BTC: '+e.message});}}
   const usable=sources.filter(s=>refs[s.source]);if(!usable.length)throw new MarketError('تعذر تحديث مرجع BTC؛ لا عوائد نسبية من بيانات ناقصة');
   const count=Math.min(200,Math.max(20,Number(limit)||50)),pins=[...pinned,...this.pinnedVenues,...[...this.followups.values()].filter(p=>p.until>this.clock()).slice(0,24)],picked=usable.flatMap(s=>this.select(s,Math.ceil(count/usable.length),pins).map(entry=>({s,entry}))),byVenue=Object.fromEntries(sources.map(s=>[s.source,{venue:s.venue,activePairs:s.all.length,eligiblePairs:s.eligible.length,screened:s.all.length,catalogAt:s.catalogAt,screenedAt:s.screenedAt,selected:picked.filter(x=>x.s===s).length,valid:0,deep:0,referenceAvailable:!!refs[s.source],fastPriceGap:s.priceGap}]));
   let done=0;this.onProgress({stage:'candles',done,total:picked.length});
   await this.pool(picked,async({s,entry})=>{try{if(this.clock()-startedAt>75000)throw new MarketError('انتهت ميزانية وقت الدورة؛ يعود الزوج للدورة اللاحقة');const data=await this.venueBars(s.source,entry.symbol,T,signal),row=this.makeVenueRow(s,entry,data,refs[s.source]);row.discoveryReason=entry.reason;rows.push(row);entry.status='observed';entry.lastCandleAt=T-1;this.discoverySeen.set(entry.key,T-1);byVenue[s.source].valid++;}catch(e){if(e.name==='AbortError')throw e;entry.status='candle-failed';entry.reason=e.message;errors.push({symbol:entry.symbol,venue:s.venue,message:e.message});}this.onProgress({stage:'candles',done:++done,total:picked.length});},signal,4);
   rows.sort((a,b)=>b.priority-a.priority||b.frames['1h'].q-a.frames['1h'].q);
   const targetKeys=new Set(rows.slice(0,Math.min(20,Math.max(0,deepLimit))).map(r=>key(r.venue,r.symbol)));
   for(const p of pins){const sym=typeof p==='string'?p:p.symbol,v=typeof p==='string'?'Binance Spot':p.venue;targetKeys.add(key(v,sym));}
   // Reserve one book per surviving venue, even when one exchange dominates ranking.
   for(const v of ['Binance Spot','MEXC Spot']){const first=rows.find(r=>r.venue===v);if(first&&deepLimit>0)targetKeys.add(key(v,first.symbol));}
   const targets=rows.filter(r=>targetKeys.has(key(r.venue,r.symbol)));done=0;
   await this.pool(targets,async r=>{if(this.clock()-startedAt<=85000)await this.deepen(r,T,signal);else r.quality.gaps.push('تعذر تعميق الفحص ضمن ميزانية وقت الدورة');this.onProgress({stage:'depth',done:++done,total:targets.length});},signal,2);
   const at=this.clock();for(const [id,p]of this.followups)if(p.until<=at)this.followups.delete(id);for(const r of rows){r.freshness.minuteAgeSeconds=(at-r.priceTime)/1000;r.freshness.minuteFresh=r.freshness.minuteAgeSeconds>=0&&r.freshness.minuteAgeSeconds<=120;if(!r.freshness.minuteFresh){r.status='incomplete';r.label='بيانات قديمة';r.notifyEligible=false;}const id=key(r.venue,r.symbol);if(r.notifyEligible&&r.freshness.minuteFresh&&this.followups.size<24)this.followups.set(id,{symbol:r.symbol,venue:r.venue,until:at+10*M});else if(!r.notifyEligible)this.followups.delete(id);if(r.depth)byVenue[r.venue==='MEXC Spot'?'mexc':'binance'].deep++;}
   rows.sort((a,b)=>b.priority-a.priority||b.frames['1h'].q-a.frames['1h'].q);
   const refScreen=usable.find(s=>s.source==='binance')||usable[0],btcEntry={symbol:'BTCUSDT',info:refScreen.catalog.get('BTCUSDT'),change24:null,price:null,quoteVolume:null,tickerTime:null},btc=this.makeVenueRow(refScreen,btcEntry,refs[refScreen.source],refs[refScreen.source]);
   const coverage={version:'wide-v1',requested:picked.length,valid:rows.length,deep:rows.filter(r=>r.depth).length,marketPairs:sources.reduce((n,s)=>n+s.eligible.length,0),screened:all.length,limit,byVenue,sourceFailures:errors.filter(e=>e.stage==='screen'),rollingObserved:all.filter(x=>x.lastCandleAt&&at-x.lastCandleAt>=0&&at-x.lastCandleAt<=60*M).length,policy:'كشف أولي لجميع أزواج Spot/USDT النشطة المتاحة عبر API على المنصتين؛ شموع لميزانية الدورة، منها40% دورية. لا مسح شموع كامل في كل دقيقة. لا جمع أحجام بين المنصتين. إحصاءات MEXC قد تتجدد كل5دقائق؛ الإشارة من شموع حديثة.',audit:all.map(({info,...a})=>a)};
   this.lastCoverage=coverage;
   return {startedAt,receivedAt:at,cutoff:T-1,serverTime:Math.min(...sources.map(s=>s.serverTime)),btc,btcByVenue:Object.fromEntries(usable.map(s=>[s.venue,{cutoff:T-1,source:s.venue,symbol:'BTCUSDT'}])),rows,coverage,errors,warnings:errors.length?['التغطية جزئية؛ راجع المصدر والزوج في سجل التغطية']:[],sourceRequests:[...this.requests,...this.research.requests]};
  }finally{external?.removeEventListener('abort',abort);this.busy=false;this.controller=null;}
 }
 async inspect(symbol,options={}){
  if(options.venue!=='MEXC Spot')return pulse(await super.inspect(symbol,options));
  if(this.busy)throw new MarketError('انتظر اكتمال المسح');this.busy=true;this.controller=new AbortController();const signal=this.controller.signal;this.research.failures={};const abort=()=>this.cancel();options.signal?.addEventListener('abort',abort,{once:true});
  try{const catalog=await this.catalogFor('mexc',signal),sym=this.normalize(symbol),info=catalog.get(sym);if(!info)throw new MarketError('لا يوجد زوج MEXC Spot/USDT نشط متاح بهذا الرمز');const time=await this.source('mexc','/api/v3/time',{},signal),T=Math.floor(time.serverTime/M)*M;if(!Number.isFinite(T))throw new MarketError('وقت MEXC غير صالح');const ticker=await this.source('mexc','/api/v3/ticker/24hr',{symbol:sym},signal),data=await this.venueBars('mexc',sym,T,signal),btc=sym==='BTCUSDT'?data:await this.venueBars('mexc','BTCUSDT',T,signal),entry={symbol:sym,info,change24:pct(num(ticker.lastPrice),num(ticker.openPrice)),quoteVolume:num(ticker.quoteVolume),price:num(ticker.lastPrice),tickerTime:num(ticker.closeTime)},screen={source:'mexc',venue:'MEXC Spot',tickers:new Map([[sym,ticker]])};const row=this.makeVenueRow(screen,entry,data,btc);await this.deepen(row,T,signal);return row;}finally{options.signal?.removeEventListener('abort',abort);this.busy=false;this.controller=null;}
 }
}
WideEngine.helpers={...Base.helpers,wide:{mexcBars,mexcMetrics,pulse,key}};WideEngine.Base=Base;global.SIVMarketEngine=WideEngine;if(typeof module!=='undefined'&&module.exports)module.exports=WideEngine;
})(typeof window!=='undefined'?window:globalThis);
