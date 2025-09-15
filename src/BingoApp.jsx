function AddWord({onAdd}){
  const [val,setVal]=useState("");
  const [busy,setBusy]=useState(false);

  async function doAdd(){
    if (busy) return;
    const t = val.trim();
    if (!t) return;
    setBusy(true);
    try { await onAdd(t); } finally { setBusy(false); setVal(""); }
  }

  return (
    <div style={{display:"flex",gap:8,marginBottom:8}}>
      <input
        className="bp-input"
        value={val}
        onChange={(e)=>setVal(e.target.value)}
        placeholder="Add a word or phrase"
        onKeyDown={(e)=>{ if (e.key==="Enter"){ e.preventDefault(); doAdd(); } }}
        style={{flex:1}}
        inputMode="text"
        type="text"
        autoCapitalize="none"
        autoCorrect="off"
      />
      <button className="bp-btn" disabled={busy} onClick={doAdd}>
        {busy ? "Adding…" : "Add"}
      </button>
    </div>
  );
}










