// --- addWord: safe against duplicates ---
async function addWord(text) {
  const w = (text || "").trim();
  if (!w || w.toUpperCase() === "FREE" || !room) return;

  if (!supabase) {
    const pool = getLocal(`pool_${room.id}`, []);
    if (pool.includes(w)) return;
    const next = [...pool, w];
    setLocal(`pool_${room.id}`, next);
    setWords(next);
    return;
  }

  const currentPool = words.map(row => row?.text ?? row);
  if (currentPool.includes(w)) return;

  // optimistic insert
  const tmpId = "tmp_" + Date.now();
  const tmpRow = {
    id: tmpId,
    room_id: room.id,
    text: w,
    created_at: new Date().toISOString()
  };
  setWords(prev => [...prev, tmpRow]);

  // insert in DB
  const { data, error } = await supabase
    .from("words")
    .insert({ room_id: room.id, text: w })
    .select()
    .single();

  if (error) {
    setWords(prev => prev.filter(r => r.id !== tmpId));
    setErrorMsg(error.message || "Failed to add word.");
    console.error("addWord error:", error);
    return;
  }

  // replace temp with real — but only if realtime hasn’t already added it
  setWords(prev => {
    const withoutTmp = prev.filter(r => r.id !== tmpId);
    if (withoutTmp.some(r => r.id === data.id)) return withoutTmp;
    return [...withoutTmp, data];
  });
}

// --- callWord: safe against duplicates ---
async function callWord(wordText) {
  if (!wordText || !room) return;

  if (!supabase) {
    const called = getLocal(`calls_${room.id}`, []);
    if (!called.includes(wordText)) {
      const next = [...called, wordText];
      setLocal(`calls_${room.id}`, next);
      setCalls(next);
    }
    return;
  }

  const tmpId = "tmp_c_" + Date.now();
  const tmpRow = {
    id: tmpId,
    room_id: room.id,
    word: wordText,
    created_at: new Date().toISOString()
  };
  setCalls(prev => [...prev, tmpRow]);

  const { data, error } = await supabase
    .from("calls")
    .insert({ room_id: room.id, word: wordText })
    .select()
    .single();

  if (error) {
    setCalls(prev => prev.filter(r => r.id !== tmpId));
    setErrorMsg(error.message || "Failed to call word.");
    console.error("callWord error:", error);
    return;
  }

  setCalls(prev => {
    const withoutTmp = prev.filter(r => r.id !== tmpId);
    if (withoutTmp.some(r => r.id === data.id)) return withoutTmp;
    return [...withoutTmp, data];
  });
}

// --- realtime handlers ---
ch.on("postgres_changes",
  { event: "INSERT", schema: "public", table: "words", filter: `room_id=eq.${r.id}` },
  (payload) => setWords(prev => {
    if (prev.some(x => x.id === payload.new.id)) return prev;
    return [...prev, payload.new];
  })
);

ch.on("postgres_changes",
  { event: "INSERT", schema: "public", table: "calls", filter: `room_id=eq.${r.id}` },
  (payload) => setCalls(prev => {
    if (prev.some(x => x.id === payload.new.id)) return prev;
    return [...prev, payload.new];
  })
);









