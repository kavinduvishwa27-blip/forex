// ═══════════════════════════════════════════════════════════════════════
//  MarketPulse Pro — 8-Strategy Confluence Engine
//
//  Price Data : Binance REST + WebSocket (crypto & forex pairs)
//               Kraken REST (JPY, CAD, CHF, EUR/JPY pairs)
//  News       : Finnhub (if key set) → CryptoCompare fallback (always free)
//  Analysis   : 8 independent strategies, weighted master signal
//  TP/SL/Entry: Computed ONCE in computeMasterSignal(), shared everywhere
// ═══════════════════════════════════════════════════════════════════════

// ─── OPTIONAL FINNHUB KEY ─────────────────────────────────────────────
// Paste your free Finnhub key here for better news coverage.
// Get one free at https://finnhub.io/register
// Leave empty string to use CryptoCompare (always works, crypto-only news)
const FINNHUB_KEY = localStorage.getItem('mp_fh_key') || '';

function saveFinnhubKey() {
    const k = ($('fhKeyInput').value || '').trim();
    if (k.length > 6) {
        localStorage.setItem('mp_fh_key', k);
        location.reload();
    }
}
function openSettings() {
    const p = $('settingsPanel');
    if (p) { p.classList.toggle('hidden'); $('fhKeyInput').value = FINNHUB_KEY; }
}

// ─── BACKGROUND MUSIC ─────────────────────────────────────────────────
// Track 1 (music2.webm) — plays on page open (skipped if coming from intro)
// Track 2 (music.webm)  — plays when XAU/USD or EUR/USD is opened
(function() {
    const track1 = document.getElementById('bgMusic');   // music2.webm
    const track2 = document.getElementById('bgMusic2');  // music.webm
    if (!track1) return;
    track1.volume = 0.80;
    if (track2) track2.volume = 0.80;

    // Skip track1 if user just came from intro.html (already heard it)
    const fromIntro = document.referrer && document.referrer.includes('intro.html');
    if (fromIntro) return;

    // Autoplay track1 on page open
    const play1 = track1.play();
    if (play1 !== undefined) {
        play1.catch(() => {
            const resume = () => {
                track1.play().catch(() => {});
                ['click','scroll','keydown','touchstart'].forEach(ev =>
                    document.removeEventListener(ev, resume)
                );
            };
            ['click','scroll','keydown','touchstart'].forEach(ev =>
                document.addEventListener(ev, resume, { once: true, passive: true })
            );
        });
    }
})();

// Play track2 when XAU/USD or EUR/USD is selected
function playFavMusic() {
    const track2 = document.getElementById('bgMusic2');
    if (!track2) return;
    track2.currentTime = 0;
    track2.volume = 0.80;
    track2.play().catch(() => {});
}

// ─── ASSET REGISTRY ───────────────────────────────────────────────────
const ASSETS = {
    'BTCUSDT':  { type:'binance', name:'Bitcoin',    sym:'BTC/USD', logo:'https://cryptologos.cc/logos/bitcoin-btc-logo.png',       volLabel:'Vol (BTC)', decimals:2 },
    'ETHUSDT':  { type:'binance', name:'Ethereum',   sym:'ETH/USD', logo:'https://cryptologos.cc/logos/ethereum-eth-logo.png',      volLabel:'Vol (ETH)', decimals:2 },
    'SOLUSDT':  { type:'binance', name:'Solana',     sym:'SOL/USD', logo:'https://cryptologos.cc/logos/solana-sol-logo.png',        volLabel:'Vol (SOL)', decimals:2 },
    'BNBUSDT':  { type:'binance', name:'BNB',        sym:'BNB/USD', logo:'https://cryptologos.cc/logos/bnb-bnb-logo.png',           volLabel:'Vol (BNB)', decimals:2 },
    'XRPUSDT':  { type:'binance', name:'Ripple',     sym:'XRP/USD', logo:'https://cryptologos.cc/logos/xrp-xrp-logo.png',          volLabel:'Vol (XRP)', decimals:4 },
    'EURUSDT':  { type:'binance', name:'EUR/USD',    sym:'EUR/USD', logo:'https://flagcdn.com/w80/eu.png',                          volLabel:'Volume',    decimals:4 },
    'GBPUSDT':  { type:'binance', name:'GBP/USD',    sym:'GBP/USD', logo:'https://flagcdn.com/w80/gb.png',                          volLabel:'Volume',    decimals:4 },
    'AUDUSDT':  { type:'binance', name:'AUD/USD',    sym:'AUD/USD', logo:'https://flagcdn.com/w80/au.png',                          volLabel:'Volume',    decimals:4 },
    'NZDUSDT':  { type:'binance', name:'NZD/USD',    sym:'NZD/USD', logo:'https://flagcdn.com/w80/nz.png',                          volLabel:'Volume',    decimals:4 },
    'USDJPY':   { type:'kraken',  name:'USD/JPY',    sym:'USD/JPY', logo:'https://flagcdn.com/w80/jp.png',                          volLabel:'Volume',    decimals:3, krakenId:'USDJPY' },
    'USDCAD':   { type:'kraken',  name:'USD/CAD',    sym:'USD/CAD', logo:'https://flagcdn.com/w80/ca.png',                          volLabel:'Volume',    decimals:4, krakenId:'USDCAD' },
    'USDCHF':   { type:'kraken',  name:'USD/CHF',    sym:'USD/CHF', logo:'https://flagcdn.com/w80/ch.png',                          volLabel:'Volume',    decimals:4, krakenId:'USDCHF' },
    'EURJPY':   { type:'kraken',  name:'EUR/JPY',    sym:'EUR/JPY', logo:'https://flagcdn.com/w80/eu.png',                          volLabel:'Volume',    decimals:3, krakenId:'EURJPY' },
    'PAXGUSDT': { type:'binance', name:'Gold (XAU)', sym:'XAU/USD', logo:'https://cdn-icons-png.flaticon.com/512/1694/1694364.png',  volLabel:'Vol (oz)', decimals:2 },
};

// Kraken interval map
const KRAKEN_IV = iv => ({'5m':'5','15m':'15','1h':'60','4h':'240','1d':'1440'}[iv] || '240');

// ─── STATE ────────────────────────────────────────────────────────────
let currentSymbol    = 'BTCUSDT';
let currentInterval  = '4h';
let latestClosePrice = 0;
let priceChart, macdChart, rsiChart;
let activeWebSocket  = null;
let wsReconnectTimer = null;
let statsInterval    = null;
let histInterval     = null;
let newsInterval     = null;
let prevPrice        = 0;
let lastSignalKey    = '';
let soundEnabled     = false;
let audioCtx         = null;
const layerVisible   = { price:true, ema20:true, ema50:true, bbUp:true };

// ─── HELPERS ──────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
function safeText(id, val) { const el=$(id); if(el) el.textContent = val; }
function fmtPrice(p, dec) {
    if(p === null || p === undefined || isNaN(p)) return '--';
    return p.toLocaleString(undefined, { minimumFractionDigits:dec, maximumFractionDigits:dec });
}

// ─── SOUND ────────────────────────────────────────────────────────────
function toggleSound() {
    soundEnabled = !soundEnabled;
    const icon=$('soundIcon'), btn=$('soundToggle');
    if(soundEnabled) { icon.className='fa-solid fa-bell'; btn.classList.add('on'); playTone(440,'sine',0.1,0.15); }
    else             { icon.className='fa-solid fa-bell-slash'; btn.classList.remove('on'); }
}
function playTone(freq, type, vol, dur) {
    try {
        if(!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const o=audioCtx.createOscillator(), g=audioCtx.createGain();
        o.connect(g); g.connect(audioCtx.destination);
        o.type=type; o.frequency.setValueAtTime(freq, audioCtx.currentTime);
        g.gain.setValueAtTime(vol, audioCtx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime+dur);
        o.start(); o.stop(audioCtx.currentTime+dur);
    } catch(e) {}
}
function playSignalSound(type) {
    if(!soundEnabled) return;
    if(type==='buy')  { playTone(523,'sine',0.18,0.12); setTimeout(()=>playTone(659,'sine',0.18,0.15),130); setTimeout(()=>playTone(784,'sine',0.18,0.22),280); }
    else if(type==='sell') { playTone(784,'sine',0.18,0.12); setTimeout(()=>playTone(659,'sine',0.18,0.15),130); setTimeout(()=>playTone(523,'sine',0.18,0.22),280); }
    else { playTone(440,'triangle',0.1,0.2); }
}

// ─── TOAST ────────────────────────────────────────────────────────────
function showToast(word, sub, color) {
    const t=$('signalToast'), inner=$('toastInner');
    safeText('toastText', word); safeText('toastSub', sub);
    if(inner && color) inner.style.borderColor = color;
    t.classList.remove('hidden');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.add('hidden'), 5000);
}

// ═══════════════════════════════════════════════════════════════════════
//  MATH ENGINE
// ═══════════════════════════════════════════════════════════════════════
function calcEMA(data, period) {
    if(data.length < period) return Array(data.length).fill(null);
    const k = 2/(period+1), result = Array(period-1).fill(null);
    let ema = data.slice(0,period).reduce((a,b)=>a+b,0)/period;
    result.push(ema);
    for(let i=period; i<data.length; i++) { ema = data[i]*k + ema*(1-k); result.push(ema); }
    return result;
}
function calcSMA(data, period) {
    return data.map((_,i) => i<period-1 ? null : data.slice(i-period+1,i+1).reduce((a,b)=>a+b,0)/period);
}
function calcRSI(data, period=14) {
    if(data.length < period+1) return 50;
    let ag=0, al=0;
    for(let i=1; i<=period; i++) { const d=data[i]-data[i-1]; if(d>0) ag+=d; else al+=Math.abs(d); }
    ag/=period; al/=period;
    for(let i=period+1; i<data.length; i++) {
        const d=data[i]-data[i-1];
        ag=(ag*(period-1)+Math.max(d,0))/period;
        al=(al*(period-1)+Math.max(-d,0))/period;
    }
    return al===0 ? 100 : 100-100/(1+ag/al);
}
function calcRSISeries(data, period=14) {
    const result = Array(period).fill(null);
    let ag=0, al=0;
    for(let i=1; i<=period; i++) { const d=data[i]-data[i-1]; if(d>0) ag+=d; else al+=Math.abs(d); }
    ag/=period; al/=period;
    result.push(al===0 ? 100 : 100-100/(1+ag/al));
    for(let i=period+1; i<data.length; i++) {
        const d=data[i]-data[i-1];
        ag=(ag*(period-1)+Math.max(d,0))/period;
        al=(al*(period-1)+Math.max(-d,0))/period;
        result.push(al===0 ? 100 : 100-100/(1+ag/al));
    }
    return result;
}
function calcMACD(data, fast=12, slow=26, signal=9) {
    const ef=calcEMA(data,fast), es=calcEMA(data,slow);
    const ml=ef.map((v,i)=>(v!==null&&es[i]!==null)?v-es[i]:null);
    const valid=ml.filter(v=>v!==null);
    const sr=calcEMA(valid,signal);
    const sl=Array(ml.length-valid.length).fill(null).concat(sr);
    return { macdLine:ml, signalLine:sl, histogram:ml.map((v,i)=>(v!==null&&sl[i]!==null)?v-sl[i]:null) };
}
function calcBollingerBands(data, period=20, mult=2) {
    const sma=calcSMA(data,period), upper=[], lower=[];
    for(let i=0; i<data.length; i++) {
        if(i<period-1) { upper.push(null); lower.push(null); continue; }
        const slice=data.slice(i-period+1,i+1), mean=sma[i];
        const std=Math.sqrt(slice.reduce((s,v)=>s+(v-mean)**2,0)/period);
        upper.push(mean+mult*std); lower.push(mean-mult*std);
    }
    return { upper, lower, mid:sma };
}
function calcATR(highs, lows, closes, period=14) {
    if(highs.length < 2) return 0;
    const trs=[];
    for(let i=1; i<highs.length; i++)
        trs.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
    return trs.slice(-period).reduce((a,b)=>a+b,0)/period;
}
function calcStochastic(highs, lows, closes, period=14) {
    const k=[];
    for(let i=0; i<closes.length; i++) {
        if(i<period-1) { k.push(null); continue; }
        const hi=Math.max(...highs.slice(i-period+1,i+1)), lo=Math.min(...lows.slice(i-period+1,i+1));
        k.push(hi===lo ? 50 : ((closes[i]-lo)/(hi-lo))*100);
    }
    const vk=k.filter(v=>v!==null), d=calcSMA(vk,3);
    return { k:vk[vk.length-1]??50, d:d[d.length-1]??50 };
}
function calcADX(highs, lows, closes, period=14) {
    if(closes.length < period+2) return { adx:20, plusDI:20, minusDI:20 };
    const trs=[], pDMs=[], mDMs=[];
    for(let i=1; i<highs.length; i++) {
        trs.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
        const up=highs[i]-highs[i-1], dn=lows[i-1]-lows[i];
        pDMs.push(up>dn&&up>0?up:0); mDMs.push(dn>up&&dn>0?dn:0);
    }
    const atrS=trs.slice(-period).reduce((a,b)=>a+b,0)/period;
    const pS=pDMs.slice(-period).reduce((a,b)=>a+b,0)/period;
    const mS=mDMs.slice(-period).reduce((a,b)=>a+b,0)/period;
    const pDI=atrS>0?(pS/atrS)*100:0, mDI=atrS>0?(mS/atrS)*100:0;
    return { adx:pDI+mDI>0?Math.abs(pDI-mDI)/(pDI+mDI)*100:0, plusDI:pDI, minusDI:mDI };
}
function calcOBV(closes, volumes) {
    if(!volumes || volumes.every(v=>v===0)) return null;
    const obv=[0];
    for(let i=1; i<closes.length; i++)
        obv.push(closes[i]>closes[i-1] ? obv[obv.length-1]+volumes[i] : closes[i]<closes[i-1] ? obv[obv.length-1]-volumes[i] : obv[obv.length-1]);
    return obv;
}
function calcWilliamsR(highs, lows, closes, period=14) {
    const n=closes.length; if(n<period) return -50;
    const hi=Math.max(...highs.slice(-period)), lo=Math.min(...lows.slice(-period));
    return hi===lo ? -50 : ((hi-closes[n-1])/(hi-lo))*-100;
}
function calcCCI(highs, lows, closes, period=20) {
    const tp=closes.map((_,i)=>(highs[i]+lows[i]+closes[i])/3);
    const last=tp.slice(-period), mean=last.reduce((a,b)=>a+b,0)/period;
    const mad=last.reduce((s,v)=>s+Math.abs(v-mean),0)/period;
    return mad===0 ? 0 : (tp[tp.length-1]-mean)/(0.015*mad);
}
function calcPivots(h, l, c) {
    const pp=(h+l+c)/3;
    return { pp, r1:2*pp-l, r2:pp+(h-l), s1:2*pp-h, s2:pp-(h-l) };
}
function calcIchimoku(highs, lows) {
    if(highs.length < 52) return null;
    const t9h=Math.max(...highs.slice(-9)), t9l=Math.min(...lows.slice(-9));
    const k26h=Math.max(...highs.slice(-26)), k26l=Math.min(...lows.slice(-26));
    const b52h=Math.max(...highs.slice(-52)), b52l=Math.min(...lows.slice(-52));
    const tenkan=(t9h+t9l)/2, kijun=(k26h+k26l)/2;
    const spanA=(tenkan+kijun)/2, spanB=(b52h+b52l)/2;
    return { tenkan, kijun, spanA, spanB, bullCloud:spanA>spanB, tkBull:tenkan>kijun };
}
function detectCandlePatterns(opens, highs, lows, closes) {
    const n=closes.length; if(n<3) return [];
    const patterns=[], i=n-1;
    const body=j=>Math.abs(closes[j]-opens[j]);
    const lw=j=>Math.min(closes[j],opens[j])-lows[j];
    const uw=j=>highs[j]-Math.max(closes[j],opens[j]);
    const bull=j=>closes[j]>opens[j], bear=j=>closes[j]<opens[j];
    if(lw(i)>body(i)*2 && uw(i)<body(i)*0.5 && body(i)>0) patterns.push({dir:'bull',name:'Hammer',strength:2,note:'Long lower wick — reversal signal'});
    if(uw(i)>body(i)*2 && lw(i)<body(i)*0.5 && body(i)>0) patterns.push({dir:'bear',name:'Shooting Star',strength:2,note:'Long upper wick — reversal at top'});
    if(n>=2&&bear(i-1)&&bull(i)&&closes[i]>opens[i-1]&&opens[i]<closes[i-1]) patterns.push({dir:'bull',name:'Bullish Engulfing',strength:3,note:'Full body reversal candle'});
    if(n>=2&&bull(i-1)&&bear(i)&&closes[i]<opens[i-1]&&opens[i]>closes[i-1]) patterns.push({dir:'bear',name:'Bearish Engulfing',strength:3,note:'Full body reversal candle'});
    if(body(i)<(highs[i]-lows[i])*0.1&&(highs[i]-lows[i])>0) patterns.push({dir:'neut',name:'Doji',strength:1,note:'Indecision — watch for direction'});
    if(n>=3&&bull(i)&&bull(i-1)&&bull(i-2)&&closes[i]>closes[i-1]&&closes[i-1]>closes[i-2]) patterns.push({dir:'bull',name:'Three White Soldiers',strength:3,note:'Strong uptrend confirmation'});
    if(n>=3&&bear(i)&&bear(i-1)&&bear(i-2)&&closes[i]<closes[i-1]&&closes[i-1]<closes[i-2]) patterns.push({dir:'bear',name:'Three Black Crows',strength:3,note:'Strong downtrend confirmation'});
    return patterns;
}

// ═══════════════════════════════════════════════════════════════════════
//  8 STRATEGIES
// ═══════════════════════════════════════════════════════════════════════
function scoreToDir(norm) {
    if(norm>=0.55)  return 'BUY';
    if(norm<=-0.55) return 'SELL';
    if(norm>=0.22)  return 'LEAN BUY';
    if(norm<=-0.22) return 'LEAN SELL';
    return 'HOLD';
}

function s1_Trend({price, ema20v, ema50v, ema200v, adx}) {
    let s=0; const notes=[];
    if(price>ema20v&&ema20v>ema50v)       { s+=2.5; notes.push('Alpha sequence: Price > EMA20 > EMA50'); }
    else if(price<ema20v&&ema20v<ema50v)  { s-=2.5; notes.push('Beta sequence: Price < EMA20 < EMA50'); }
    else if(ema20v>ema50v)                { s+=1;   notes.push('EMA20 > EMA50 — structural uptrend validated'); }
    else                                  { s-=1;   notes.push('EMA20 < EMA50 — structural downtrend validated'); }
    if(ema200v) {
        if(price>ema200v) { s+=1; notes.push('Macro vector alignment: Bullish'); }
        else              { s-=1; notes.push('Macro vector alignment: Bearish'); }
    }
    if(adx.adx>30) {
        if(adx.plusDI>adx.minusDI) { s+=1.5; notes.push(`ADX ${adx.adx.toFixed(0)} — hyper-bullish trend velocity`); }
        else                        { s-=1.5; notes.push(`ADX ${adx.adx.toFixed(0)} — hyper-bearish trend velocity`); }
    } else if(adx.adx>20) {
        if(adx.plusDI>adx.minusDI) { s+=0.5; notes.push(`ADX ${adx.adx.toFixed(0)} — emerging bullish momentum`); }
        else                        { s-=0.5; notes.push(`ADX ${adx.adx.toFixed(0)} — emerging bearish momentum`); }
    } else notes.push(`ADX ${adx.adx.toFixed(0)} — consolidated market state`);
    const norm=Math.max(-1,Math.min(1,s/6));
    return {name:'Alpha Trend Vectoring',icon:'fa-chart-line',color:'#00d4ff',dir:scoreToDir(norm),conf:Math.round(Math.abs(norm)*100),notes,raw:s};
}

function s2_Momentum({rsi, stoch, williamsR, cci}) {
    let s=0; const notes=[];
    if(rsi<22)       { s+=3;   notes.push(`RSI ${rsi.toFixed(1)} — extreme algorithmic undervaluation`); }
    else if(rsi<30)  { s+=2;   notes.push(`RSI ${rsi.toFixed(1)} — deep oversold matrix`); }
    else if(rsi>78)  { s-=3;   notes.push(`RSI ${rsi.toFixed(1)} — extreme algorithmic overvaluation`); }
    else if(rsi>70)  { s-=2;   notes.push(`RSI ${rsi.toFixed(1)} — heavy overbought matrix`); }
    else if(rsi>58)  { s+=1;   notes.push(`RSI ${rsi.toFixed(1)} — positive momentum delta`); }
    else if(rsi<42)  { s-=1;   notes.push(`RSI ${rsi.toFixed(1)} — negative momentum delta`); }
    else               notes.push(`RSI ${rsi.toFixed(1)} — momentum equilibrium`);
    if(stoch.k<20&&stoch.k>stoch.d)      { s+=2; notes.push(`Stoch ${stoch.k.toFixed(0)} — bullish divergence protocol`); }
    else if(stoch.k>80&&stoch.k<stoch.d) { s-=2; notes.push(`Stoch ${stoch.k.toFixed(0)} — bearish divergence protocol`); }
    else if(stoch.k<25) { s+=1;   notes.push(`Stoch ${stoch.k.toFixed(0)} — accumulation phase`); }
    else if(stoch.k>75) { s-=1;   notes.push(`Stoch ${stoch.k.toFixed(0)} — distribution phase`); }
    if(williamsR<-85)  { s+=1.5; notes.push(`W%R ${williamsR.toFixed(0)} — deep statistical oversold`); }
    else if(williamsR<-70) { s+=0.8; notes.push(`W%R ${williamsR.toFixed(0)} — localized oversold`); }
    else if(williamsR>-10) { s-=1.5; notes.push(`W%R ${williamsR.toFixed(0)} — deep statistical overbought`); }
    else if(williamsR>-25) { s-=0.8; notes.push(`W%R ${williamsR.toFixed(0)} — localized overbought`); }
    if(cci<-150)      { s+=1.5; notes.push(`CCI ${cci.toFixed(0)} — extreme negative deviation`); }
    else if(cci<-100) { s+=0.8; notes.push(`CCI ${cci.toFixed(0)} — negative deviation`); }
    else if(cci>150)  { s-=1.5; notes.push(`CCI ${cci.toFixed(0)} — extreme positive deviation`); }
    else if(cci>100)  { s-=0.8; notes.push(`CCI ${cci.toFixed(0)} — positive deviation`); }
    const norm=Math.max(-1,Math.min(1,s/9));
    return {name:'Quantum Momentum Oscillators',icon:'fa-gauge-high',color:'#a78bfa',dir:scoreToDir(norm),conf:Math.round(Math.abs(norm)*100),notes:notes.slice(0,4),raw:s};
}

function s3_MACD({macdLast, sigLast, histLast, prevHist, macdLine, signalLine}) {
    if(macdLast===null||sigLast===null) return {name:'Algorithmic Convergence',icon:'fa-wave-square',color:'#fbbf24',dir:'HOLD',conf:0,notes:['Insufficient data topology'],raw:0};
    let s=0; const notes=[];
    const pm=macdLine[macdLine.length-2], ps=signalLine[signalLine.length-2];
    const freshBull=pm!==null&&ps!==null&&pm<=ps&&macdLast>sigLast;
    const freshBear=pm!==null&&ps!==null&&pm>=ps&&macdLast<sigLast;
    if(freshBull)           { s+=4; notes.push('🔔 High-probability bullish structural crossover'); }
    else if(freshBear)      { s-=4; notes.push('🔔 High-probability bearish structural crossover'); }
    else if(macdLast>sigLast) { s+=2; notes.push('MACD logic: Bullish signal dominance'); }
    else                    { s-=2; notes.push('MACD logic: Bearish signal dominance'); }
    if(macdLast>0) { s+=1; notes.push('MACD baseline: Positive territory'); }
    else           { s-=1; notes.push('MACD baseline: Negative territory'); }
    if(histLast!==null&&prevHist!==null) {
        if(histLast>0&&histLast>prevHist)     { s+=1.5; notes.push('Histogram metric: Bullish expansion'); }
        else if(histLast<0&&histLast<prevHist){ s-=1.5; notes.push('Histogram metric: Bearish expansion'); }
        else if(histLast>0)   notes.push('Histogram metric: Bullish exhaustion signals');
        else                  notes.push('Histogram metric: Bearish exhaustion signals');
    }
    const norm=Math.max(-1,Math.min(1,s/6.5));
    return {name:'Algorithmic Convergence',icon:'fa-wave-square',color:'#fbbf24',dir:scoreToDir(norm),conf:Math.round(Math.abs(norm)*100),notes:notes.slice(0,4),raw:s};
}

function s4_Bollinger({price, bbUpV, bbLoV, bbMidV, bbWidth, closes}) {
    if(!bbUpV||!bbLoV) return {name:'Volatility Band Compression',icon:'fa-circle-dot',color:'#94a3b8',dir:'HOLD',conf:0,notes:['Insufficient data arrays'],raw:0};
    let s=0; const notes=[];
    const range=bbUpV-bbLoV, pct=((price-bbLoV)/range)*100;
    if(price<=bbLoV)       { s+=3;   notes.push('Price hitting lower volatility bound — liquidity trap'); }
    else if(price>=bbUpV)  { s-=3;   notes.push('Price hitting upper volatility bound — resistance cluster'); }
    else if(pct<15)        { s+=2;   notes.push(`Bottom 15% dynamic range (${pct.toFixed(0)}%) — accumulation setup`); }
    else if(pct>85)        { s-=2;   notes.push(`Top 85% dynamic range (${pct.toFixed(0)}%) — distribution setup`); }
    else if(price>bbMidV)  { s+=0.5; notes.push('Above VWAP/Midline — structural bullishness'); }
    else                   { s-=0.5; notes.push('Below VWAP/Midline — structural bearishness'); }
    if(bbWidth<1.5)        notes.push(`Volatility squeeze detected (${bbWidth.toFixed(1)}%) — impending kinetic burst`);
    else if(bbWidth>7)     notes.push(`Elevated expansion phase (${bbWidth.toFixed(1)}%) — high kinetic energy`);
    else                   notes.push(`Volatility normalization (${bbWidth.toFixed(1)}%) — standard state`);
    const last3=closes.slice(-3);
    if(last3.every(c=>c>(bbLoV+range*0.75))) notes.push('Riding upper volatility band — trend acceleration');
    else if(last3.every(c=>c<(bbLoV+range*0.25))) notes.push('Riding lower volatility band — downside acceleration');
    const norm=Math.max(-1,Math.min(1,s/4));
    return {name:'Volatility Band Compression',icon:'fa-circle-dot',color:'#94a3b8',dir:scoreToDir(norm),conf:Math.round(Math.abs(norm)*100),notes:notes.slice(0,4),raw:s};
}

function s5_SR({closes, highs, lows, price, atr, dec}) {
    const n=closes.length;
    if(n<3) return {name:'Institutional Liquidity Zones',icon:'fa-layer-group',color:'#f97316',dir:'HOLD',conf:0,notes:['Awaiting volume data'],raw:0};
    let s=0; const notes=[];
    const piv=calcPivots(highs[n-2], lows[n-2], closes[n-2]);
    const prox=atr*0.3;
    if(Math.abs(price-piv.s2)<prox)       { s+=3;   notes.push(`Proximity to S2 order block ${fmtPrice(piv.s2,dec)} — heavy buy side`); }
    else if(Math.abs(price-piv.s1)<prox)  { s+=2;   notes.push(`Proximity to S1 order block ${fmtPrice(piv.s1,dec)} — localized demand`); }
    else if(Math.abs(price-piv.r2)<prox)  { s-=3;   notes.push(`Proximity to R2 order block ${fmtPrice(piv.r2,dec)} — heavy sell side`); }
    else if(Math.abs(price-piv.r1)<prox)  { s-=2;   notes.push(`Proximity to R1 order block ${fmtPrice(piv.r1,dec)} — localized supply`); }
    else if(price>piv.pp)                 { s+=1;   notes.push(`Above macro pivot ${fmtPrice(piv.pp,dec)} — bullish alignment`); }
    else                                  { s-=1;   notes.push(`Below macro pivot ${fmtPrice(piv.pp,dec)} — bearish alignment`); }
    const h20=Math.max(...highs.slice(-20)), l20=Math.min(...lows.slice(-20));
    const rangePct=((price-l20)/(h20-l20))*100;
    if(rangePct<10)      { s+=1.5; notes.push('Deep liquidity sweep at 20-bar lows'); }
    else if(rangePct>90) { s-=1.5; notes.push('Overextended premium at 20-bar highs'); }
    else if(rangePct<35) { s+=0.5; notes.push(`Discount valuation tier (${rangePct.toFixed(0)}%)`); }
    else if(rangePct>65) { s-=0.5; notes.push(`Premium valuation tier (${rangePct.toFixed(0)}%)`); }
    else                   notes.push(`Equilibrium valuation tier (${rangePct.toFixed(0)}%)`);
    const norm=Math.max(-1,Math.min(1,s/4.5));
    return {name:'Institutional Liquidity Zones',icon:'fa-layer-group',color:'#f97316',dir:scoreToDir(norm),conf:Math.round(Math.abs(norm)*100),notes:notes.slice(0,4),raw:s};
}

function s6_Volume({closes, volumes, bbWidth}) {
    let s=0; const notes=[];
    const hasVol=volumes&&volumes.length>0&&volumes.some(v=>v>0);
    if(!hasVol) {
        notes.push('Dark pool flow data unavailable');
        if(bbWidth<2) { s+=0.3; notes.push('Price squeeze — low institutional participation'); }
    } else {
        const obv=calcOBV(closes,volumes);
        if(obv) {
            const obvEMA=calcEMA(obv,10);
            const obvLast=obv[obv.length-1], obvEMAv=obvEMA[obvEMA.length-1];
            if(obvLast>obvEMAv) { s+=2.5; notes.push('OBV > EMA — systemic institutional accumulation'); }
            else                { s-=2.5; notes.push('OBV < EMA — systemic institutional distribution'); }
            const oSlice=obv.slice(-5);
            const slope=(oSlice[oSlice.length-1]-oSlice[0])/5;
            notes.push(slope>0 ? 'Flow delta: Bullish correlation' : 'Flow delta: Bearish divergence');
        }
        const avgVol=volumes.slice(-20).reduce((a,b)=>a+b,0)/20;
        const lastVol=volumes[volumes.length-1];
        const lastClose=closes[closes.length-1], prevClose=closes[closes.length-2];
        if(lastVol>avgVol*2) {
            if(lastClose>prevClose) { s+=1.5; notes.push(`Volume anomaly ${(lastVol/avgVol).toFixed(1)}× — aggressive buying vector`); }
            else                    { s-=1.5; notes.push(`Volume anomaly ${(lastVol/avgVol).toFixed(1)}× — aggressive selling vector`); }
        } else if(lastVol>avgVol*1.4) {
            if(lastClose>prevClose) { s+=0.5; notes.push(`Elevated flow ${(lastVol/avgVol).toFixed(1)}× — sustained up-pressure`); }
            else                    { s-=0.5; notes.push(`Elevated flow ${(lastVol/avgVol).toFixed(1)}× — sustained down-pressure`); }
        } else notes.push('Standardized volume profile — median flow');
    }
    const norm=Math.max(-1,Math.min(1,s/4));
    return {name:'Dark Pool & Volume Flow',icon:'fa-chart-bar',color:'#00e676',dir:scoreToDir(norm),conf:Math.round(Math.abs(norm)*100),notes:notes.slice(0,4),raw:s};
}

function s7_Ichimoku({highs, lows, price}) {
    const ich=calcIchimoku(highs,lows);
    if(!ich) return {name:'Equilibrium Cloud Matrix',icon:'fa-cloud',color:'#67e8f9',dir:'HOLD',conf:0,notes:['Requires extended tensor data'],raw:0};
    let s=0; const notes=[];
    if(ich.tkBull) { s+=2; notes.push('Tenkan > Kijun — structural macro-buy trigger'); }
    else           { s-=2; notes.push('Tenkan < Kijun — structural macro-sell trigger'); }
    const cloudTop=Math.max(ich.spanA,ich.spanB), cloudBot=Math.min(ich.spanA,ich.spanB);
    if(price>cloudTop)      { s+=2.5; notes.push('Price clearing upper cloud boundary — extreme bull metric'); }
    else if(price<cloudBot) { s-=2.5; notes.push('Price losing lower cloud boundary — extreme bear metric'); }
    else                      notes.push('Price trapped in Kumo cloud — high friction zone');
    if(ich.bullCloud) { s+=0.5; notes.push('Future Kumo vector is positive'); }
    else              { s-=0.5; notes.push('Future Kumo vector is negative'); }
    notes.push(price>ich.kijun ? 'Price holding above algorithmic baseline' : 'Price failing algorithmic baseline');
    const norm=Math.max(-1,Math.min(1,s/5));
    return {name:'Equilibrium Cloud Matrix',icon:'fa-cloud',color:'#67e8f9',dir:scoreToDir(norm),conf:Math.round(Math.abs(norm)*100),notes:notes.slice(0,4),raw:s};
}

function s8_PriceAction({opens, highs, lows, closes, price, atr}) {
    const n=closes.length;
    if(n<10||!opens) return {name:'Micro-Structure Price Action',icon:'fa-fire',color:'#fb923c',dir:'HOLD',conf:0,notes:['Insufficient fractal sequence'],raw:0};
    let s=0; const notes=[];
    const patterns=detectCandlePatterns(opens,highs,lows,closes);
    patterns.forEach(p=>{
        if(p.dir==='bull')      { s+=p.strength*0.7; notes.push(`📈 Sequence: ${p.name}`); }
        else if(p.dir==='bear') { s-=p.strength*0.7; notes.push(`📉 Sequence: ${p.name}`); }
        else                      notes.push(`⟺ Matrix: ${p.name}`);
    });
    const h5=highs.slice(-6), l5=lows.slice(-6);
    const hhCount=h5.slice(1).filter((h,i)=>h>h5[i]).length;
    const llCount=l5.slice(1).filter((l,i)=>l<l5[i]).length;
    if(hhCount>=4)      { s+=1.5; notes.push(`Ascending fractal geometry — ${hhCount}/5 sequences`); }
    else if(llCount>=4) { s-=1.5; notes.push(`Descending fractal geometry — ${llCount}/5 sequences`); }
    const highest20=Math.max(...highs.slice(-21,-1)), lowest20=Math.min(...lows.slice(-21,-1));
    if(price>highest20*1.002)     { s+=2; notes.push('Validating breakout above local algorithmic high'); }
    else if(price<lowest20*0.998) { s-=2; notes.push('Validating breakdown below local algorithmic low'); }
    if(notes.length<4) {
        const ra=(closes[n-1]+closes[n-2]+closes[n-3])/3, rb=(closes[n-4]+closes[n-5]+closes[n-6])/3;
        const mom=((ra-rb)/rb)*100;
        if(Math.abs(mom)>0.3) notes.push(`Kinetic thrust: ${mom>0?'+':''}${mom.toFixed(2)}% vs prior node`);
    }
    const norm=Math.max(-1,Math.min(1,s/5));
    return {name:'Micro-Structure Price Action',icon:'fa-fire',color:'#fb923c',dir:scoreToDir(norm),conf:Math.round(Math.abs(norm)*100),notes:notes.slice(0,4),raw:s};
}

// ─── MASTER SIGNAL — SINGLE SOURCE OF TRUTH ──────────────────────────
const WEIGHTS = {
    'Alpha Trend Vectoring':2.2,'Algorithmic Convergence':1.8,'Equilibrium Cloud Matrix':1.6,
    'Quantum Momentum Oscillators':1.4,'Institutional Liquidity Zones':1.4,
    'Volatility Band Compression':1.2,'Micro-Structure Price Action':1.0,'Dark Pool & Volume Flow':0.8
};
function computeMasterSignal(strategies, price, atr, dec) {
    let bullW=0, bearW=0, totalW=0;
    strategies.forEach(s=>{
        const w=WEIGHTS[s.name]||1; totalW+=w;
        if(s.dir==='BUY')       bullW+=w;
        else if(s.dir==='SELL') bearW+=w;
        else if(s.dir==='LEAN BUY')  bullW+=w*0.5;
        else if(s.dir==='LEAN SELL') bearW+=w*0.5;
    });
    const bullPct=(bullW/totalW)*100, bearPct=(bearW/totalW)*100;
    const score=Math.round(Math.max(bullPct,bearPct)/10);
    let dir, color;
    if(bullPct>=65)           { dir='BUY';       color='var(--bull)'; }
    else if(bearPct>=65)      { dir='SELL';      color='var(--bear)'; }
    else if(bullPct-bearPct>=20) { dir='LEAN BUY'; color='rgba(0,230,118,0.85)'; }
    else if(bearPct-bullPct>=20) { dir='LEAN SELL';color='rgba(255,61,90,0.85)'; }
    else                      { dir='HOLD';      color='var(--gold)'; }
    // ── ONE calculation — all UI reads from this object
    const isBull=bullPct>=bearPct;
    const entry=price;
    const tp=isBull ? entry+atr*3.0 : entry-atr*3.0;
    const sl=isBull ? entry-atr*1.5 : entry+atr*1.5;
    const bullCount=strategies.filter(s=>s.dir==='BUY'||s.dir==='LEAN BUY').length;
    const bearCount=strategies.filter(s=>s.dir==='SELL'||s.dir==='LEAN SELL').length;
    return {dir,color,bullPct,bearPct,score,entry,tp,sl,rr:'1 : 2',atr,isBull,bullCount,bearCount};
}

// ═══════════════════════════════════════════════════════════════════════
//  CHART INIT
// ═══════════════════════════════════════════════════════════════════════
function initCharts() {
    const font={family:'Sora,sans-serif',size:11}, grid='rgba(26,37,64,0.8)', tick='#8899b0';
    const pCtx=$('priceChart').getContext('2d');
    const grad=pCtx.createLinearGradient(0,0,0,400);
    grad.addColorStop(0,'rgba(0,212,255,0.25)'); grad.addColorStop(1,'rgba(0,212,255,0)');
    priceChart=new Chart(pCtx,{type:'line',data:{labels:[],datasets:[
        {label:'Price',   data:[],borderColor:'#00d4ff',backgroundColor:grad,borderWidth:2,pointRadius:0,pointHoverRadius:5,fill:true,tension:0.15,order:1},
        {label:'EMA 20',  data:[],borderColor:'#fbbf24',borderWidth:1.5,borderDash:[4,3],pointRadius:0,fill:false,tension:0.2,order:2},
        {label:'EMA 50',  data:[],borderColor:'#a78bfa',borderWidth:1.5,borderDash:[6,4],pointRadius:0,fill:false,tension:0.2,order:3},
        {label:'BB Upper',data:[],borderColor:'rgba(148,163,184,0.5)',borderWidth:1,borderDash:[2,3],pointRadius:0,fill:false,tension:0.2,order:4},
        {label:'BB Lower',data:[],borderColor:'rgba(148,163,184,0.5)',borderWidth:1,borderDash:[2,3],pointRadius:0,fill:'-1',backgroundColor:'rgba(148,163,184,0.04)',tension:0.2,order:5},
    ]},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},animation:{duration:400},
        plugins:{legend:{display:false},tooltip:{backgroundColor:'rgba(13,22,36,0.95)',titleColor:'#e2eaf5',bodyColor:'#8899b0',borderColor:'rgba(0,212,255,0.2)',borderWidth:1,padding:12,
            callbacks:{label:ctx=>{const v=ctx.parsed.y;if(v===null)return null;return ` ${ctx.dataset.label}: ${fmtPrice(v,ASSETS[currentSymbol].decimals)}`;}}}},
        scales:{x:{grid:{color:grid},ticks:{color:tick,maxTicksLimit:10,font}},
                y:{grid:{color:grid},ticks:{color:tick,font,callback:v=>ASSETS[currentSymbol].decimals>=4?v.toFixed(4):'$'+v.toLocaleString(undefined,{maximumFractionDigits:2})}}}}});
    const mCtx=$('macdChart').getContext('2d');
    macdChart=new Chart(mCtx,{type:'bar',data:{labels:[],datasets:[
        {label:'Histogram',data:[],backgroundColor:ctx=>ctx.parsed?.y>=0?'rgba(0,230,118,0.5)':'rgba(255,61,90,0.5)',borderWidth:0,order:3},
        {label:'MACD',  data:[],borderColor:'#00d4ff',borderWidth:1.5,pointRadius:0,fill:false,type:'line',tension:0.2,order:1},
        {label:'Signal',data:[],borderColor:'#fbbf24',borderWidth:1.5,borderDash:[3,2],pointRadius:0,fill:false,type:'line',tension:0.2,order:2},
    ]},options:{responsive:true,maintainAspectRatio:false,animation:{duration:300},
        plugins:{legend:{display:false},tooltip:{enabled:false}},
        scales:{x:{display:false},y:{grid:{color:grid},ticks:{color:tick,maxTicksLimit:4,font:{size:9}}}}}});
    const rCtx=$('rsiChart').getContext('2d');
    rsiChart=new Chart(rCtx,{type:'line',data:{labels:[],datasets:[{label:'RSI',data:[],borderColor:'#00d4ff',borderWidth:1.5,pointRadius:0,fill:false,tension:0.2}]},
        options:{responsive:true,maintainAspectRatio:false,animation:{duration:300},
            plugins:{legend:{display:false},tooltip:{enabled:false}},
            scales:{x:{display:false},y:{min:0,max:100,
                grid:{color:ctx=>{const v=ctx.tick.value;return v===70?'rgba(255,61,90,0.4)':v===30?'rgba(0,230,118,0.4)':grid;}},
                ticks:{color:tick,font:{size:9},callback:v=>[0,30,50,70,100].includes(v)?v:''}}}}});
}

function toggleLayer(layer) {
    layerVisible[layer]=!layerVisible[layer];
    const btn=document.querySelector(`[data-layer="${layer}"]`);
    if(btn) btn.classList.toggle('active',layerVisible[layer]);
    const map={price:0,ema20:1,ema50:2,bbUp:3};
    if(map[layer]!==undefined) {
        priceChart.data.datasets[map[layer]].hidden=!layerVisible[layer];
        if(layer==='bbUp'&&priceChart.data.datasets[4]) priceChart.data.datasets[4].hidden=!layerVisible[layer];
        priceChart.update('none');
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  DATA FETCHING — Binance (primary) + Kraken (forex fallback)
// ═══════════════════════════════════════════════════════════════════════
const bTicker  = sym => `https://api.binance.com/api/v3/ticker/24hr?symbol=${sym}`;
const bKlines  = (sym,iv,lim=200) => `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${iv}&limit=${lim}`;
const bWS      = sym => `wss://stream.binance.com:9443/ws/${sym.toLowerCase()}@ticker`;
const kTicker  = id  => `https://api.kraken.com/0/public/Ticker?pair=${id}`;
const kCandles = (id,iv) => `https://api.kraken.com/0/public/OHLC?pair=${id}&interval=${KRAKEN_IV(iv)}`;

// ── DOM REFS ──────────────────────────────────────────────────────────
const assetSelector = $('assetSelector');
const priceSection  = $('priceSection');
const priceChange   = $('priceChange');
const statHigh      = $('statHigh');
const statLow       = $('statLow');
const statVol       = $('statVol');
const rsiValueEl    = $('rsiValue');
const maValueEl     = $('maValue');
const analysisTextEl= $('analysisText');
const signalSection = $('signalSection');
const signalText    = $('signalText');
const signalSubtext = $('signalSubtext');
const tradeEntry    = $('tradeEntry');
const calcPlaceholder=$('calcPlaceholder');
const calcResults   = $('calcResults');

// ── 24H STATS ─────────────────────────────────────────────────────────
async function fetch24hStats() {
    const asset=ASSETS[currentSymbol];
    const dec=asset.decimals;
    try {
        if(asset.type==='binance') {
            const d=await fetch(bTicker(currentSymbol)).then(r=>r.json());
            if(d.code) throw new Error('Binance error');
            updatePriceUI(parseFloat(d.lastPrice), parseFloat(d.priceChangePercent));
            safeText('statHigh', fmtPrice(parseFloat(d.highPrice),dec));
            safeText('statLow',  fmtPrice(parseFloat(d.lowPrice),dec));
            const v=parseFloat(d.volume);
            safeText('statVol', v>1e6?(v/1e6).toFixed(2)+'M':v>1e3?(v/1e3).toFixed(2)+'K':v.toFixed(2));
        } else {
            const d=await fetch(kTicker(asset.krakenId)).then(r=>r.json());
            if(d.error?.length) throw new Error(d.error[0]);
            const key=Object.keys(d.result)[0], t=d.result[key];
            const last=parseFloat(t.c[0]), open=parseFloat(t.o);
            updatePriceUI(last, ((last-open)/open)*100);
            safeText('statHigh', fmtPrice(parseFloat(t.h[0]),dec));
            safeText('statLow',  fmtPrice(parseFloat(t.l[0]),dec));
            const vol=parseFloat(t.v[0]);
            safeText('statVol', vol===0?'N/A':vol>1e4?(vol/1e3).toFixed(1)+'K':vol.toFixed(2));
        }
    } catch(e) {
        console.warn('Stats error',e);
    }
}

function updatePriceUI(price, changePct) {
    const p=parseFloat(price);
    if(isNaN(p)||p<=0) return;
    const dec=ASSETS[currentSymbol].decimals;
    const fmt=dec>=4 ? p.toFixed(dec) : '$'+p.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
    const wasUp=p>prevPrice;
    if(priceSection) { priceSection.textContent=fmt; }
    if(prevPrice>0 && priceSection) {
        priceSection.className=wasUp?'mono text-5xl font-black text-white tracking-tight mb-2 flash-up':'mono text-5xl font-black text-white tracking-tight mb-2 flash-down';
        setTimeout(()=>{ if(priceSection) priceSection.className='mono text-5xl font-black text-white tracking-tight mb-2'; },700);
    }
    prevPrice=p; latestClosePrice=p;
    if(changePct!==null&&changePct!==undefined&&priceChange) {
        const chg=parseFloat(changePct);
        if(chg>0) priceChange.innerHTML=`<span style="background:rgba(0,230,118,0.12);color:var(--bull);padding:3px 10px;border-radius:6px;font-weight:700;font-size:0.8rem;border:1px solid rgba(0,230,118,0.2)"><i class="fa-solid fa-arrow-trend-up mr-1" style="font-size:0.7rem"></i>+${chg.toFixed(2)}%</span>`;
        else if(chg<0) priceChange.innerHTML=`<span style="background:rgba(255,61,90,0.12);color:var(--bear);padding:3px 10px;border-radius:6px;font-weight:700;font-size:0.8rem;border:1px solid rgba(255,61,90,0.2)"><i class="fa-solid fa-arrow-trend-down mr-1" style="font-size:0.7rem"></i>${chg.toFixed(2)}%</span>`;
        else priceChange.innerHTML=`<span style="color:var(--muted);font-size:0.8rem">0.00%</span>`;
    }
    if(tradeEntry&&document.activeElement!==tradeEntry&&!tradeEntry.value) tradeEntry.placeholder=fmt.replace('$','');
    safeText('lastUpdate', new Date().toLocaleTimeString());
    setLiveStatus(true);
}

function setLiveStatus(on) {
    const dot=$('connDot'), lbl=$('connLabel'), hDot=$('headerLiveDot'), hLbl=$('headerLiveLabel');
    if(on) {
        if(dot) dot.className='live-dot'; if(lbl) lbl.textContent='LIVE';
        if(hDot) hDot.className='live-dot'; if(hLbl) hLbl.textContent='LIVE';
    } else {
        if(dot) dot.className='offline-dot'; if(lbl) lbl.textContent='Connecting…';
        if(hDot) hDot.className='offline-dot'; if(hLbl) hLbl.textContent='LOADING';
    }
}

// ── HISTORICAL DATA + FULL ANALYSIS ───────────────────────────────────
async function fetchHistoricalData() {
    const asset=ASSETS[currentSymbol];
    const dec=asset.decimals;
    let opens=[],highs=[],lows=[],closes=[],volumes=[],times=[];

    try {
        if(asset.type==='binance') {
            // Map our internal interval to Binance format
            const ivMap={'5m':'5m','15m':'15m','1h':'1h','4h':'4h','1d':'1d'};
            // currentInterval is already in Binance format (5m,15m,1h,4h,1d)
            const d=await fetch(bKlines(currentSymbol, currentInterval, 200)).then(r=>r.json());
            if(!Array.isArray(d)||d.code) throw new Error('Binance candles error');
            opens  =d.map(c=>parseFloat(c[1]));
            highs  =d.map(c=>parseFloat(c[2]));
            lows   =d.map(c=>parseFloat(c[3]));
            closes =d.map(c=>parseFloat(c[4]));
            volumes=d.map(c=>parseFloat(c[5]));
            times  =d.map(c=>{ const dt=new Date(c[0]); return currentInterval==='1d'?`${dt.getMonth()+1}/${dt.getDate()}`:`${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`; });
        } else {
            const d=await fetch(kCandles(asset.krakenId, currentInterval)).then(r=>r.json());
            if(d.error?.length) throw new Error(d.error[0]);
            const key=Object.keys(d.result).find(k=>k!=='last');
            const rows=d.result[key].slice(-200);
            opens  =rows.map(c=>parseFloat(c[1]));
            highs  =rows.map(c=>parseFloat(c[2]));
            lows   =rows.map(c=>parseFloat(c[3]));
            closes =rows.map(c=>parseFloat(c[4]));
            volumes=rows.map(c=>parseFloat(c[6]||0));
            times  =rows.map(c=>{ const dt=new Date(c[0]*1000); return currentInterval==='1d'?`${dt.getMonth()+1}/${dt.getDate()}`:`${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`; });
        }

        // Use live WebSocket price if available, otherwise latest close
        const price=latestClosePrice>0 ? latestClosePrice : closes[closes.length-1];
        if(latestClosePrice<=0) updatePriceUI(closes[closes.length-1], null);

        // ── Compute indicators
        const ema20=calcEMA(closes,20), ema50=calcEMA(closes,50), ema200=calcEMA(closes,200);
        const ema20v=ema20[ema20.length-1], ema50v=ema50[ema50.length-1], ema200v=ema200[ema200.length-1];
        const bb=calcBollingerBands(closes,20,2);
        const bbUpV=bb.upper[bb.upper.length-1], bbLoV=bb.lower[bb.lower.length-1], bbMidV=bb.mid[bb.mid.length-1];
        const bbWidth=bbUpV&&bbLoV?((bbUpV-bbLoV)/bbMidV)*100:0;
        const macdData=calcMACD(closes,12,26,9);
        const macdLast=macdData.macdLine[macdData.macdLine.length-1];
        const sigLast=macdData.signalLine[macdData.signalLine.length-1];
        const histLast=macdData.histogram[macdData.histogram.length-1];
        const prevHist=macdData.histogram[macdData.histogram.length-2];
        const rsi=calcRSI(closes,14), rsiSer=calcRSISeries(closes,14);
        const atr=calcATR(highs,lows,closes,14);
        const stoch=calcStochastic(highs,lows,closes,14);
        const adx=calcADX(highs,lows,closes,14);
        const williamsR=calcWilliamsR(highs,lows,closes,14);
        const cci=calcCCI(highs,lows,closes,20);

        // ── Update charts
        priceChart.data.labels=times;
        priceChart.data.datasets[0].data=closes; priceChart.data.datasets[0].label=`${asset.name} Price`;
        priceChart.data.datasets[1].data=ema20;  priceChart.data.datasets[2].data=ema50;
        priceChart.data.datasets[3].data=bb.upper; priceChart.data.datasets[4].data=bb.lower;
        [0,1,2,3,4].forEach(i=>priceChart.data.datasets[i].hidden=i===0?!layerVisible.price:i===1?!layerVisible.ema20:i===2?!layerVisible.ema50:!layerVisible.bbUp);
        priceChart.update('none');
        const sl=60;
        macdChart.data.labels=times.slice(-sl);
        macdChart.data.datasets[0].data=macdData.histogram.slice(-sl);
        macdChart.data.datasets[1].data=macdData.macdLine.slice(-sl);
        macdChart.data.datasets[2].data=macdData.signalLine.slice(-sl);
        macdChart.update('none');
        rsiChart.data.labels=times; rsiChart.data.datasets[0].data=rsiSer; rsiChart.update('none');

        // ── Chart badges
        const rsiEl=$('rsiSignalBadge');
        if(rsiEl){ if(rsi>70){rsiEl.textContent='OVERBOUGHT';rsiEl.className='ind-badge ind-bear ml-auto';}else if(rsi<30){rsiEl.textContent='OVERSOLD';rsiEl.className='ind-badge ind-bull ml-auto';}else{rsiEl.textContent=`RSI ${rsi.toFixed(1)}`;rsiEl.className='ind-badge ind-neut ml-auto';}}
        const macdEl=$('macdSignalBadge');
        if(macdEl&&macdLast!==null&&sigLast!==null){
            const pm=macdData.macdLine[macdData.macdLine.length-2], ps=macdData.signalLine[macdData.signalLine.length-2];
            const x=pm!==null&&ps!==null&&((pm<ps&&macdLast>sigLast)||(pm>ps&&macdLast<sigLast));
            macdEl.textContent=x?(macdLast>sigLast?'🔔 BULL CROSS':'🔔 BEAR CROSS'):(macdLast>sigLast?'BULLISH':'BEARISH');
            macdEl.className=`ind-badge ml-auto ${macdLast>sigLast?'ind-bull':'ind-bear'}`;
        }

        // ── Mini values
        if(rsiValueEl){ rsiValueEl.textContent=rsi.toFixed(2); rsiValueEl.style.color=rsi>70?'var(--bear)':rsi<30?'var(--bull)':'#e2eaf5'; }
        if(maValueEl) maValueEl.textContent=ema20v!==null?fmtPrice(ema20v,dec):'--';
        const mv=$('macdValue'); if(mv){ mv.textContent=macdLast!==null?(macdLast>0?'+':'')+macdLast.toFixed(dec>=4?5:2):'--'; mv.style.color=macdLast>0?'var(--bull)':'var(--bear)'; }
        safeText('bbValue', bbWidth.toFixed(2)+'%');
        safeText('chartInfoText', `ATR:${fmtPrice(atr,dec)} · ADX:${adx.adx.toFixed(0)} · W%R:${williamsR.toFixed(0)} · CCI:${cci.toFixed(0)}`);

        // ── Full indicator panel
        renderIndicatorPanel({rsi,ema20v,ema50v,price,macdLast,sigLast,histLast,prevHist,bbUpV,bbLoV,bbMidV,atr,stoch,dec,bbWidth,adx,williamsR,cci});

        // ══ RUN ALL 8 STRATEGIES ══
        const strategies=[
            s1_Trend({price,ema20v,ema50v,ema200v,adx}),
            s2_Momentum({rsi,stoch,williamsR,cci}),
            s3_MACD({macdLast,sigLast,histLast,prevHist,macdLine:macdData.macdLine,signalLine:macdData.signalLine}),
            s4_Bollinger({price,bbUpV,bbLoV,bbMidV,bbWidth,closes}),
            s5_SR({closes,highs,lows,price,atr,dec}),
            s6_Volume({closes,volumes,bbWidth}),
            s7_Ichimoku({highs,lows,price}),
            s8_PriceAction({opens,highs,lows,closes,price,atr}),
        ];
        const master=computeMasterSignal(strategies,price,atr,dec);

        // ── Render all UI — master is the single source for all levels
        renderStrategyCards(strategies,master);
        renderMasterVerdict(master,adx,dec);
        updateBanner(master,strategies,rsi,ema20v,ema50v,macdLast,sigLast,stoch,dec,adx);
        updateSmallSignalCard(master);

        // ── Analysis labels
        const tf=currentInterval.toUpperCase();
        safeText('analysisTimeframe',tf);
        const itf=$('indicatorTimeframe'); if(itf) itf.textContent=tf;
        safeText('trendLabel', ema20v&&ema50v?(ema20v>ema50v?'↑ Uptrend':'↓ Downtrend'):'Unclear');
        if($('trendLabel')) $('trendLabel').style.color=ema20v>ema50v?'var(--bull)':'var(--bear)';
        safeText('momentumLabel', rsi>55?'⬆ Strong':rsi<45?'⬇ Weak':'↔ Neutral');
        if($('momentumLabel')) $('momentumLabel').style.color=rsi>55?'var(--bull)':rsi<45?'var(--bear)':'var(--gold)';
        safeText('volatilityLabel', bbWidth>4?'High':bbWidth>2?'Medium':'Low');
        if(analysisTextEl) analysisTextEl.innerHTML=`<strong style="color:#e2eaf5">${asset.name} (${tf}):</strong> Master signal <strong style="color:${master.color}">${master.dir}</strong> — ${master.bullPct.toFixed(0)}% bull · ${master.bearPct.toFixed(0)}% bear · Score ${master.score}/10.<br><span style="color:var(--muted)">${master.bullCount}/8 bullish · ${master.bearCount}/8 bearish · ATR=${fmtPrice(master.atr,dec)} · ADX=${adx.adx.toFixed(0)} (${adx.adx>25?'trending':'ranging'}) · W%R=${williamsR.toFixed(0)} · CCI=${cci.toFixed(0)}</span><span style="color:var(--muted);font-size:0.8em;display:block;margin-top:4px">⚠ Technical analysis only. Always manage risk carefully.</span>`;

        // ── Levels — identical in all three places
        safeText('entryZone', fmtPrice(master.entry,dec));
        safeText('suggestSL',  fmtPrice(master.sl,dec));
        safeText('suggestTP',  fmtPrice(master.tp,dec));
        const els=$('entryLevelsSection'); if(els) els.style.display='block';

    } catch(e) {
        console.error('Analysis error',e);
        if(analysisTextEl) analysisTextEl.innerHTML=`<span style="color:var(--bear)">⚠ Data fetch error: ${e.message}. Retrying…</span>`;
    }
}

// ─── INDICATOR PANEL ──────────────────────────────────────────────────
function renderIndicatorPanel({rsi,ema20v,ema50v,price,macdLast,sigLast,histLast,prevHist,bbUpV,bbLoV,bbMidV,atr,stoch,dec,bbWidth,adx,williamsR,cci}) {
    const el=$('indicatorPanel'); if(!el) return;
    const row=(n,v,b,c)=>`<div class="ind-row"><div><div class="text-xs font-semibold text-white">${n}</div><div class="text-xs mono mt-0.5" style="color:var(--muted)">${v}</div></div><span class="ind-badge ${c}">${b}</span></div>`;
    const rsiB=rsi>70?['OVERBOUGHT','ind-bear']:rsi<30?['OVERSOLD','ind-bull']:rsi>55?['BULLISH','ind-bull']:rsi<45?['BEARISH','ind-bear']:['NEUTRAL','ind-neut'];
    const emaB=ema20v&&ema50v?(ema20v>ema50v?['BULL TREND','ind-bull']:['BEAR TREND','ind-bear']):['--','ind-neut'];
    const macdB=macdLast!==null&&sigLast!==null?(macdLast>sigLast?['BULLISH','ind-bull']:['BEARISH','ind-bear']):['--','ind-neut'];
    const bbB=bbUpV&&bbLoV?(price>bbUpV?['OVERBOUGHT','ind-bear']:price<bbLoV?['OVERSOLD','ind-bull']:price>bbMidV?['MID-UPPER','ind-bull']:['MID-LOWER','ind-bear']):['--','ind-neut'];
    const stB=stoch.k>80?['OVERBOUGHT','ind-bear']:stoch.k<20?['OVERSOLD','ind-bull']:stoch.k>stoch.d?['BULL','ind-bull']:['BEAR','ind-bear'];
    const adxB=adx.adx>30?['TRENDING','ind-bull']:adx.adx>20?['DEVELOPING','ind-neut']:['RANGING','ind-bear'];
    const wrB=williamsR<-70?['OVERSOLD','ind-bull']:williamsR>-20?['OVERBOUGHT','ind-bear']:['NEUTRAL','ind-neut'];
    const cciB=cci<-100?['OVERSOLD','ind-bull']:cci>100?['OVERBOUGHT','ind-bear']:['NEUTRAL','ind-neut'];
    el.innerHTML=
        row('RSI (14)',rsi.toFixed(2),rsiB[0],rsiB[1])+
        row('EMA 20/50',`${fmtPrice(ema20v,dec)} / ${fmtPrice(ema50v,dec)}`,emaB[0],emaB[1])+
        row('MACD vs Signal',macdLast?.toFixed(dec>=4?5:2)||'--',macdB[0],macdB[1])+
        row('Bollinger Bands',`Width ${bbWidth.toFixed(2)}%`,bbB[0],bbB[1])+
        row('Stochastic K/D',`K:${stoch.k.toFixed(1)} D:${stoch.d.toFixed(1)}`,stB[0],stB[1])+
        row('ADX (14)',`${adx.adx.toFixed(1)} +DI:${adx.plusDI.toFixed(0)} -DI:${adx.minusDI.toFixed(0)}`,adxB[0],adxB[1])+
        row('Williams %R',williamsR.toFixed(0),wrB[0],wrB[1])+
        row('CCI (20)',cci.toFixed(0),cciB[0],cciB[1]);
}

// ─── STRATEGY CARDS ───────────────────────────────────────────────────
function renderStrategyCards(strategies, master) {
    const el=$('strategyCards'); if(!el) return;
    const dIcon={'BUY':'▲','SELL':'▼','LEAN BUY':'↗','LEAN SELL':'↙','HOLD':'—'};
    const dColor={'BUY':'var(--bull)','SELL':'var(--bear)','LEAN BUY':'rgba(0,230,118,0.85)','LEAN SELL':'rgba(255,61,90,0.85)','HOLD':'var(--gold)'};
    const cCls={'BUY':'sc-buy','SELL':'sc-sell','LEAN BUY':'sc-lean-buy','LEAN SELL':'sc-lean-sell','HOLD':'sc-hold'};
    const badge=$('strategyBadge');
    if(badge){ badge.className=master.dir==='BUY'?'hc-badge hc-strong-buy':master.dir==='SELL'?'hc-badge hc-strong-sell':master.dir.includes('LEAN')?'hc-badge hc-lean':'hc-badge hc-neutral'; badge.textContent=`${master.dir} · ${master.score}/10`; }
    const buyC=strategies.filter(s=>s.dir==='BUY').length, lbC=strategies.filter(s=>s.dir==='LEAN BUY').length;
    const sellC=strategies.filter(s=>s.dir==='SELL').length, lsC=strategies.filter(s=>s.dir==='LEAN SELL').length;
    safeText('agreeCount',`${buyC+lbC} bull / ${sellC+lsC} bear`);
    el.innerHTML=strategies.map((s,idx)=>`
        <div class="strat-card ${cCls[s.dir]||'sc-neutral'}">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px;margin-bottom:8px">
                <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
                    <div style="width:32px;height:32px;border-radius:9px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.05);border:1px solid ${s.color}40;flex-shrink:0">
                        <i class="fa-solid ${s.icon}" style="color:${s.color};font-size:12px"></i>
                    </div>
                    <div style="min-width:0">
                        <div style="font-size:11px;font-weight:700;color:#e2eaf5;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${s.name}</div>
                        <div style="font-size:9px;color:var(--muted)">Strategy ${idx+1}</div>
                    </div>
                </div>
                <div style="text-align:right;flex-shrink:0">
                    <div style="font-family:'Space Mono',monospace;font-size:0.85rem;font-weight:900;color:${dColor[s.dir]};line-height:1">${dIcon[s.dir]} ${s.dir}</div>
                    <div style="font-size:9px;color:var(--muted);margin-top:1px">${s.conf}% conf.</div>
                </div>
            </div>
            <div class="conf-track"><div class="conf-fill" style="width:${s.conf}%;background:${dColor[s.dir]}"></div></div>
            <div style="margin-top:8px;display:flex;flex-direction:column;gap:3px">
                ${s.notes.slice(0,3).map(n=>`<div style="font-size:10px;color:#94a3b8;padding:2px 0 2px 7px;border-left:2px solid ${s.color}30;line-height:1.35">· ${n}</div>`).join('')}
            </div>
        </div>`).join('');
}

// ─── MASTER VERDICT ───────────────────────────────────────────────────
function renderMasterVerdict(master, adx, dec) {
    const el=$('masterVerdictStrip'); if(!el) return;
    el.classList.remove('hidden');
    const vcls=master.dir==='BUY'?'verdict-buy':master.dir==='SELL'?'verdict-sell':master.dir.includes('LEAN')?'verdict-lean':'verdict-neutral';
    el.className=`${vcls} rounded-xl p-4 mt-4`;
    safeText('verdictDir',master.dir); if($('verdictDir')) $('verdictDir').style.color=master.color;
    safeText('verdictSub',`${master.bullPct.toFixed(0)}% weighted bull · ${master.bearPct.toFixed(0)}% weighted bear · ${master.score}/10`);
    const mb=$('masterBull'),mbb=$('masterBear');
    if(mb) mb.style.width=master.bullPct+'%'; if(mbb) mbb.style.width=master.bearPct+'%';
    safeText('masterBullPct',master.bullPct.toFixed(0)+'%'); safeText('masterBearPct',master.bearPct.toFixed(0)+'%');
    safeText('verdictTP',  fmtPrice(master.tp,  dec));
    safeText('verdictSL',  fmtPrice(master.sl,  dec));
    safeText('verdictATR', fmtPrice(master.atr, dec));
    safeText('verdictADX', adx.adx.toFixed(0));
}

// ─── SMALL CONFLUENCE CARD ────────────────────────────────────────────
function updateSmallSignalCard(master) {
    if(signalText)    signalText.textContent=master.dir;
    if(signalSubtext) signalSubtext.textContent=`${master.bullCount}/8 bull · ${master.bearCount}/8 bear`;
    if(signalSection) { const c=master.dir==='BUY'?'signal-buy':master.dir==='SELL'?'signal-sell':master.dir.includes('LEAN')?'signal-wait':'signal-neutral'; signalSection.className=`${c} w-full rounded-2xl px-4 py-5 mb-3 transition-all duration-500`; }
    const cb=$('confluenceBar'); if(cb){ cb.style.width=`${master.score*10}%`; cb.style.background=master.color; }
    safeText('confluenceScore',`${master.score}/10`);
    const vb=$('voteBull'),vbb=$('voteBear');
    if(vb) vb.style.width=master.bullPct+'%'; if(vbb) vbb.style.width=master.bearPct+'%';
    safeText('voteBullPct',master.bullPct.toFixed(0)+'%'); safeText('voteBearPct',master.bearPct.toFixed(0)+'%');
}

// ─── BANNER ───────────────────────────────────────────────────────────
function updateBanner(master, strategies, rsi, ema20v, ema50v, macdLast, sigLast, stoch, dec, adx) {
    const banner=$('signalBanner'); if(!banner) return;
    const type=master.dir==='BUY'?'buy':master.dir==='SELL'?'sell':master.dir.includes('LEAN')?'wait':'neutral';
    banner.className=type;
    const wordEl=$('bannerSignalWord');
    if(wordEl){ wordEl.textContent=master.dir; wordEl.style.color=master.color; wordEl.className=type!=='neutral'?'mono font-black signal-pulse':'mono font-black'; wordEl.style.fontSize='clamp(1.6rem,4vw,2.8rem)'; }
    safeText('bannerSignalSub',`${master.bullPct.toFixed(0)}% bull · ${master.bearPct.toFixed(0)}% bear · ${master.score}/10`);
    const asset=ASSETS[currentSymbol];
    safeText('bannerAssetLabel',`${asset.sym} · ${currentInterval.toUpperCase()}`);
    const buyC=strategies.filter(s=>s.dir==='BUY').length, sellC=strategies.filter(s=>s.dir==='SELL').length;
    safeText('bannerStratSummary',`${buyC}/8 BUY · ${sellC}/8 SELL · ADX ${adx.adx.toFixed(0)}`);
    $('tlRed').className   ='tl-dot tl-red'   +(type==='sell'?' on':'');
    $('tlYellow').className='tl-dot tl-yellow'+(type==='wait'?' on':'');
    $('tlGreen').className ='tl-dot tl-green' +(type==='buy'?' on':'');
    const rv=$('ringVal'); if(rv){ rv.style.strokeDashoffset=144.5*(1-master.score/10); rv.style.stroke=master.color; }
    const rt=$('ringText'); if(rt){ rt.textContent=master.score; rt.style.color=master.color; }
    // ── All levels read from master — single source of truth
    safeText('bannerEntry', fmtPrice(master.entry,dec));
    safeText('bannerTP',    fmtPrice(master.tp,   dec));
    safeText('bannerSL',    fmtPrice(master.sl,   dec));
    safeText('bannerRR',    master.rr);
    safeText('bannerTimestamp', new Date().toLocaleTimeString());
    const pills=[
        {label:`RSI ${rsi.toFixed(0)}`,cls:rsi>70?'ind-bear':rsi<30?'ind-bull':'ind-neut'},
        ...(ema20v&&ema50v?[{label:ema20v>ema50v?'EMA▲':'EMA▼',cls:ema20v>ema50v?'ind-bull':'ind-bear'}]:[]),
        ...(macdLast!==null&&sigLast!==null?[{label:macdLast>sigLast?'MACD▲':'MACD▼',cls:macdLast>sigLast?'ind-bull':'ind-bear'}]:[]),
        {label:`STOCH ${stoch.k.toFixed(0)}`,cls:stoch.k>80?'ind-bear':stoch.k<20?'ind-bull':'ind-neut'},
        {label:`ADX ${adx.adx.toFixed(0)}`,cls:adx.adx>25?'ind-bull':'ind-neut'},
    ];
    const pp=$('bannerPills'); if(pp) pp.innerHTML=pills.map(p=>`<span class="ind-badge ${p.cls}">${p.label}</span>`).join('');
    const newKey=type+'_'+currentSymbol+'_'+currentInterval;
    if(newKey!==lastSignalKey&&lastSignalKey!==''){
        showToast(master.dir,`${asset.sym} · ${master.bullPct.toFixed(0)}% bull · ${master.score}/10`,master.color);
        playSignalSound(type==='hold'||type==='wait'||type==='neutral'?'wait':type);
    }
    lastSignalKey=newKey;
}

// ─── NEWS ─────────────────────────────────────────────────────────────
async function fetchNews() {
    const feedEl=$('newsFeed'), tsEl=$('newsTimestamp');
    const asset=ASSETS[currentSymbol];
    const bullKW=/bullish|surge|rally|gain|pump|rise|breakout|buy|positive|record|ath|adoption/i;
    const bearKW=/bearish|crash|drop|fall|sell|decline|dump|fear|ban|hack|negative|warning|risk/i;

    try {
        let articles=[];

        if(FINNHUB_KEY.length>6) {
            // Finnhub — real financial news for all assets
            const cat=asset.type==='crypto'?'crypto':'forex';
            const d=await fetch(`https://finnhub.io/api/v1/news?category=${cat}&token=${FINNHUB_KEY}`).then(r=>r.json());
            if(Array.isArray(d)&&d.length) {
                const name=asset.name.toLowerCase();
                const symParts=asset.sym.toLowerCase().replace('/','');
                // Filter relevant news first, fallback to latest 8
                const rel=d.filter(a=>{ const t=(a.headline||'').toLowerCase(); return t.includes(name)||t.includes(symParts)||t.includes(symParts.slice(0,3)); });
                articles=(rel.length>2?rel:d).slice(0,8).map(a=>({ title:a.headline, url:a.url, source:a.source, time:a.datetime*1000 }));
                const nb=$('newsBadge'); if(nb){ nb.textContent='Finnhub'; nb.style.color='var(--bull)'; nb.style.borderColor='rgba(0,230,118,0.35)'; }
            }
        }

        // CryptoCompare fallback (always works, best for crypto)
        if(!articles.length) {
            const catMap={'BTCUSDT':'BTC','ETHUSDT':'ETH','SOLUSDT':'SOL','BNBUSDT':'BNB','XRPUSDT':'XRP','EURUSDT':'EUR','GBPUSDT':'GBP','AUDUSDT':'AUD','NZDUSDT':'NZD','USDJPY':'JPY','USDCAD':'CAD','USDCHF':'CHF','EURJPY':'EUR','PAXGUSDT':'XAU'};
            const tag=catMap[currentSymbol]||'BTC';
            const d=await fetch(`https://min-api.cryptocompare.com/data/v2/news/?categories=${tag}&excludeCategories=Sponsored&lang=EN`).then(r=>r.json());
            articles=(d.Data||[]).slice(0,8).map(a=>({ title:a.title, url:a.url, source:a.source_info?.name||'News', time:a.published_on*1000 }));
            const nb=$('newsBadge'); if(nb){ nb.textContent='CryptoCompare'; nb.style.color='var(--gold)'; nb.style.borderColor='rgba(255,209,102,0.3)'; }
        }

        if(tsEl) tsEl.textContent=`Updated ${new Date().toLocaleTimeString()}`;
        if(!articles.length){ if(feedEl) feedEl.innerHTML=`<div class="text-center py-4 text-xs" style="color:var(--muted)">No news found for ${asset.sym}</div>`; return; }

        feedEl.innerHTML=articles.map(a=>{
            const ago=getTimeAgo(new Date(a.time));
            const title=(a.title||'').slice(0,92)+((a.title||'').length>92?'…':'');
            const sent=bullKW.test(a.title)?'bullish':bearKW.test(a.title)?'bearish':'';
            const dot=sent==='bullish'?'var(--bull)':sent==='bearish'?'var(--bear)':'var(--muted)';
            return `<div class="news-item ${sent}" onclick="window.open('${a.url}','_blank')"><div class="flex items-start gap-2"><div class="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0" style="background:${dot}"></div><div><div class="text-xs font-semibold text-white leading-snug mb-0.5">${title}</div><div class="text-xs" style="color:var(--muted)">${a.source} · ${ago}</div></div></div></div>`;
        }).join('');
    } catch(e) {
        console.warn('News error',e);
        if(tsEl) tsEl.textContent='News unavailable';
        if(feedEl) feedEl.innerHTML=`<div class="text-center py-4 text-xs" style="color:var(--muted)"><i class="fa-solid fa-wifi-slash mb-2 block text-lg"></i>News temporarily unavailable.</div>`;
    }
}
function getTimeAgo(d){ const s=Math.floor((Date.now()-d.getTime())/1000); return s<60?`${s}s ago`:s<3600?`${Math.floor(s/60)}m ago`:s<86400?`${Math.floor(s/3600)}h ago`:`${Math.floor(s/86400)}d ago`; }

// ─── TICKER TAPE ──────────────────────────────────────────────────────
const TICKER_SYMS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','EURUSDT','GBPUSDT','PAXGUSDT'];
async function updateTickerTape() {
    try {
        const results=await Promise.all(TICKER_SYMS.map(s=>fetch(bTicker(s)).then(r=>r.json()).catch(()=>null)));
        const items=results.map((d,i)=>{
            if(!d||d.code) return '';
            const sym=ASSETS[TICKER_SYMS[i]]?.sym||TICKER_SYMS[i];
            const p=parseFloat(d.lastPrice), chg=parseFloat(d.priceChangePercent);
            const dec=ASSETS[TICKER_SYMS[i]]?.decimals||2;
            const col=chg>=0?'var(--bull)':'var(--bear)';
            return `<span class="mono px-4" style="color:#e2eaf5"><span style="color:var(--muted)">${sym}</span> <span>${fmtPrice(p,dec)}</span> <span style="color:${col}">${chg>=0?'+':''}${chg.toFixed(2)}%</span></span><span style="color:var(--border);margin:0 4px">|</span>`;
        }).join('');
        const tape=$('tickerTape');
        if(tape&&items){ tape.innerHTML=items+items; tape.style.animation='none'; tape.offsetHeight; tape.style.animation='tickerMove 60s linear infinite'; }
    } catch(e) {}
}

// ─── WEBSOCKET ────────────────────────────────────────────────────────
function setupWebSocket() {
    const asset=ASSETS[currentSymbol];
    if(asset.type!=='binance') { setLiveStatus(true); return; } // Kraken uses polling
    if(activeWebSocket?.readyState===WebSocket.OPEN||activeWebSocket?.readyState===WebSocket.CONNECTING) return;
    activeWebSocket=new WebSocket(bWS(currentSymbol));
    activeWebSocket.onopen=()=>setLiveStatus(true);
    activeWebSocket.onmessage=e=>{ const d=JSON.parse(e.data); updatePriceUI(parseFloat(d.c), parseFloat(d.P)); };
    activeWebSocket.onerror=()=>console.warn('WS error');
    activeWebSocket.onclose=()=>{ setLiveStatus(false); wsReconnectTimer=setTimeout(setupWebSocket,5000); };
}

// ─── ASSET UI ─────────────────────────────────────────────────────────
function updateAssetUI() {
    const asset=ASSETS[currentSymbol];
    safeText('assetName',asset.name); safeText('assetSymbolText',asset.sym);
    const logo=$('assetLogo'); if(logo) logo.src=asset.logo;
    safeText('statVolLabel',asset.volLabel);
    if(priceSection) priceSection.innerHTML=`<i class="fa-solid fa-circle-notch fa-spin text-2xl" style="color:var(--muted)"></i>`;
    if(priceChange) priceChange.innerHTML='--';
    ['statHigh','statLow','statVol','rsiValue','maValue','macdValue','bbValue','confluenceScore'].forEach(id=>safeText(id,'--'));
    if(signalText) signalText.textContent='--';
    if(signalSubtext) signalSubtext.textContent='Loading...';
    if(signalSection) signalSection.className='signal-neutral w-full rounded-2xl px-4 py-5 mb-3 transition-all duration-500';
    if(analysisTextEl) analysisTextEl.textContent='Gathering market data…';
    const cb=$('confluenceBar'); if(cb) cb.style.width='0%';
    const els=$('entryLevelsSection'); if(els) els.style.display='none';
    if(tradeEntry) tradeEntry.value='';
    latestClosePrice=0; prevPrice=0;
    const sc=$('strategyCards'); if(sc) sc.innerHTML=`<div class="sc-neutral strat-card text-center py-6" style="grid-column:1/-1"><i class="fa-solid fa-circle-notch fa-spin mr-2" style="color:var(--muted)"></i><span style="color:var(--muted)">Running 8 strategy analyses…</span></div>`;
    const mv=$('masterVerdictStrip'); if(mv) mv.classList.add('hidden');
    if(priceChart){ priceChart.data.labels=[]; priceChart.data.datasets.forEach(d=>d.data=[]); priceChart.update('none'); }
    const ip=$('indicatorPanel'); if(ip) ip.innerHTML=`<div class="text-center py-6 text-sm" style="color:var(--muted)"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i>Loading…</div>`;
    if(calcPlaceholder) calcPlaceholder.classList.remove('hidden');
    if(calcResults) calcResults.classList.add('hidden');
    setLiveStatus(false);
}

// ─── RESET & START ────────────────────────────────────────────────────
function resetAndFetchData() {
    if(statsInterval) clearInterval(statsInterval);
    if(histInterval)  clearInterval(histInterval);
    if(newsInterval)  clearInterval(newsInterval);
    if(wsReconnectTimer) clearTimeout(wsReconnectTimer);
    if(activeWebSocket){ activeWebSocket.onclose=null; activeWebSocket.close(); activeWebSocket=null; }
    fetch24hStats();
    fetchHistoricalData();
    fetchNews();
    statsInterval = setInterval(fetch24hStats,      15000);
    histInterval  = setInterval(fetchHistoricalData, 60000);
    newsInterval  = setInterval(fetchNews,          120000);
    setupWebSocket();
}

// ─── EVENTS ───────────────────────────────────────────────────────────
document.querySelectorAll('.interval-btn').forEach(btn=>{
    btn.addEventListener('click',e=>{
        document.querySelectorAll('.interval-btn').forEach(b=>{ b.classList.remove('active'); b.style.color='var(--muted)'; });
        e.currentTarget.classList.add('active'); e.currentTarget.style.color='';
        currentInterval=e.currentTarget.dataset.interval;
        safeText('analysisTimeframe', e.currentTarget.textContent.trim());
        fetchHistoricalData();
    });
});

$('assetSelector').addEventListener('change', e => {
    currentSymbol = e.target.value;
    updateAssetUI();
    resetAndFetchData();
    // Play fav music when XAU or EUR is selected from dropdown
    if (currentSymbol === 'PAXGUSDT' || currentSymbol === 'EURUSDT') {
        playFavMusic();
    }
});

$('calcTradeBtn').addEventListener('click',()=>{
    let entry=parseFloat($('tradeEntry').value);
    if(isNaN(entry)||entry<=0){ if(latestClosePrice>0) entry=latestClosePrice; else{ alert('Waiting for live price.'); return; } }
    const type=$('tradeType').value, lev=parseFloat($('tradeLeverage').value)||1;
    const risk=parseFloat($('tradeRisk').value)||2, rew=parseFloat($('tradeReward').value)||6;
    const dec=ASSETS[currentSymbol].decimals;
    const tp=type==='long'?entry*(1+rew/lev/100):entry*(1-rew/lev/100);
    const sl=type==='long'?entry*(1-risk/lev/100):entry*(1+risk/lev/100);
    safeText('tpPrice',    fmtPrice(tp,dec));
    safeText('slPrice',    fmtPrice(sl,dec));
    safeText('entryDisplay',fmtPrice(entry,dec));
    safeText('tpPl',       `+${rew.toFixed(1)}% ROE`);
    safeText('slPl',       `-${risk.toFixed(1)}% ROE`);
    safeText('rrRatio',    `1:${(rew/risk).toFixed(1)}`);
    if(calcPlaceholder) calcPlaceholder.classList.add('hidden');
    if(calcResults) calcResults.classList.remove('hidden');
});

// Ticker tape refresh
setInterval(updateTickerTape, 30000);

// ─── INIT ─────────────────────────────────────────────────────────────
initCharts();
updateAssetUI();
resetAndFetchData();
updateTickerTape();

// ─── FAVORITES BAR ─────────────────────────────────────────
function switchToFav(sym) {
    currentSymbol = sym;
    const sel = $('assetSelector');
    if (sel) sel.value = sym;
    updateAssetUI();
    resetAndFetchData();
    // Play fav music when XAU or EUR is selected via favorites bar
    if (sym === 'PAXGUSDT' || sym === 'EURUSDT') {
        playFavMusic();
    }
    $('favGold') && $('favGold').classList.toggle('active', sym === 'PAXGUSDT');
    $('favEur')  && $('favEur').classList.toggle('active', sym === 'EURUSDT');
}

async function updateFavoritesBar() {
    try {
        const [gData, eData] = await Promise.all([
            fetch(bTicker('PAXGUSDT')).then(r => r.json()).catch(() => null),
            fetch(bTicker('EURUSDT')).then(r => r.json()).catch(() => null)
        ]);
        if (gData && !gData.code) {
            const gp = parseFloat(gData.lastPrice), gc = parseFloat(gData.priceChangePercent);
            const gEl = $('favGoldPrice'); if (gEl) { gEl.textContent = '$' + gp.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2}); gEl.classList.add('num-tick'); setTimeout(() => gEl.classList.remove('num-tick'), 350); }
            const gCEl = $('favGoldChg'); if (gCEl) { gCEl.textContent = (gc >= 0 ? '+' : '') + gc.toFixed(2) + '%'; gCEl.style.color = gc >= 0 ? 'var(--bull)' : 'var(--bear)'; }
        }
        if (eData && !eData.code) {
            const ep = parseFloat(eData.lastPrice), ec = parseFloat(eData.priceChangePercent);
            const eEl = $('favEurPrice'); if (eEl) { eEl.textContent = ep.toFixed(4); eEl.classList.add('num-tick'); setTimeout(() => eEl.classList.remove('num-tick'), 350); }
            const eCEl = $('favEurChg'); if (eCEl) { eCEl.textContent = (ec >= 0 ? '+' : '') + ec.toFixed(2) + '%'; eCEl.style.color = ec >= 0 ? 'var(--bull)' : 'var(--bear)'; }
        }
        // highlight active
        $('favGold') && $('favGold').classList.toggle('active', currentSymbol === 'PAXGUSDT');
        $('favEur')  && $('favEur').classList.toggle('active', currentSymbol === 'EURUSDT');
    } catch(e) {}
}
setInterval(updateFavoritesBar, 15000);
updateFavoritesBar();

// ─── THREE.JS PREMIUM 3D BACKGROUND ────────────────────────────
function initThreeJS() {
    const canvas = document.getElementById('bgCanvas');
    if (!canvas || !window.THREE) return;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // — 1. Particle constellation field
    const COUNT = 700;
    const pos = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT * 3; i++) pos[i] = (Math.random() - 0.5) * 28;
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pMat = new THREE.PointsMaterial({ size: 0.028, color: 0x00f0ff, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false });
    const particles = new THREE.Points(pGeo, pMat);
    scene.add(particles);

    // — 2. Rotating wireframe Torus Knot (main hero shape)
    const tkGeo = new THREE.TorusKnotGeometry(2.8, 0.6, 128, 16);
    const tkMat = new THREE.MeshBasicMaterial({ color: 0x00f0ff, wireframe: true, opacity: 0.07, transparent: true });
    const torusKnot = new THREE.Mesh(tkGeo, tkMat);
    torusKnot.position.set(4, -1, -6);
    scene.add(torusKnot);

    // — 3. Gold wireframe sphere (symbol of XAU prominence)
    const sGeo = new THREE.IcosahedronGeometry(1.4, 1);
    const sMat = new THREE.MeshBasicMaterial({ color: 0xffd166, wireframe: true, opacity: 0.06, transparent: true });
    const goldSphere = new THREE.Mesh(sGeo, sMat);
    goldSphere.position.set(-5, 2, -8);
    scene.add(goldSphere);

    // — 4. Constellation lines between nearby particles
    const lineMat = new THREE.LineBasicMaterial({ color: 0x00f0ff, transparent: true, opacity: 0.04 });
    const lineGroup = new THREE.Group();
    const pts = [];
    for (let i = 0; i < COUNT; i++) pts.push(new THREE.Vector3(pos[i*3], pos[i*3+1], pos[i*3+2]));
    const threshold = 2.8;
    for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
            if (lineGroup.children.length > 200) break;
            if (pts[i].distanceTo(pts[j]) < threshold) {
                const lGeo = new THREE.BufferGeometry().setFromPoints([pts[i], pts[j]]);
                lineGroup.add(new THREE.Line(lGeo, lineMat));
            }
        }
        if (lineGroup.children.length > 200) break;
    }
    scene.add(lineGroup);

    camera.position.set(0, 0, 7);

    let mouseX = 0, mouseY = 0;
    document.addEventListener('mousemove', e => {
        mouseX = (e.clientX / window.innerWidth - 0.5) * 2;
        mouseY = (e.clientY / window.innerHeight - 0.5) * 2;
    });
    // Mobile touch parallax
    document.addEventListener('touchmove', e => {
        if (e.touches[0]) {
            mouseX = (e.touches[0].clientX / window.innerWidth - 0.5) * 2;
            mouseY = (e.touches[0].clientY / window.innerHeight - 0.5) * 2;
        }
    }, { passive: true });

    const clock = new THREE.Clock();
    (function animate() {
        requestAnimationFrame(animate);
        const t = clock.getElapsedTime();
        particles.rotation.y = t * 0.025;
        particles.rotation.x = t * 0.012;
        torusKnot.rotation.x = t * 0.08;
        torusKnot.rotation.y = t * 0.12;
        goldSphere.rotation.y = t * 0.06;
        goldSphere.rotation.z = t * 0.04;
        lineGroup.rotation.y = t * 0.018;
        // Smooth parallax camera drift
        camera.position.x += (mouseX * 1.2 - camera.position.x) * 0.025;
        camera.position.y += (-mouseY * 0.8 - camera.position.y) * 0.025;
        camera.lookAt(scene.position);
        renderer.render(scene, camera);
    })();

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });
}
initThreeJS();
