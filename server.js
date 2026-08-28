const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { transports: ['websocket', 'polling'] });
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';

const RANKS = ['2','3','4','5','6','7','8','9','J','Q','K','A'];
const SUITS = ['♠','♥','♦','♣'];
const ODDS = {
  '2':{hi:1.05,lo:0},'3':{hi:1.20,lo:10},'4':{hi:1.33,lo:6},
  '5':{hi:1.50,lo:3.50},'6':{hi:1.65,lo:2.30},'7':{hi:1.90,lo:2},
  '8':{hi:2,lo:1.90},'9':{hi:2.30,lo:1.65},'J':{hi:3.50,lo:1.50},
  'Q':{hi:6,lo:1.33},'K':{hi:10,lo:1.20},'A':{hi:0,lo:1.05}
};
const BUY_IN = 500000;
const WIN_TARGET = 3000000;
const ELIMINATION = 9999;
const BET_SECONDS = 15;

let shoe = [];
let timerHandle = null;
let phaseHandle = null;
let adminSockets = new Set();
const sessions = new Map();
const socketsBySession = new Map();

const state = {
  phase: 'waiting', round: 1, timer: BET_SECONDS,
  current: null, next: null, resultText: '방장의 게임 시작을 기다리는 중',
  seats: Array(24).fill(null), roundWinners: [], winner: null, cardHistory: []
};

function shuffle(a){
  for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}
  return a;
}
function freshShoe(){
  shoe=[];
  for(let d=0;d<8;d++) for(const r of RANKS) for(const s of SUITS) shoe.push({r,s});
  shuffle(shoe);
}
function draw(){if(shoe.length<32)freshShoe();return shoe.pop()}
function rank(card){return RANKS.indexOf(card.r)}
function publicPlayer(p){
  if(!p)return null;
  return {sessionId:p.sessionId,nick:p.nick,money:Math.round(p.money),connected:p.connected,out:p.out,
    bet:p.bet&&{side:p.bet.side,amount:p.bet.amount,locked:p.bet.locked,continuation:!!p.bet.continuation},
    streak:p.streak&&{stake:p.streak.stake,multiplier:p.streak.multiplier,wins:p.streak.wins,payout:Math.round(p.streak.stake*p.streak.multiplier)}};
}
function snapshot(){
  return {...state,seats:state.seats.map(publicPlayer),odds:ODDS[state.current.r],shoeRemaining:shoe.length,serverTime:Date.now()};
}
function broadcast(){io.emit('state',snapshot())}
function clearTimers(){clearInterval(timerHandle);clearTimeout(phaseHandle);timerHandle=null;phaseHandle=null}
function resetBets(){for(const p of state.seats)if(p)p.bet=null}
function activePlayers(){return state.seats.filter(p=>p&&!p.out)}
function cashoutPlayer(p,automatic=false){
  if(!p?.streak)return null;
  const payout=Math.round(p.streak.stake*p.streak.multiplier);
  const profit=payout-p.streak.stake;
  const row={nick:p.nick,profit,payout,automatic};
  p.money+=payout;p.streak=null;p.bet=null;
  return row;
}

function startRound(){
  if(state.phase==='ended')return;
  if(!activePlayers().length){state.phase='waiting';state.resultText='참가자 착석을 기다리는 중';return broadcast()}
  clearTimers();resetBets();state.next=null;state.roundWinners=[];state.phase='betting';state.timer=BET_SECONDS;state.resultText='베팅할 방향을 선택하세요';broadcast();
  timerHandle=setInterval(()=>{
    state.timer--;
    if(state.timer<=0){clearInterval(timerHandle);timerHandle=null;revealRound()}else broadcast();
  },1000);
}
function revealRound(){
  const automaticCashouts=[];
  for(const p of state.seats)if(p&&!p.out&&p.streak&&!p.bet){
    const row=cashoutPlayer(p,true);if(row)automaticCashouts.push(row);
  }
  if(automaticCashouts.length)state.roundWinners=automaticCashouts.sort((a,b)=>b.profit-a.profit);
  state.phase='revealing';state.timer=0;state.next=draw();state.resultText='카드 오픈 중';broadcast();
  phaseHandle=setTimeout(settleRound,2200);
}
function settleRound(){
  const next=state.next;
  state.cardHistory.push(next.r);
  if(state.cardHistory.length>24)state.cardHistory.shift();
  const same=rank(next)===rank(state.current);
  const winners=[];
  for(const p of state.seats){
    if(!p||p.out||!p.bet)continue;
    const {side,amount,continuation}=p.bet;
    p.lastBet={side,amount};
    const sameBet=side==='same';
    const win=sameBet?same:!same&&((side==='low'&&rank(next)<rank(state.current))||(side==='high'&&rank(next)>rank(state.current)));
    const push=!sameBet&&same;
    const mult=sameBet?10:side==='low'?ODDS[state.current.r].lo:ODDS[state.current.r].hi;
    if(push){
      if(continuation&&p.streak)winners.push({nick:p.nick,profit:Math.round(p.streak.stake*(p.streak.multiplier-1)),payout:Math.round(p.streak.stake*p.streak.multiplier),push:true});
    }else if(win){
      if(continuation&&p.streak){p.streak.multiplier*=mult;p.streak.wins++}
      else {p.money-=amount;p.streak={stake:amount,multiplier:mult,wins:1}}
      winners.push({nick:p.nick,profit:Math.round(p.streak.stake*(p.streak.multiplier-1)),payout:Math.round(p.streak.stake*p.streak.multiplier),multiplier:p.streak.multiplier});
    }else{
      if(continuation&&p.streak)p.streak=null;
      else p.money-=amount;
    }
    if(p.money<=ELIMINATION&&!p.streak)p.out=true;
  }
  winners.sort((a,b)=>b.profit-a.profit);
  state.roundWinners=winners;
  state.phase='result';
  state.resultText=same?'같은 숫자':rank(next)>rank(state.current)?'HIGH 승리':'LOW 승리';
  const reached=activePlayers().filter(p=>p.money>=WIN_TARGET).sort((a,b)=>b.money-a.money);
  const alive=activePlayers();
  if(reached.length||alive.length===1&&state.seats.filter(Boolean).length>1){
    const champ=reached[0]||alive[0];state.winner={nick:champ.nick,money:Math.round(champ.money)};state.phase='ended';state.resultText=`${champ.nick} 우승`;broadcast();return;
  }
  broadcast();
  phaseHandle=setTimeout(()=>{state.current=state.next;state.next=null;state.round++;startRound()},7000);
}
function initialize(keepSeats=true){
  clearTimers();freshShoe();state.current=draw();state.next=null;state.round=1;state.timer=BET_SECONDS;state.phase='waiting';state.resultText='방장의 게임 시작을 기다리는 중';state.roundWinners=[];state.winner=null;state.cardHistory=[state.current.r];
  if(keepSeats){for(const p of state.seats)if(p){p.money=BUY_IN;p.out=false;p.bet=null;p.lastBet=null;p.streak=null}}
  else {state.seats=Array(24).fill(null);sessions.clear();socketsBySession.clear()}
  broadcast();
}

io.on('connection',socket=>{
  socket.emit('state',snapshot());
  socket.on('join',({nick,sessionId},ack=()=>{})=>{
    nick=String(nick||'').trim().slice(0,10);
    if(!nick)return ack({ok:false,error:'닉네임을 입력해주세요'});
    let id=String(sessionId||'');let player=sessions.get(id);
    if(!player){id=crypto.randomUUID();player={sessionId:id,nick,money:BUY_IN,connected:true,out:false,bet:null,lastBet:null,streak:null,seat:null};sessions.set(id,player)}
    player.connected=true;player.nick=nick;socketsBySession.set(id,socket.id);socket.data.sessionId=id;ack({ok:true,sessionId:id,seat:player.seat});broadcast();
  });
  socket.on('sit',({seat},ack=()=>{})=>{
    const p=sessions.get(socket.data.sessionId);seat=Number(seat);
    if(!p)return ack({ok:false,error:'먼저 입장해주세요'});
    if(!Number.isInteger(seat)||seat<0||seat>23)return ack({ok:false,error:'잘못된 좌석입니다'});
    if(state.seats[seat]&&state.seats[seat]!==p)return ack({ok:false,error:'이미 사용 중인 좌석입니다'});
    if(p.seat!==null&&state.seats[p.seat]===p)state.seats[p.seat]=null;
    p.seat=seat;state.seats[seat]=p;ack({ok:true});broadcast();
  });
  socket.on('bet',({side,amount},ack=()=>{})=>{
    const p=sessions.get(socket.data.sessionId);amount=Math.round(Number(amount));
    if(!p||p.seat===null||state.phase!=='betting')return ack({ok:false,error:'현재 베팅할 수 없습니다'});
    if(p.out)return ack({ok:false,error:'탈락한 참가자입니다'});
    if(!['low','high','same'].includes(side))return ack({ok:false,error:'잘못된 베팅입니다'});
    if(side==='same'&&!['2','A'].includes(state.current.r))return ack({ok:false,error:'SAME은 2 또는 A에서만 가능합니다'});
    if((side==='low'&&!ODDS[state.current.r].lo)||(side==='high'&&!ODDS[state.current.r].hi))return ack({ok:false,error:'선택할 수 없는 방향입니다'});
    if(p.streak){
      p.bet={side,amount:p.streak.stake,locked:false,continuation:true};ack({ok:true});return broadcast();
    }
    if(!Number.isFinite(amount)||amount<10000||amount%10000!==0||amount>p.money)return ack({ok:false,error:'베팅 금액을 확인해주세요'});
    p.bet={side,amount,locked:false,continuation:false};ack({ok:true});broadcast();
  });
  socket.on('confirmBet',(_,ack=()=>{})=>{
    const p=sessions.get(socket.data.sessionId);
    if(!p||!p.bet||state.phase!=='betting')return ack({ok:false,error:'먼저 베팅해주세요'});
    p.bet.locked=true;ack({ok:true});broadcast();
  });
  socket.on('undoBet',(_,ack=()=>{})=>{
    const p=sessions.get(socket.data.sessionId);
    if(!p||state.phase!=='betting'||p.bet?.locked)return ack({ok:false,error:'되돌릴 수 없습니다'});
    p.bet=null;ack({ok:true});broadcast();
  });
  socket.on('cashout',(_,ack=()=>{})=>{
    const p=sessions.get(socket.data.sessionId);
    if(!p||!p.streak||state.phase!=='betting')return ack({ok:false,error:'현재 인출할 연승 당첨금이 없습니다'});
    if(p.bet?.locked)return ack({ok:false,error:'베팅 완료 후에는 인출할 수 없습니다'});
    const result=cashoutPlayer(p,false);state.roundWinners=[result];
    ack({ok:true,payout:result.payout});broadcast();
  });
  socket.on('rebet',(_,ack=()=>{})=>{
    const p=sessions.get(socket.data.sessionId);if(!p||!p.lastBet)return ack({ok:false,error:'이전 베팅 내역이 없습니다'});
    const {side,amount}=p.lastBet;
    if(state.phase!=='betting'||amount>p.money)return ack({ok:false,error:'현재 이전 베팅을 적용할 수 없습니다'});
    if(side==='same'&&!['2','A'].includes(state.current.r))return ack({ok:false,error:'이번 카드에서는 SAME을 적용할 수 없습니다'});
    if((side==='low'&&!ODDS[state.current.r].lo)||(side==='high'&&!ODDS[state.current.r].hi))return ack({ok:false,error:'이번 카드에서는 이전 방향을 적용할 수 없습니다'});
    p.bet={side,amount,locked:false};ack({ok:true});broadcast();
  });
  socket.on('adminLogin',({password},ack=()=>{})=>{
    if(String(password)===ADMIN_PASSWORD){adminSockets.add(socket.id);socket.data.admin=true;ack({ok:true})}else ack({ok:false,error:'관리자 비밀번호가 올바르지 않습니다'});
  });
  socket.on('adminStart',(_,ack=()=>{})=>{if(!socket.data.admin)return ack({ok:false,error:'관리자 권한이 없습니다'});if(state.phase!=='waiting')return ack({ok:false,error:'대기 상태에서만 시작할 수 있습니다'});startRound();ack({ok:true})});
  socket.on('adminRestart',(_,ack=()=>{})=>{if(!socket.data.admin)return ack({ok:false,error:'관리자 권한이 없습니다'});initialize(true);ack({ok:true})});
  socket.on('adminEnd',(_,ack=()=>{})=>{if(!socket.data.admin)return ack({ok:false,error:'관리자 권한이 없습니다'});initialize(false);io.emit('roomDestroyed');ack({ok:true})});
  socket.on('disconnect',()=>{adminSockets.delete(socket.id);const p=sessions.get(socket.data.sessionId);if(p){p.connected=false;socketsBySession.delete(p.sessionId);broadcast()}});
});

app.use(express.static(path.join(__dirname,'public')));
app.get('/health',(_,res)=>res.json({ok:true,phase:state.phase,players:state.seats.filter(Boolean).length}));
freshShoe();state.current=draw();state.cardHistory=[state.current.r];
server.listen(PORT,()=>console.log(`HighLow server listening on ${PORT}`));
