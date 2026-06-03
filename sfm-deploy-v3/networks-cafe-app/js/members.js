/* ============================================================
   NetWORKs Café — Member area (Phase 1)
   Auth (magic link) · onboarding · directory · my stores ·
   admin approvals + reports · report/block · delete account.
   Renders into #members-root. Requires window.supabase + window.NC_CONFIG.
   ============================================================ */
(function () {
  const ROOT = () => document.getElementById('members-root');
  const cfg = window.NC_CONFIG;
  const Cap = window.Capacitor || null;
  let sb = null;          // supabase client
  let me = null;          // my profile row
  let session = null;
  let tab = 'directory';  // member-area sub tab

  /* ---------- styles (injected once) ---------- */
  const css = `
  #members-root{padding-bottom:20px;}
  .m-pad{padding:20px;}
  .m-h{font-size:22px;font-weight:900;color:#0A1628;letter-spacing:-.4px;margin-bottom:4px;}
  .m-sub{font-size:14px;color:#6b7686;margin-bottom:16px;}
  .m-input,.m-area{width:100%;padding:13px 14px;border:1px solid #e1e5ea;border-radius:12px;font:inherit;font-size:15px;margin-bottom:12px;background:#fff;color:#1c2433;}
  .m-area{min-height:84px;resize:vertical;}
  .m-label{font-size:12px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:#6b7686;margin:2px 2px 6px;}
  .m-btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;background:#F5B82E;color:#0A1628;font-weight:800;font-size:16px;padding:15px;border-radius:13px;}
  .m-btn:active{transform:scale(.98);}
  .m-btn.dark{background:#0A1628;} .m-btn.ghost{background:#fff;border:1px solid #e1e5ea;color:#0A1628;}
  .m-btn.sm{font-size:13px;padding:9px 14px;width:auto;border-radius:10px;}
  .m-btn.danger{background:#fff;border:1px solid #e7b9b9;color:#c0392b;}
  .m-seg{display:flex;gap:6px;background:#eef1f5;border-radius:12px;padding:5px;margin:16px 20px;}
  .m-seg button{flex:1;padding:9px;border-radius:9px;font-size:13px;font-weight:800;color:#6b7686;}
  .m-seg button.on{background:#fff;color:#0A1628;box-shadow:0 1px 4px rgba(0,0,0,.08);}
  .m-card{background:#fff;border:1px solid #e9edf1;border-radius:16px;padding:16px;margin:0 20px 12px;box-shadow:0 2px 8px rgba(0,0,0,.03);}
  .m-row{display:flex;gap:12px;align-items:center;}
  .m-ava{width:52px;height:52px;border-radius:14px;object-fit:cover;background:#dfe4ea;flex-shrink:0;}
  .m-name{font-size:15px;font-weight:800;color:#0A1628;}
  .m-meta{font-size:12px;color:#6b7686;}
  .m-chip{display:inline-block;font-size:11px;font-weight:700;color:#0A1628;background:rgba(245,184,46,.22);padding:3px 9px;border-radius:20px;margin:3px 4px 0 0;}
  .m-note{font-size:13px;color:#6b7686;line-height:1.6;}
  .m-center{text-align:center;padding:48px 28px;}
  .m-center .ico{font-size:46px;margin-bottom:14px;}
  .m-link{color:#0A1628;font-weight:700;text-decoration:underline;}
  .m-back{font-size:14px;font-weight:700;color:#6b7686;padding:14px 20px 0;display:inline-block;}
  .chip{flex-shrink:0;border:1px solid #e1e5ea;background:#fff;border-radius:20px;padding:7px 13px;font-size:12px;font-weight:700;color:#6b7686;}
  .chip.on{background:#0A1628;color:#fff;border-color:#0A1628;}
  .vote{border:1px solid #e1e5ea;background:#fff;border-radius:8px;width:30px;height:26px;font-size:12px;color:#6b7686;}
  .vote.on{background:#F5B82E;color:#0A1628;border-color:#F5B82E;}
  `;
  function injectCss(){ if(!document.getElementById('m-css')){ const s=document.createElement('style'); s.id='m-css'; s.textContent=css; document.head.appendChild(s);} }

  /* ---------- boot ---------- */
  window.NC = {};   // namespace for inline handlers
  document.addEventListener('DOMContentLoaded', init);

  async function init(){
    injectCss();
    if(!cfg || !window.supabase || cfg.SUPABASE_URL.includes('YOUR-PROJECT')){
      return renderNotConfigured();
    }
    sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth:{ flowType:'implicit', detectSessionInUrl:true, persistSession:true, autoRefreshToken:true }
    });

    // Native deep-link return from the magic-link email
    if(Cap && Cap.Plugins && Cap.Plugins.App){
      Cap.Plugins.App.addListener('appUrlOpen', async (data)=>{
        try{
          const url = data.url || '';
          if(url.includes('code=')){ await sb.auth.exchangeCodeForSession(url); }
          await refresh();
        }catch(e){ console.warn('deeplink auth', e); }
      });
    }

    sb.auth.onAuthStateChange((_e, s)=>{ session = s; });
    await refresh();
  }

  async function refresh(){
    const { data:{ session:s } } = await sb.auth.getSession();
    session = s;
    if(!session){ me=null; renderSignIn(); syncBoard(); return; }
    const { data, error } = await sb.from('profiles').select('*').eq('id', session.user.id).single();
    if(error){ console.warn(error); }
    me = data || { id:session.user.id, status:'pending' };
    route(); syncBoard();
  }
  function syncBoard(){
    const a = document.querySelector('.view.active');
    if(a && a.dataset.view === 'community') renderBoard();
  }

  function route(){
    if(!me.terms_accepted_at || !me.full_name) return renderOnboarding();
    if(me.status==='suspended') return renderSuspended();
    if(me.status==='pending')   return renderPending();
    renderMemberArea();
  }

  /* ---------- helpers ---------- */
  function esc(s){ return (s==null?'':String(s)).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function toast(m){ alert(m); }
  async function uploadImage(bucket, file){
    if(!file) return null;
    const ext = (file.name.split('.').pop()||'jpg').toLowerCase();
    const path = `${session.user.id}/${Date.now()}.${ext}`;
    const { error } = await sb.storage.from(bucket).upload(path, file, { upsert:true });
    if(error){ console.warn(error); toast('Image upload failed: '+error.message); return null; }
    return sb.storage.from(bucket).getPublicUrl(path).data.publicUrl;
  }

  /* ---------- screens: auth ---------- */
  function renderNotConfigured(){
    ROOT().innerHTML = `<div class="m-center"><div class="ico">🔌</div>
      <div class="m-h">Member features coming online</div>
      <p class="m-note">The community backend isn't connected in this build yet. Add your Supabase keys in <b>www/js/config.js</b> to switch this on.</p></div>`;
  }

  function renderSignIn(){
    var saved=''; try{ saved=localStorage.getItem('nc_email')||''; }catch(_e){}
    ROOT().innerHTML = `
      <div class="m-pad">
        <div class="m-h">Members</div>
        <p class="m-sub">Sign in with your email to join the NetWORKs Café directory. We'll email you a code — no password, and you stay signed in on this device.</p>
        <div class="m-label">Email</div>
        <input class="m-input" id="m-email" type="email" inputmode="email" autocapitalize="off" autocomplete="email" placeholder="you@yourbusiness.com" value="${esc(saved)}" />
        <button class="m-btn" onclick="NC.sendLink()">Email me a code →</button>
        <div id="m-status" class="m-note" style="margin-top:12px;"></div>
        <p class="m-note" style="margin-top:10px;">New here? Signing in creates your account. A host approves new members before you appear in the directory.</p>
      </div>`;
  }
  NC.renderSignIn = function(){ renderSignIn(); };
  NC.sendLink = async function(){
    const email = (document.getElementById('m-email').value||'').trim();
    const status = document.getElementById('m-status');
    const setStatus = (m,err)=>{ if(status){ status.textContent = m; status.style.color = err ? '#c0392b' : '#6b7686'; } };
    if(!email){ setStatus('Please enter your email first.', true); return; }
    try{ localStorage.setItem('nc_email', email); }catch(_e){}
    setStatus('Sending your code…', false);
    try{
      const { error } = await sb.auth.signInWithOtp({ email, options:{ shouldCreateUser:true } });
      if(error){ setStatus(error.message, true); return; }
      renderCodeEntry(email);
    }catch(e){ setStatus(String((e && e.message) || e), true); }
  };
  function renderCodeEntry(email){
    ROOT().innerHTML = `
      <div class="m-pad">
        <div class="m-h">Enter your code</div>
        <p class="m-sub">We emailed a code to <b>${esc(email)}</b>. Type it in to sign in — you'll stay signed in on this device. (Check spam / promotions too.)</p>
        <div class="m-label">Code</div>
        <input class="m-input" id="m-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="Code from email" style="letter-spacing:8px;font-size:24px;text-align:center;" />
        <button class="m-btn" onclick="NC.verifyCode('${esc(email)}')">Verify &amp; sign in →</button>
        <div id="m-status" class="m-note" style="margin-top:12px;"></div>
        <p class="m-note" style="margin-top:12px;">
          <a href="#" onclick="NC.sendLink2('${esc(email)}');return false;">Resend code</a>
          &nbsp;·&nbsp;
          <a href="#" onclick="NC.renderSignIn();return false;">Use a different email</a>
        </p>
      </div>`;
  }
  NC.sendLink2 = async function(email){
    const status = document.getElementById('m-status');
    if(status){ status.textContent='Resending…'; status.style.color='#6b7686'; }
    try{ const { error } = await sb.auth.signInWithOtp({ email, options:{ shouldCreateUser:true } });
      if(status){ status.textContent = error ? error.message : 'New code sent.'; status.style.color = error ? '#c0392b' : '#6b7686'; }
    }catch(e){ if(status){ status.textContent=String((e&&e.message)||e); status.style.color='#c0392b'; } }
  };
  NC.verifyCode = async function(email){
    const code = (document.getElementById('m-code').value||'').replace(/\s/g,'').trim();
    const status = document.getElementById('m-status');
    const setStatus = (m,err)=>{ if(status){ status.textContent = m; status.style.color = err ? '#c0392b' : '#6b7686'; } };
    if(!/^[0-9]{4,8}$/.test(code)){ setStatus('Enter the code from your email.', true); return; }
    setStatus('Verifying…', false);
    try{
      const { error } = await sb.auth.verifyOtp({ email, token:code, type:'email' });
      if(error){ setStatus(error.message, true); return; }
      await refresh();
    }catch(e){ setStatus(String((e && e.message) || e), true); }
  };

  /* ---------- screens: onboarding ---------- */
  function renderOnboarding(){
    ROOT().innerHTML = `
      <div class="m-pad">
        <div class="m-h">Set up your profile</div>
        <p class="m-sub">This is how other members will see you in the directory.</p>
        <div class="m-label">Your name</div>
        <input class="m-input" id="o-name" value="${esc(me.full_name||'')}" placeholder="First & last name" />
        <div class="m-label">Short bio</div>
        <textarea class="m-area" id="o-bio" placeholder="One or two lines about you and what you do.">${esc(me.bio||'')}</textarea>
        <div class="m-label">Photo (optional)</div>
        <input class="m-input" id="o-photo" type="file" accept="image/*" />
        <label style="display:flex;gap:10px;align-items:flex-start;margin:6px 2px 16px;font-size:13px;color:#6b7686;">
          <input type="checkbox" id="o-terms" style="margin-top:3px;" />
          <span>I agree to the <a class="m-link" onclick="NC.openTerms()">Community Terms</a> and understand there is zero tolerance for objectionable content or abusive behavior.</span>
        </label>
        <button class="m-btn" onclick="NC.saveOnboarding()">Continue →</button>
      </div>`;
  }
  NC.openTerms = function(){ openExt('https://www.salesfunnelmarketing.us/networks-cafe-terms'); };
  NC.saveOnboarding = async function(){
    const name=(document.getElementById('o-name').value||'').trim();
    const bio=(document.getElementById('o-bio').value||'').trim();
    const terms=document.getElementById('o-terms').checked;
    if(!name) return toast('Please enter your name.');
    if(!terms) return toast('Please accept the Community Terms to continue.');
    let headshot = me.headshot_url||null;
    const f=document.getElementById('o-photo').files[0];
    if(f) headshot = await uploadImage('avatars', f) || headshot;
    const { error } = await sb.from('profiles').update({
      full_name:name, bio, headshot_url:headshot, terms_accepted_at:new Date().toISOString()
    }).eq('id', session.user.id);
    if(error) return toast(error.message);
    await refresh();
  };

  /* ---------- screens: status gates ---------- */
  function renderPending(){
    ROOT().innerHTML = `<div class="m-center"><div class="ico">⏳</div>
      <div class="m-h">You're on the list</div>
      <p class="m-note">Thanks, ${esc(me.full_name||'')}! A host is reviewing new members. You'll get access to the directory as soon as you're approved.</p>
      <div style="height:18px"></div>
      <button class="m-btn ghost" onclick="NC.refresh()">Check again</button>
      <div style="height:10px"></div>
      <button class="m-btn ghost" onclick="NC.signOut()">Sign out</button></div>`;
  }
  function renderSuspended(){
    ROOT().innerHTML = `<div class="m-center"><div class="ico">🚫</div>
      <div class="m-h">Account paused</div>
      <p class="m-note">Your access is currently paused. If you think this is a mistake, email <a class="m-link" onclick="NC.openExt('mailto:jayson@salesfunnelmarketing.us')">jayson@salesfunnelmarketing.us</a>.</p>
      <div style="height:18px"></div><button class="m-btn ghost" onclick="NC.signOut()">Sign out</button></div>`;
  }
  NC.refresh = refresh;
  NC.signOut = async function(){ await sb.auth.signOut(); me=null; session=null; renderSignIn(); };

  /* ---------- member area shell ---------- */
  function renderMemberArea(){
    const isAdmin = me.role==='admin';
    ROOT().innerHTML = `
      <div class="m-seg">
        <button class="${tab==='directory'?'on':''}" onclick="NC.tab('directory')">Directory</button>
        <button class="${tab==='referrals'?'on':''}" onclick="NC.tab('referrals')">Referrals</button>
        <button class="${tab==='mine'?'on':''}" onclick="NC.tab('mine')">My Stores</button>
        ${isAdmin?`<button class="${tab==='admin'?'on':''}" onclick="NC.tab('admin')">Admin</button>`:''}
      </div>
      <div id="m-body"></div>`;
    if(tab==='directory') loadDirectory();
    else if(tab==='referrals') loadReferrals();
    else if(tab==='mine') loadMine();
    else if(tab==='admin' && isAdmin) loadAdmin();
  }
  NC.tab = function(t){ tab=t; renderMemberArea(); };

  /* ---------- directory ---------- */
  async function loadDirectory(){
    const body=document.getElementById('m-body');
    body.innerHTML=`<p class="m-note" style="padding:0 20px">Loading members…</p>`;
    const { data, error } = await sb.from('profiles')
      .select('id,full_name,headshot_url,bio,businesses(id,name,category)')
      .eq('status','active').order('full_name');
    if(error){ body.innerHTML=`<p class="m-note" style="padding:0 20px">${esc(error.message)}</p>`; return; }
    if(!data.length){ body.innerHTML=`<div class="m-center"><div class="ico">👋</div><div class="m-h">No members yet</div><p class="m-note">You're early! Once members are approved they'll show here.</p></div>`; return; }
    body.innerHTML = data.map(p=>`
      <div class="m-card" onclick="NC.openMember('${p.id}')">
        <div class="m-row">
          <img class="m-ava" src="${esc(p.headshot_url||'assets/logo.png?v=2')}" onerror="this.src='assets/logo.png?v=2'"/>
          <div style="min-width:0;flex:1">
            <div class="m-name">${esc(p.full_name||'Member')}</div>
            <div class="m-meta">${(p.businesses||[]).map(b=>esc(b.name)).join(' · ')||'Member'}</div>
          </div>
          <span style="color:#c3c9d2;font-size:20px">›</span>
        </div>
      </div>`).join('');
  }

  /* ---------- referrals ---------- */
  async function loadReferrals(){
    const body=document.getElementById('m-body');
    body.innerHTML=`<p class="m-note" style="padding:0 20px">Loading…</p>`;
    const { data:asks, error } = await sb.from('asks').select('*').eq('status','open').order('created_at',{ascending:false});
    if(error){ body.innerHTML=`<p class="m-note" style="padding:0 20px">${esc(error.message)}</p>`; return; }
    const ids=[...new Set((asks||[]).map(a=>a.author_id))];
    let names={};
    if(ids.length){ const { data:profs } = await sb.from('profiles').select('id,full_name').in('id',ids); (profs||[]).forEach(p=>names[p.id]=p.full_name); }
    body.innerHTML = `
      <div class="m-pad" style="padding-bottom:8px">
        <button class="m-btn" onclick="NC.postAsk()">＋ Post an ask</button>
        <p class="m-note" style="margin-top:8px">Need a referral? Post what you're looking for — members who can help will raise their hand.</p>
      </div>
      ${(asks&&asks.length)? asks.map(a=>{
        const mine=a.author_id===me.id;
        return `<div class="m-card">
          <div class="m-meta">${esc(names[a.author_id]||'Member')}${a.category?' · '+esc(a.category):''}</div>
          <div class="m-name" style="margin:4px 0 10px;font-size:15px;line-height:1.4">${esc(a.body)}</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            ${mine
              ? `<button class="m-btn sm" onclick="NC.viewAsk('${a.id}')">${a.response_count} can help ›</button><button class="m-btn ghost sm" onclick="NC.closeAsk('${a.id}')">Close</button>`
              : `<button class="m-btn sm" onclick="NC.helpAsk('${a.id}')">🤝 I can help</button>${a.response_count?`<span class="m-note">${a.response_count} raised a hand</span>`:''}`}
          </div>
        </div>`; }).join('')
        : `<div class="m-center"><div class="ico">🤝</div><div class="m-h">No open asks yet</div><p class="m-note">Be the first — post what you're looking for.</p></div>`}`;
  }
  NC.postAsk = function(){
    const body=document.getElementById('m-body');
    body.innerHTML=`<a class="m-back" onclick="NC.tab('referrals')">‹ Back</a>
      <div class="m-pad" style="padding-top:8px">
        <div class="m-h">Post an ask</div>
        <div class="m-label">Category (optional)</div><input class="m-input" id="ask-cat" placeholder="e.g. Roofer, CPA, Photographer"/>
        <div class="m-label">What are you looking for?</div><textarea class="m-area" id="ask-body" placeholder="Looking for a reliable roofer in Perrysburg for a small repair…"></textarea>
        <button class="m-btn" onclick="NC.submitAsk()">Post to members</button>
      </div>`;
  };
  NC.submitAsk = async function(){
    const bodyTxt=(document.getElementById('ask-body').value||'').trim();
    if(!bodyTxt) return toast('Tell members what you need.');
    const { error } = await sb.from('asks').insert({ author_id:me.id, category:(document.getElementById('ask-cat').value||'').trim()||null, body:bodyTxt });
    if(error) return toast(error.message);
    NC.tab('referrals');
  };
  NC.helpAsk = async function(askId){
    const note = prompt('Add a quick note (optional) — e.g. "I do this, happy to help":') || null;
    const { error } = await sb.from('ask_responses').insert({ ask_id:askId, responder_id:me.id, note });
    if(error){ toast(/duplicate/i.test(error.message)?'You already raised your hand on this.':error.message); return; }
    toast('Nice — they will see you can help.'); loadReferrals();
  };
  NC.viewAsk = async function(askId){
    const body=document.getElementById('m-body');
    const { data:ask } = await sb.from('asks').select('*').eq('id',askId).single();
    const { data:resp } = await sb.from('ask_responses').select('*').eq('ask_id',askId).order('created_at');
    const ids=[...new Set((resp||[]).map(r=>r.responder_id))];
    let profs={}; if(ids.length){ const { data:p } = await sb.from('profiles').select('id,full_name,email,headshot_url').in('id',ids); (p||[]).forEach(x=>profs[x.id]=x); }
    body.innerHTML=`<a class="m-back" onclick="NC.tab('referrals')">‹ Back</a>
      <div class="m-pad" style="padding-top:8px">
        <div class="m-h">Who can help</div>
        <p class="m-note" style="margin-bottom:12px">${esc(ask?ask.body:'')}</p>
        ${(resp&&resp.length)? resp.map(r=>{ const p=profs[r.responder_id]||{}; return `
          <div class="m-card">
            <div class="m-row"><img class="m-ava" src="${esc(p.headshot_url||'assets/logo.png?v=2')}" onerror="this.src='assets/logo.png?v=2'"/>
              <div style="flex:1;min-width:0"><div class="m-name">${esc(p.full_name||'Member')}</div>${r.note?`<div class="m-meta">${esc(r.note)}</div>`:''}</div></div>
            <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
              <button class="m-btn sm" onclick="NC.intro('${askId}','${r.responder_id}','${esc((p.email||'').replace(/'/g,''))}')">Connect &amp; refer</button>
              <button class="m-btn ghost sm" onclick="NC.openMember('${r.responder_id}')">View profile</button>
            </div>
          </div>`; }).join('')
          : `<p class="m-note">No one's raised a hand yet — give it time.</p>`}
      </div>`;
  };
  NC.intro = async function(askId, responderId, email){
    await sb.from('referrals').insert({ ask_id:askId, from_member:me.id, to_member:responderId });
    if(email){ NC.openExt('mailto:'+email); }
    toast('Logged as a referral — now make the connection!');
  };
  NC.closeAsk = async function(askId){
    if(!confirm('Close this ask? It will stop showing to members.')) return;
    await sb.from('asks').update({status:'closed'}).eq('id',askId); loadReferrals();
  };

  NC.openMember = async function(id){
    const body=document.getElementById('m-body');
    const { data:p } = await sb.from('profiles').select('id,full_name,email,phone,phone_public,headshot_url,bio').eq('id',id).single();
    const { data:biz } = await sb.from('businesses').select('*').eq('owner_id',id).eq('is_published',true).eq('status','active');
    if(!p){ toast('Member not found.'); return; }
    const mine = p.id===me.id;
    body.innerHTML = `
      <a class="m-back" onclick="NC.tab('directory')">‹ Directory</a>
      <div class="m-pad" style="padding-top:8px">
        <div class="m-row" style="margin-bottom:14px">
          <img class="m-ava" style="width:66px;height:66px" src="${esc(p.headshot_url||'assets/logo.png?v=2')}" onerror="this.src='assets/logo.png?v=2'"/>
          <div><div class="m-name" style="font-size:18px">${esc(p.full_name||'Member')}</div>
          ${p.email?`<div class="m-meta"><a class="m-link" onclick="NC.openExt('mailto:${esc(p.email)}')">${esc(p.email)}</a></div>`:''}
          ${(p.phone_public&&p.phone)?`<div class="m-meta">${esc(p.phone)}</div>`:''}</div>
        </div>
        ${p.bio?`<p class="m-note" style="margin-bottom:16px">${esc(p.bio)}</p>`:''}
        ${(biz||[]).map(b=>`
          <div class="m-card" style="margin:0 0 12px">
            <div class="m-row">
              <img class="m-ava" src="${esc(b.logo_url||'assets/logo.png?v=2')}" onerror="this.src='assets/logo.png?v=2'"/>
              <div style="flex:1;min-width:0"><div class="m-name">${esc(b.name)}</div><div class="m-meta">${esc(b.category||'')}${b.city?' · '+esc(b.city):''}</div></div>
            </div>
            ${b.description?`<p class="m-note" style="margin-top:10px">${esc(b.description)}</p>`:''}
            <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
              ${b.website?`<button class="m-btn ghost sm" onclick="NC.openExt('${esc(b.website)}')">Website</button>`:''}
              ${b.phone?`<button class="m-btn ghost sm" onclick="NC.openExt('tel:${esc(b.phone)}')">Call</button>`:''}
              ${b.google_review_url?`<button class="m-btn sm" onclick="NC.openExt('${esc(b.google_review_url)}')">⭐ Leave a Review</button>`:''}
            </div>
          </div>`).join('')}
        ${mine?'':`
        <div style="display:flex;gap:10px;margin-top:18px">
          <button class="m-btn ghost sm" onclick="NC.report('profile','${p.id}')">⚑ Report</button>
          <button class="m-btn danger sm" onclick="NC.block('${p.id}')">⊘ Block</button>
        </div>`}
      </div>`;
  };

  NC.report = async function(type,id){
    const reason = prompt('Briefly, what\'s wrong with this '+type+'?');
    if(reason===null) return;
    const { error } = await sb.from('reports').insert({ reporter_id:me.id, target_type:type, target_id:id, reason });
    toast(error ? error.message : 'Thanks — a host will review this.');
  };
  NC.block = async function(id){
    if(!confirm('Block this member? You won\'t see each other in the directory or chat.')) return;
    const { error } = await sb.from('blocks').insert({ blocker_id:me.id, blocked_id:id });
    if(error) return toast(error.message);
    toast('Member blocked.'); NC.tab('directory');
  };

  /* ---------- my stores ---------- */
  async function loadMine(){
    const body=document.getElementById('m-body');
    const { data:biz } = await sb.from('businesses').select('*').eq('owner_id',me.id).order('created_at');
    body.innerHTML = `
      <div class="m-pad">
        <div class="m-row" style="margin-bottom:8px">
          <img class="m-ava" src="${esc(me.headshot_url||'assets/logo.png?v=2')}" onerror="this.src='assets/logo.png?v=2'"/>
          <div style="flex:1"><div class="m-name">${esc(me.full_name||'You')}</div><div class="m-meta">${esc(me.email||'')}</div></div>
          <button class="m-btn ghost sm" onclick="NC.editProfile()">Edit</button>
        </div>
      </div>
      <div class="m-seg" style="margin-top:0"><div style="flex:1;padding:6px 4px;font-weight:800;color:#0A1628">Your businesses</div>
        <button class="on" onclick="NC.editBiz()">+ Add</button></div>
      ${(biz&&biz.length)? biz.map(b=>`
        <div class="m-card">
          <div class="m-row">
            <img class="m-ava" src="${esc(b.logo_url||'assets/logo.png?v=2')}" onerror="this.src='assets/logo.png?v=2'"/>
            <div style="flex:1;min-width:0"><div class="m-name">${esc(b.name)}</div><div class="m-meta">${esc(b.category||'')} · ${b.is_published?'Published':'Hidden'}</div></div>
          </div>
          <div style="margin-top:10px;display:flex;gap:8px">
            <button class="m-btn ghost sm" onclick="NC.editBiz('${b.id}')">Edit</button>
            <button class="m-btn danger sm" onclick="NC.delBiz('${b.id}')">Delete</button>
          </div>
        </div>`).join('') : `<p class="m-note" style="padding:0 20px">No businesses yet — tap <b>+ Add</b> to list your store.</p>`}
      <div class="m-pad" style="margin-top:18px">
        <button class="m-btn ghost" onclick="NC.signOut()">Sign out</button>
        <div style="height:10px"></div>
        <button class="m-btn danger" onclick="NC.deleteAccount()">Delete my account</button>
      </div>`;
  }

  NC.editProfile = function(){
    const body=document.getElementById('m-body');
    body.innerHTML=`<a class="m-back" onclick="NC.tab('mine')">‹ Back</a>
      <div class="m-pad" style="padding-top:8px">
        <div class="m-h">Edit profile</div>
        <div class="m-label">Name</div><input class="m-input" id="p-name" value="${esc(me.full_name||'')}"/>
        <div class="m-label">Bio</div><textarea class="m-area" id="p-bio">${esc(me.bio||'')}</textarea>
        <div class="m-label">Phone</div><input class="m-input" id="p-phone" value="${esc(me.phone||'')}" placeholder="Optional"/>
        <label style="display:flex;gap:8px;align-items:center;font-size:13px;color:#6b7686;margin:0 2px 14px"><input type="checkbox" id="p-phpub" ${me.phone_public?'checked':''}/> Show my phone in the directory</label>
        <div class="m-label">New photo</div><input class="m-input" id="p-photo" type="file" accept="image/*"/>
        <button class="m-btn" onclick="NC.saveProfile()">Save</button>
      </div>`;
  };
  NC.saveProfile = async function(){
    let headshot=me.headshot_url||null; const f=document.getElementById('p-photo').files[0];
    if(f) headshot=await uploadImage('avatars',f)||headshot;
    const upd={ full_name:(document.getElementById('p-name').value||'').trim(), bio:document.getElementById('p-bio').value.trim(),
      phone:document.getElementById('p-phone').value.trim(), phone_public:document.getElementById('p-phpub').checked, headshot_url:headshot };
    const { error } = await sb.from('profiles').update(upd).eq('id',me.id);
    if(error) return toast(error.message);
    me={...me,...upd}; NC.tab('mine');
  };

  NC.editBiz = async function(id){
    let b={ name:'',category:'',description:'',website:'',phone:'',address:'',city:'',logo_url:'',is_published:true };
    if(id){ const { data } = await sb.from('businesses').select('*').eq('id',id).single(); if(data) b=data; }
    const body=document.getElementById('m-body');
    body.innerHTML=`<a class="m-back" onclick="NC.tab('mine')">‹ Back</a>
      <div class="m-pad" style="padding-top:8px">
        <div class="m-h">${id?'Edit business':'Add business'}</div>
        <div class="m-label">Business name</div><input class="m-input" id="b-name" value="${esc(b.name)}"/>
        <div class="m-label">Category</div><input class="m-input" id="b-cat" value="${esc(b.category||'')}" placeholder="e.g. Salon, HVAC, Photographer"/>
        <div class="m-label">Description</div><textarea class="m-area" id="b-desc">${esc(b.description||'')}</textarea>
        <div class="m-label">Website</div><input class="m-input" id="b-web" value="${esc(b.website||'')}" placeholder="https://"/>
        <div class="m-label">Google review link</div><input class="m-input" id="b-review" value="${esc(b.google_review_url||'')}" placeholder="https://g.page/r/.../review"/>
        <div class="m-note" style="margin:-8px 2px 14px">Paste your Google "leave a review" link — fellow members can tap it to leave you a 5★ review. (Find it in Google Business Profile → "Ask for reviews".)</div>
        <div class="m-label">Phone</div><input class="m-input" id="b-phone" value="${esc(b.phone||'')}"/>
        <div class="m-label">City</div><input class="m-input" id="b-city" value="${esc(b.city||'')}"/>
        <div class="m-label">Logo</div><input class="m-input" id="b-logo" type="file" accept="image/*"/>
        <label style="display:flex;gap:8px;align-items:center;font-size:13px;color:#6b7686;margin:0 2px 14px"><input type="checkbox" id="b-pub" ${b.is_published?'checked':''}/> Show in the directory</label>
        <button class="m-btn" onclick="NC.saveBiz('${id||''}','${esc(b.logo_url||'')}')">Save business</button>
      </div>`;
  };
  NC.saveBiz = async function(id, existingLogo){
    const name=(document.getElementById('b-name').value||'').trim();
    if(!name) return toast('Business name is required.');
    let logo=existingLogo||null; const f=document.getElementById('b-logo').files[0];
    if(f) logo=await uploadImage('business-logos',f)||logo;
    const row={ owner_id:me.id, name, category:document.getElementById('b-cat').value.trim(),
      description:document.getElementById('b-desc').value.trim(), website:document.getElementById('b-web').value.trim(),
      phone:document.getElementById('b-phone').value.trim(), city:document.getElementById('b-city').value.trim(),
      google_review_url:(document.getElementById('b-review').value||'').trim(),
      logo_url:logo, is_published:document.getElementById('b-pub').checked };
    const res = id ? await sb.from('businesses').update(row).eq('id',id) : await sb.from('businesses').insert(row);
    if(res.error) return toast(res.error.message);
    NC.tab('mine');
  };
  NC.delBiz = async function(id){
    if(!confirm('Delete this business?')) return;
    const { error } = await sb.from('businesses').delete().eq('id',id);
    if(error) return toast(error.message);
    loadMine();
  };

  NC.deleteAccount = async function(){
    if(!confirm('Permanently delete your account and all your content? This cannot be undone.')) return;
    const { error } = await sb.functions.invoke('delete-account', { method:'POST' });
    if(error) return toast('Could not delete: '+error.message);
    await sb.auth.signOut(); me=null; session=null;
    toast('Your account has been deleted.'); renderSignIn();
  };

  /* ---------- admin ---------- */
  async function loadAdmin(){
    const body=document.getElementById('m-body');
    const { data:pending } = await sb.from('profiles').select('id,full_name,email,bio,created_at').eq('status','pending').order('created_at');
    const { data:reports } = await sb.from('reports').select('*').eq('status','open').order('created_at',{ascending:false});
    body.innerHTML = `
      <div class="m-pad" style="padding-bottom:6px"><div class="m-h">Approvals</div>
        <p class="m-sub">${(pending&&pending.length)||0} member${(pending&&pending.length)===1?'':'s'} waiting.</p></div>
      ${(pending&&pending.length)? pending.map(p=>`
        <div class="m-card">
          <div class="m-name">${esc(p.full_name||'(no name)')}</div>
          <div class="m-meta">${esc(p.email||'')}</div>
          ${p.bio?`<p class="m-note" style="margin-top:6px">${esc(p.bio)}</p>`:''}
          <div style="margin-top:10px;display:flex;gap:8px">
            <button class="m-btn sm" onclick="NC.approve('${p.id}')">Approve</button>
            <button class="m-btn danger sm" onclick="NC.decline('${p.id}')">Decline</button>
          </div>
        </div>`).join('') : `<p class="m-note" style="padding:0 20px 8px">No one waiting. 🎉</p>`}
      <div class="m-pad" style="padding-bottom:6px;padding-top:20px"><div class="m-h">Reports</div>
        <p class="m-sub">${(reports&&reports.length)||0} open.</p></div>
      ${(reports&&reports.length)? reports.map(r=>`
        <div class="m-card">
          <div class="m-name">${esc(r.target_type)} reported</div>
          <div class="m-meta">${esc(r.reason||'')}</div>
          <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
            <button class="m-btn danger sm" onclick="NC.modHide('${r.id}','${r.target_type}','${r.target_id}')">Hide content</button>
            <button class="m-btn danger sm" onclick="NC.modSuspend('${r.id}','${r.target_type}','${r.target_id}')">Suspend user</button>
            <button class="m-btn ghost sm" onclick="NC.modDismiss('${r.id}')">Dismiss</button>
          </div>
        </div>`).join('') : `<p class="m-note" style="padding:0 20px">No open reports.</p>`}`;
  }
  NC.approve = async function(id){ await sb.from('profiles').update({status:'active'}).eq('id',id); loadAdmin(); };
  NC.decline = async function(id){ if(confirm('Decline & remove this signup?')){ await sb.from('profiles').update({status:'suspended'}).eq('id',id); loadAdmin(); } };
  NC.modDismiss = async function(rid){ await sb.from('reports').update({status:'dismissed',reviewed_by:me.id,reviewed_at:new Date().toISOString()}).eq('id',rid); loadAdmin(); };
  NC.modHide = async function(rid,type,tid){
    const table={message:'messages',offer:'offers',event:'events',business:'businesses',profile:'profiles',post:'posts',comment:'comments'}[type];
    const val = type==='profile' ? {status:'suspended'} : {status:'hidden'};
    await sb.from(table).update(val).eq('id',tid);
    await sb.from('reports').update({status:'actioned',reviewed_by:me.id,reviewed_at:new Date().toISOString()}).eq('id',rid);
    loadAdmin();
  };
  NC.modSuspend = async function(rid,type,tid){
    // suspend the author of the reported content
    let ownerId=tid;
    if(type!=='profile'){ const t={message:'messages',offer:'offers',event:'events',business:'businesses',post:'posts',comment:'comments'}[type];
      const col = type==='message'?'sender_id':((type==='post'||type==='comment')?'author_id':'owner_id');
      const { data } = await sb.from(t).select(col).eq('id',tid).single(); ownerId = data? data[col] : null; }
    if(ownerId) await sb.from('profiles').update({status:'suspended'}).eq('id',ownerId);
    await sb.from('reports').update({status:'actioned',reviewed_by:me.id,reviewed_at:new Date().toISOString()}).eq('id',rid);
    loadAdmin();
  };

  /* ---------- external links (in-app browser on device) ---------- */
  function openExt(url){
    if(url.startsWith('mailto:')||url.startsWith('tel:')){ window.location.href=url; return; }
    try{ if(Cap&&Cap.Plugins&&Cap.Plugins.Browser){ Cap.Plugins.Browser.open({url}); return; } }catch(e){}
    window.open(url,'_blank');
  }
  NC.openExt = openExt;

  /* ============================================================
     DISCUSSION BOARD (Community tab) — posts, comments, upvotes
     ============================================================ */
  const CATS = [['all','All'],['general','General'],['referrals','Referrals'],['wins','Wins'],['questions','Questions'],['events','Events']];
  const CATLABEL = {general:'General',referrals:'Referrals',wins:'Wins',questions:'Questions',events:'Events'};
  let boardCat='all', boardSort='new', myVotes=new Set();

  NC.onTab = function(name){ if(name==='community') renderBoard(); };
  function boardRoot(){ return document.getElementById('board-root'); }

  function renderBoard(){
    const root = boardRoot(); if(!root) return;
    if(!sb){ root.innerHTML=''; return; }
    if(!session || !me){ root.innerHTML = boardPrompt('Sign in to join the discussion.'); return; }
    if(me.status!=='active'){ root.innerHTML = boardPrompt(me.status==='pending'
      ? 'Your membership is pending approval — you can join the discussion once a host approves you.'
      : 'Your access is paused.'); return; }
    loadBoard();
  }
  function boardPrompt(msg){
    return `<div class="m-card" style="text-align:center;"><div style="font-size:30px;margin-bottom:8px;">💬</div>`+
      `<div class="m-name" style="margin-bottom:6px;">Discussion Board</div><p class="m-note">${esc(msg)}</p>`+
      `<button class="m-btn ghost sm" style="margin:12px auto 0;" onclick="NC.goMembers()">Go to Members ›</button></div>`;
  }
  NC.goMembers = function(){ if(window.goTab) window.goTab('members'); };

  async function loadBoard(){
    const root = boardRoot(); if(!root) return;
    root.innerHTML = `<div id="boardBar"></div><div id="boardList"><p class="m-note" style="padding:0 20px">Loading…</p></div>`;
    renderBoardBar();
    let q = sb.from('posts').select('id,title,body,category,vote_count,comment_count,author_id').eq('status','visible');
    if(boardCat!=='all') q = q.eq('category', boardCat);
    q = boardSort==='top'
      ? q.order('vote_count',{ascending:false}).order('last_activity_at',{ascending:false})
      : q.order('last_activity_at',{ascending:false});
    const { data, error } = await q.limit(50);
    const list = document.getElementById('boardList');
    if(error){ list.innerHTML = `<p class="m-note" style="padding:0 20px">${esc(error.message)}</p>`; return; }
    myVotes = new Set();
    if(data.length){
      const ids = data.map(p=>p.id);
      const { data:v } = await sb.from('post_votes').select('post_id').in('post_id', ids).eq('user_id', me.id);
      (v||[]).forEach(x=>myVotes.add(x.post_id));
      const aids = [...new Set(data.map(p=>p.author_id))];
      const { data:profs } = await sb.from('profiles').select('id,full_name,headshot_url').in('id', aids);
      const pm = {}; (profs||[]).forEach(x=>pm[x.id]=x);
      data.forEach(p=>{ p.author = pm[p.author_id] || null; });
    }
    if(!data.length){ list.innerHTML = `<div class="m-center" style="padding:30px 28px;"><div class="ico" style="font-size:38px">💬</div><div class="m-h">No posts yet</div><p class="m-note">Start the conversation — tap “New post”.</p></div>`; return; }
    list.innerHTML = data.map(boardCard).join('');
  }

  function renderBoardBar(){
    const bar = document.getElementById('boardBar'); if(!bar) return;
    bar.innerHTML =
      `<div style="display:flex;gap:8px;overflow-x:auto;padding:14px 20px 6px;scrollbar-width:none;">`+
        CATS.map(c=>`<button class="chip${boardCat===c[0]?' on':''}" onclick="NC.boardCat('${c[0]}')">${c[1]}</button>`).join('')+
      `</div>`+
      `<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 20px 12px;">`+
        `<div style="display:flex;gap:6px;">`+
          `<button class="chip${boardSort==='new'?' on':''}" onclick="NC.boardSort('new')">Newest</button>`+
          `<button class="chip${boardSort==='top'?' on':''}" onclick="NC.boardSort('top')">Top</button>`+
        `</div>`+
        `<button class="m-btn sm" style="width:auto;" onclick="NC.newPost()">+ New post</button>`+
      `</div>`;
  }
  NC.boardCat = function(c){ boardCat=c; loadBoard(); };
  NC.boardSort = function(s){ boardSort=s; loadBoard(); };

  function boardCard(p){
    const voted = myVotes.has(p.id);
    return `<div class="m-card" style="display:flex;gap:12px;">`+
      `<div style="display:flex;flex-direction:column;align-items:center;gap:3px;min-width:34px;">`+
        `<button class="vote${voted?' on':''}" onclick="event.stopPropagation();NC.vote('${p.id}')" aria-label="Upvote">▲</button>`+
        `<span style="font-size:13px;font-weight:800;color:#0A1628;">${p.vote_count}</span>`+
      `</div>`+
      `<div style="flex:1;min-width:0;" onclick="NC.openPost('${p.id}')">`+
        `<span class="m-chip">${esc(CATLABEL[p.category]||p.category)}</span>`+
        `<div class="m-name" style="margin-top:5px;">${esc(p.title)}</div>`+
        (p.body?`<p class="m-note" style="margin-top:4px;max-height:38px;overflow:hidden;">${esc(p.body)}</p>`:'')+
        `<div class="m-meta" style="margin-top:6px;">${esc((p.author&&p.author.full_name)||'Member')} · 💬 ${p.comment_count}</div>`+
      `</div>`+
    `</div>`;
  }

  async function toggleVote(id){
    if(myVotes.has(id)){ await sb.from('post_votes').delete().eq('post_id',id).eq('user_id',me.id); myVotes.delete(id); }
    else { const { error } = await sb.from('post_votes').insert({post_id:id,user_id:me.id}); if(!error) myVotes.add(id); }
  }
  NC.vote = async function(id){ await toggleVote(id); loadBoard(); };
  NC.votePost = async function(id){ await toggleVote(id); NC.openPost(id); };

  NC.openPost = async function(id){
    const root = boardRoot(); if(!root) return;
    const { data:p } = await sb.from('posts').select('*').eq('id',id).single();
    if(!p){ toast('Post not found.'); return; }
    const { data:ap } = await sb.from('profiles').select('full_name,headshot_url').eq('id',p.author_id).single();
    p.author = ap;
    const { data:cs } = await sb.from('comments').select('*').eq('post_id',id).eq('status','visible').order('created_at');
    if(cs && cs.length){
      const caids = [...new Set(cs.map(c=>c.author_id))];
      const { data:cp } = await sb.from('profiles').select('id,full_name').in('id', caids);
      const cm = {}; (cp||[]).forEach(x=>cm[x.id]=x);
      cs.forEach(c=>{ c.author = cm[c.author_id] || null; });
    }
    const { data:mv } = await sb.from('post_votes').select('post_id').eq('post_id',id).eq('user_id',me.id);
    const voted = (mv&&mv.length)>0; if(voted) myVotes.add(id); else myVotes.delete(id);
    const mine = p.author_id===me.id;
    const n = (cs||[]).length;
    root.innerHTML =
      `<a class="m-back" onclick="NC.boardBack()">‹ Board</a>`+
      `<div class="m-pad" style="padding-top:8px;">`+
        `<span class="m-chip">${esc(CATLABEL[p.category]||p.category)}</span>`+
        `<h2 class="m-h" style="margin-top:6px;">${esc(p.title)}</h2>`+
        `<div class="m-meta" style="margin-bottom:10px;">${esc((p.author&&p.author.full_name)||'Member')}</div>`+
        (p.body?`<p class="m-note" style="white-space:pre-wrap;margin-bottom:14px;color:#1c2433;">${esc(p.body)}</p>`:'')+
        `<div style="display:flex;gap:10px;align-items:center;">`+
          `<button class="m-btn ghost sm" style="width:auto;${voted?'border-color:#DDA017;color:#0A1628;':''}" onclick="NC.votePost('${p.id}')">▲ ${p.vote_count}</button>`+
          (mine?`<button class="m-btn danger sm" style="width:auto;" onclick="NC.delPost('${p.id}')">Delete</button>`
               :`<button class="m-btn ghost sm" style="width:auto;" onclick="NC.report('post','${p.id}')">⚑ Report</button>`)+
        `</div>`+
      `</div>`+
      `<div class="m-pad" style="padding-top:0;">`+
        `<div class="m-label">${n} ${n===1?'reply':'replies'}</div>`+
        `<textarea class="m-area" id="c-body" placeholder="Write a reply…"></textarea>`+
        `<button class="m-btn" onclick="NC.addComment('${id}')">Reply</button>`+
        `<div style="height:14px;"></div>`+
        (cs||[]).map(c=>`<div class="m-card" style="margin:0 0 10px;">`+
          `<div class="m-meta" style="margin-bottom:4px;">${esc((c.author&&c.author.full_name)||'Member')}</div>`+
          `<p class="m-note" style="white-space:pre-wrap;color:#1c2433;">${esc(c.body)}</p>`+
          `<div style="margin-top:8px;">`+(c.author_id===me.id
            ?`<button class="m-btn danger sm" style="width:auto;" onclick="NC.delComment('${c.id}','${id}')">Delete</button>`
            :`<button class="m-btn ghost sm" style="width:auto;" onclick="NC.report('comment','${c.id}')">⚑ Report</button>`)+`</div>`+
        `</div>`).join('')+
      `</div>`;
  };
  NC.boardBack = function(){ loadBoard(); };

  NC.newPost = function(){
    const root = boardRoot(); if(!root) return;
    root.innerHTML =
      `<a class="m-back" onclick="NC.boardBack()">‹ Board</a>`+
      `<div class="m-pad" style="padding-top:8px;">`+
        `<div class="m-h">New post</div>`+
        `<div class="m-label">Category</div>`+
        `<select class="m-input" id="np-cat">`+CATS.filter(c=>c[0]!=='all').map(c=>`<option value="${c[0]}">${c[1]}</option>`).join('')+`</select>`+
        `<div class="m-label">Title</div>`+
        `<input class="m-input" id="np-title" placeholder="A clear, short title" />`+
        `<div class="m-label">Details (optional)</div>`+
        `<textarea class="m-area" id="np-body" placeholder="Add context, a question, a win…"></textarea>`+
        `<button class="m-btn" onclick="NC.submitPost()">Post to the board</button>`+
      `</div>`;
  };
  NC.submitPost = async function(){
    const title = (document.getElementById('np-title').value||'').trim();
    if(!title) return toast('Add a title first.');
    const row = { author_id:me.id, category:document.getElementById('np-cat').value, title, body:document.getElementById('np-body').value.trim() };
    const { error } = await sb.from('posts').insert(row);
    if(error) return toast(error.message);
    loadBoard();
  };
  NC.addComment = async function(pid){
    const body = (document.getElementById('c-body').value||'').trim();
    if(!body) return toast('Write a reply first.');
    const { error } = await sb.from('comments').insert({ post_id:pid, author_id:me.id, body });
    if(error) return toast(error.message);
    NC.openPost(pid);
  };
  NC.delPost = async function(id){ if(!confirm('Delete this post?')) return; await sb.from('posts').delete().eq('id',id); loadBoard(); };
  NC.delComment = async function(id,pid){ if(!confirm('Delete this reply?')) return; await sb.from('comments').delete().eq('id',id); NC.openPost(pid); };
})();
