import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabaseClient.js";
import "./bingo.css";

/* ========= Helpers ========= */
function hashStringToInt(str){ let h=2166136261>>>0; for(let i=0;i<str.length;i++){h^=str.charCodeAt(i); h=Math.imul(h,16777619);} return h>>>0; }
function xorshift32(seed){ let x=seed>>>0; return function(){ x^=x<<13; x>>>=0; x^=x>>17; x>>>=0; x^=x<<5; x>>>=0; return (x>>>0)/0xffffffff; }; }
function shuffleSeeded(arr, seedStr){ const r=xorshift32(hashStringToInt(seedStr||"default")); const a=[...arr]; for(let i=a.length-1;i>0;i--){const j=Math.floor(r()*(i+1)); [a[i],a[j]]=[a[j],a[i]];} return a; }
function countBingos(marked,n){ let rows=0,cols=0,diag=0; for(let r=0;r<n;r++){ let ok=true; for(let c=0;c<n;c++) if(!marked[r*n+c]){ok=false;break;} if(ok) rows++; } for(let c=0;c<n;c++){ let ok=true; for(let r=0;r<n;r++) if(!marked[r*n+c]){ok=false;break;} if(ok) cols++; } let ok1=true,ok2=true; for(let i=0;i<n;i++){ if(!marked[i*n+i]) ok1=false; if(!marked[i*n+(n-1-i)]) ok2=false; } if(ok1) diag++; if(ok2) diag++; return {rows,cols,diag,total:rows+cols+diag}; }

/* ========= Constants & local storage ========= */
const GRID=5, CENTER=Math.floor((GRID*GRID)/2);
const DEFAULT_WORDS=[];
const getLocal=(k,d)=>{ try{const v=localStorage.getItem(k); return v?JSON.parse(v):d;}catch{ return d;} };
const setLocal=(k,v)=> localStorage.setItem(k, JSON.stringify(v));
function positionOrder(seed){ const pos=[]; for(let i=0;i<GRID*GRID;i++) if(i!==CENTER) pos.push(i); return shuffleSeeded(pos,`pos-${seed}`); }

/* ========= Component ========= */
export default function BingoPartyCloud(){
  const [seed,setSeed]=useState(()=>localStorage.getItem("bingo_user_seed")||"Player-1");
  useEffect(()=>{ localStorage.setItem("bingo_user_seed",seed); },[seed]);

  const [roomCode,setRoomCode]=useState(()=>new URLSearchParams(location.search).get("room")||"public");
  useEffect(()=>{ const url=new URL(location.href); url.searchParams.set("room",roomCode); history.replaceState({}, "", url); },[roomCode]);

  const [room,setRoom]=useState(null);
  const [words,setWords]=useState([]);   // cloud: rows; local: strings
  const [calls,setCalls]=useState([]);   // cloud: rows; local: strings
  const [errorMsg, setErrorMsg] = useState("");
  const unsubRef=useRef(null);

  useEffect(()=>{
    let alive=true;

    async function initCloud(){
      // Ensure room
      const { data:existing, error } = await supabase
        .from("rooms").select("*").eq("code", roomCode).maybeSingle();
      if (error) console.warn(error);
      let r = existing;
      if (!r) {
        const ins = await supabase.from("rooms").insert({ code: roomCode }).select().single();
        if (ins.error) { console.error(ins.error); setErrorMsg(ins.error.message); return; }
        r = ins.data;
      }
      if (!alive) return;
      setRoom(r);

      // Initial data
      const w = await supabase.from("words").select("*").eq("room_id", r.id).order("created_at");
      const c = await supabase.from("calls").select("*").eq("room_id", r.id).order("created_at");
      if (!w.error) setWords(w.data||[]); else { console.warn(w.error); setErrorMsg(w.error.message); }
      if (!c.error) setCalls(c.data||[]); else { console.warn(c.error); setErrorMsg(c.error.message); }

      // Ensure only ONE channel is active on this client
      if (unsubRef.current) { try { unsubRef.current(); } catch(e) {} }
      const ch = supabase.channel(`room-${r.id}`);

      ch.on("postgres_changes",
        { event:"INSERT", schema:"public", table:"words", filter:`room_id=eq.${r.id}` },
        (payload)=> setWords(prev => {
          // Dedupe by id
          if (prev.some(x => x.id === payload.new.id)) return prev;
          return [...prev, payload.new];
        })
      );
      ch.on("postgres_changes",
        { event:"INSERT", schema:"public", table:"calls", filter:`room_id=eq.${r.id}` },
        (payload)=> setCalls(prev => {
          if (prev.some(x => x.id === payload.new.id)) return prev;
          return [...prev, payload.new];
        })
      );
      ch.on("postgres_changes",
        { event:"DELETE", schema:"public", table:"calls", filter:`room_id=eq.${r.id}` },
        (payload)=> setCalls(prev=> prev.filter(x=>x.id!==payload.old.id))
      );

      ch.subscribe();
      unsubRef.current = () => { try { supabase.removeChannel(ch); } catch(e) {} };
    }

    function initLocal(){
      const code=roomCode||"public";
      const fake={ id: code, code };
      if (!getLocal(`pool_${code}`)) setLocal(`pool_${code}`, DEFAULT_WORDS);
      setRoom(fake);
      setWords(getLocal(`pool_${code}`, DEFAULT_WORDS));
      setCalls(getLocal(`calls_${code}`, []));
      unsubRef.current=null;
    }

    if (supabase) initCloud(); else initLocal();
    return ()=>{ alive=false; if (unsubRef.current) unsubRef.current(); };
  },[roomCode]);

  /* ====== ACTIONS (optimistic) ====== */
  async function addWord(text){
    const w=(text||"").trim();
    if (!w || w.toUpperCase()==="FREE" || !room) return;

    if (!supabase){
      const pool=getLocal(`pool_${room.id}`, []);
      if (pool.includes(w)) return;
      const next=[...pool,w]; setLocal(`pool_${room.id}`, next); setWords(next);
      return;
    }

    const currentPool = words.map(row => row?.text ?? row);
    if (currentPool.includes(w)) return;

    // Optimistic add
    const tmpId = "tmp_" + Date.now();
    const tmpRow = { id: tmpId, room_id: room.id, text: w, created_at: new Date().toISOString() };
    setWords(prev => [...prev, tmpRow]);

    // DB insert
    const { data, error } = await supabase
      .from("words")
      .insert({ room_id: room.id, text: w })
      .select()
      .single();

    if (error) {
      setWords(prev => prev.filter(r => (r.id ?? "") !== tmpId));
      setErrorMsg(error.message || "Failed to add word.");
      console.error("addWord error:", error);
      return;
    }
    // Replace temp with real row (id changes)
    setWords(prev => prev.map(r => (r.id === tmpId ? data : r)));
  }

  async function callWord(wordText){
    if (!wordText || !room) return;

    if (!supabase){
      const called=getLocal(`calls_${room.id}`, []);
      if (!called.includes(wordText)){
        const next=[...called,wordText]; setLocal(`calls_${room.id}`, next); setCalls(next);
      }
      return;
    }

    const tmpId = "tmp_c_" + Date.now();
    const tmpRow = { id: tmpId, room_id: room.id, word: wordText, created_at: new Date().toISOString() };
    setCalls(prev => [...prev, tmpRow]);

    const { data, error } = await supabase
      .from("calls")
      .insert({ room_id: room.id, word: wordText })
      .select()
      .single();

    if (error) {
      setCalls(prev => prev.filter(r => (r.id ?? "") !== tmpId));
      setErrorMsg(error.message || "Failed to call word.");
      console.error("callWord error:", error);
      return;
    }
    setCalls(prev => prev.map(r => (r.id === tmpId ? data : r)));
  }

  async function clearCalls(){
    if (!room) return;
    if (!supabase){ setLocal(`calls_${room.id}`, []); setCalls([]); return; }
    const { error } = await supabase.from("calls").delete().eq("room_id", room.id);
    if (error) { setErrorMsg(error.message); console.error(error); }
  }

  function resetPool(){
    if (!room) return;
    if (!supabase){
      setLocal(`pool_${room.id}`, []); setWords([]);
      setLocal(`calls_${room.id}`, []); setCalls([]); return;
    }
    (async ()=>{
      const e1 = await supabase.from("words").delete().eq("room_id", room.id);
      const e2 = await supabase.from("calls").delete().eq("room_id", room.id);
      if (e1.error) { setErrorMsg(e1.error.message); console.error(e1.error); }
      if (e2.error) { setErrorMsg(e2.error.message); console.error(e2.error); }
      setWords([]); setCalls([]);
    })();
  }

  /* ====== Derived values ====== */
  const wordPool = useMemo(()=> supabase ? words.map(w=>w.text) : words, [words]);
  const calledArr = useMemo(()=> supabase ? calls.map(c=>c.word) : calls, [calls]);
  const calledSet = useMemo(()=> new Set(calledArr), [calledArr]);

  const boardWords = useMemo(()=>{
    const order = positionOrder(seed);
    const cells = Array(GRID*GRID).fill("");
    cells[CENTER] = "FREE";
    const limit = Math.min(wordPool.length, order.length); // 24 slots
    for (let i=0;i<limit;i++) cells[order[i]] = wordPool[i];
    return cells;
  },[wordPool,seed]);

  const marked = useMemo(()=> boardWords.map(w=> w==="FREE" || (w && calledSet.has(w))), [boardWords,calledSet]);
  const bingos = useMemo(()=> countBingos(marked, GRID), [marked]);
  const filledCount = useMemo(()=> boardWords.filter(Boolean).length, [boardWords]);
  const remaining = (GRID*GRID - 1) - (filledCount - 1);

  /* ====== UI ====== */
  return (
    <div className="bp-wrap">
      {/* Header */}
      <div className="bp-head">
        <div>
          <div style={{fontSize:20,fontWeight:700}}>BINGO Party</div>
        </div>
        <div className="bp-head-right">
          <input
            className="bp-input"
            value={seed}
            onChange={e=>setSeed(e.target.value)}
            placeholder="player seed"
          />
          <input
            className="bp-input"
            value={roomCode}
            onChange={e=>setRoomCode(e.target.value.replace(/[^a-zA-Z0-9_-]/g,'').slice(0,24))}
            placeholder="room"
          />
        </div>
      </div>

      {errorMsg && (
        <div style={{marginTop:8, padding:8, borderRadius:8, background:"#fff3cd", color:"#664d03", border:"1px solid #ffecb5"}}>
          {errorMsg}
        </div>
      )}

      {/* Main layout */}
      <div className="bp-layout">
        {/* Left: Pool */}
        <div className="bp-card">
          <h3 style={{marginTop:0}}>Shared Word Pool</h3>
          <AddWord onAdd={addWord}/>
          <div className="bp-pool-list">
            {wordPool.length===0 ? (
              <div style={{padding:12,color:"#666"}}>No words yet. Add the first one!</div>
            ) : wordPool.map((w,i)=>(
              <div key={w+i} className="bp-pool-row">
                <span style={{overflow:"hidden",textOverflow:"ellipsis"}}>{w}</span>
                <button className="bp-btn" onClick={()=>callWord(w)}>Call</button>
              </div>
            ))}
          </div>
          <div style={{display:"flex",gap:8,marginTop:8,flexWrap:"wrap"}}>
            <button className="bp-btn" onClick={()=>{
              const remainingWords = wordPool.filter(w=>!calledSet.has(w) && w!=="FREE");
              if (remainingWords.length) callWord(remainingWords[Math.floor(Math.random()*remainingWords.length)]);
            }}>Call Random</button>
            <button className="bp-btn" onClick={clearCalls}>Clear All Calls</button>
            <button className="bp-btn" onClick={resetPool} style={{marginLeft:8}}>Reset Pool (new game)</button>
          </div>

          <div style={{marginTop:12,fontSize:12,color:"#555"}}>
            Board fill: <b>{Math.max(0,filledCount-1)}/24</b> cells (excluding FREE). {remaining>0 ? `${remaining} more needed.` : `All cells filled.`}
          </div>
        </div>

        {/* Right: Board */}
        <div className="bp-card">
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <h3 style={{margin:0}}>Your Board</h3>
            <div
              className="bp-pill"
              style={{background: bingos.total ? "#e9f7ef" : "#f3f3f3", color: bingos.total ? "#1e7e34" : "#555"}}
            >
              {bingos.total ? `BINGO! (${bingos.total} line${bingos.total>1?"s":""})` : "No bingo yet"}
            </div>
          </div>
          <BoardGrid words={boardWords} marked={marked}/>
          <div style={{fontSize:12,color:"#666",marginTop:8}}>
            Room: <code>{roomCode}</code> {supabase ? "· Cloud" : "· Local demo"} · Different <em>seed</em> = different layout.
          </div>
        </div>
      </div>
    </div>
  );
}

/* ========= Presentational ========= */
function BoardGrid({words,marked}){
  const rows = useMemo(()=>{ const out=[]; for(let r=0;r<GRID;r++) out.push(words.slice(r*GRID,r*GRID+GRID)); return out; },[words]);
  return (
    <div className="bp-board">
      {rows.map((row,r)=>row.map((w,c)=> {
        const idx=r*GRID+c, isMarked=marked[idx], isEmpty=!w;
        return (
          <div
            key={idx}
            title={w||""}
            className="bp-cell"
            style={{
              background: isMarked ? "#16a34a" : (isEmpty ? "#fff" : "#fafafa"),
              color: isMarked ? "#fff" : (isEmpty ? "#bbb" : "#000")
            }}
          >
            <span>{isEmpty ? "—" : w}</span>
          </div>
        );
      }))}
    </div>
  );
}

function AddWord({onAdd}){
  const [val,setVal]=useState("");
  return (
    <div style={{display:"flex",gap:8,marginBottom:8}}>
      <input
        className="bp-input"
        value={val}
        onChange={(e)=>setVal(e.target.value)}
        placeholder="Add a word or phrase"
        onKeyDown={(e)=>{ if (e.key==="Enter"){ onAdd(val); setVal(""); } }}
        style={{flex:1}}
        inputMode="text"
        type="text"
        autoCapitalize="none"
        autoCorrect="off"
      />
      <button className="bp-btn" onClick={()=>{ onAdd(val); setVal(""); }}>Add</button>
    </div>
  );
}









