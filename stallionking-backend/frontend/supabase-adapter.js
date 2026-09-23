/*
 * Firestore-compatible adapter, backed by Supabase Postgres + Realtime.
 *
 * parcel-tracker.html was originally written against a Firestore-style
 * document API (db.collection('x').doc(id).set/update/delete/get,
 * db.collection('x').add(...), db.collection('x').orderBy(f,dir).limit(n)
 * .onSnapshot(cb), db.doc('x/id').onSnapshot(cb)). Reproducing that exact
 * surface here means almost none of the app's own code has to change —
 * only how `db` gets constructed at startup.
 *
 * Usage (see parcel-tracker.html's init()):
 *   const db = createSupabaseAdapter(SUPABASE_URL, SUPABASE_ANON_KEY);
 *
 * Requires the Supabase JS client to already be loaded as a global
 * `supabase` (the UMD build — see the <script> tag added near the top of
 * parcel-tracker.html).
 */
function createSupabaseAdapter(supabaseUrl, supabaseAnonKey) {
  const client = window.supabase.createClient(supabaseUrl, supabaseAnonKey);

  // Table names are snake_case in Postgres; the app's collection names are
  // camelCase in a couple of places (activityLog, deletionRequests).
  const TABLE_OF = {
    settings: 'settings',
    riders: 'riders',
    clients: 'clients',
    admins: 'admins',
    parcels: 'parcels',
    notifications: 'notifications',
    activityLog: 'activity_log',
    deletionRequests: 'deletion_requests',
  };

  function tableFor(collectionName) {
    const t = TABLE_OF[collectionName];
    if (!t) throw new Error(`Unknown collection "${collectionName}" — add it to TABLE_OF in supabase-adapter.js`);
    return t;
  }

  // The app only ever orders by 'createdAt' or 'updatedAt', both of which
  // are mirrored into real timestamptz columns on every write below, so we
  // can always order by the native column (fast, indexed) instead of the
  // jsonb field.
  function orderColumnFor(field) {
    if (field === 'updatedAt') return 'updated_at';
    return 'created_at';
  }

  function rowToDoc(row) {
    return {
      id: row.id,
      exists: true,
      data: () => row.data,
    };
  }

  function missingDoc(id) {
    return { id, exists: false, data: () => undefined };
  }

  function docRef(collectionName, id) {
    const table = tableFor(collectionName);
    return {
      id,
      async get() {
        const { data: row, error } = await client.from(table).select('id, data').eq('id', id).maybeSingle();
        if (error) throw error;
        return row ? rowToDoc(row) : missingDoc(id);
      },
      async set(data) {
        // Upsert: replaces the doc if it exists, creates it otherwise —
        // matches Firestore's set() semantics. created_at is left alone on
        // conflict since it isn't part of this payload.
        const { error } = await client.from(table).upsert({ id, data }, { onConflict: 'id' });
        if (error) throw error;
      },
      async update(patch) {
        const { error } = await client.rpc('patch_document', {collection_name:table, document_id:id, patch});
        if(error) throw error;
      },
      async delete() {
        const { error } = await client.from(table).delete().eq('id', id);
        if (error) throw error;
      },
      onSnapshot(cb, onError = console.error) {
        let cancelled = false;
        const fetchAndEmit = async () => {
          const { data: row, error } = await client.from(table).select('id, data').eq('id', id).maybeSingle();
          if (cancelled) return;
          if (error) { onError(error); return; }
          cb(row ? rowToDoc(row) : missingDoc(id));
        };
        fetchAndEmit();
        const channel = client
          .channel(`doc:${table}:${id}`)
          .on('postgres_changes', { event: '*', schema: 'public', table, filter: `id=eq.${id}` }, fetchAndEmit)
          .subscribe();
        return () => { cancelled = true; client.removeChannel(channel); };
      },
    };
  }

  function collectionRef(collectionName, opts) {
    const table = tableFor(collectionName);
    const state = Object.assign({ orderField: null, orderDir: 'asc', limitN: null }, opts);

    function applyModifiers(query) {
      if (state.orderField) query = query.order(orderColumnFor(state.orderField), { ascending: state.orderDir !== 'desc' });
      if (state.limitN) query = query.limit(state.limitN);
      return query;
    }

    async function runQuery() {
      const rows = [];
      const pageSize = 500;
      for(let offset=0; ; offset+=pageSize){
        const count = state.limitN ? Math.min(pageSize,state.limitN-offset) : pageSize;
        if(count<=0) break;
        let query = applyModifiers(client.from(table).select('id, data')).order('id').range(offset,offset+count-1);
        const {data, error} = await query;
        if(error) throw error;
        rows.push(...(data||[]));
        if(!data || data.length<count) break;
      }
      const docs = (rows || []).map(rowToDoc);
      return { docs, empty: docs.length === 0, size: docs.length };
    }

    return {
      doc(id) {
        return docRef(collectionName, id || crypto.randomUUID());
      },
      async add(data) {
        const id = crypto.randomUUID();
        const { error } = await client.from(table).insert({ id, data });
        if (error) throw error;
        return docRef(collectionName, id);
      },
      orderBy(field, dir) {
        return collectionRef(collectionName, { ...state, orderField: field, orderDir: dir || 'asc' });
      },
      limit(n) {
        return collectionRef(collectionName, { ...state, limitN: n });
      },
      async get() {
        return runQuery();
      },
      onSnapshot(cb, onError = console.error) {
        let cancelled = false;
        const fetchAndEmit = async () => {
          try {
            const qs = await runQuery();
            if (!cancelled) cb(qs);
          } catch (err) {
            onError(err);
          }
        };
        fetchAndEmit();
        const channel = client
          .channel(`col:${table}:${state.orderField || 'all'}:${state.limitN || 'n'}`)
          .on('postgres_changes', { event: '*', schema: 'public', table }, fetchAndEmit)
          .subscribe();
        return () => { cancelled = true; client.removeChannel(channel); };
      },
    };
  }

  return {
    // Exposed so the app can call Supabase Auth / Edge Functions directly
    // where a real backend call replaces old client-side-only logic
    // (staff login, booking + notifications, creating staff logins).
    _client: client,
    collection(name) {
      return collectionRef(name);
    },
    doc(path) {
      const [collectionName, id] = path.split('/');
      return docRef(collectionName, id);
    },
  };
}
