// Formwright application: navigation, record screens and the form designer.
// Admin screens (users and groups) live in admin.js; data access in store.js.

import { store, uploadFile, deleteFormCascade, loadExamples as writeExamples } from './store.js';
import { FX } from './formulas.js';
import { isAdmin, formLevel, canViewForm, canCreate, canEditRecord } from './access.js';
import * as admin from './admin.js';
import { signOutUser } from './auth.js';
import { $, esc, uid, clone, isEmpty, toast, COLORS, colorOf, itemName, badge } from './ui.js';
import examples from './examples.json';

const ADMIN_VIEWS = new Set(['designer', 'formEdit', 'users', 'groups', 'groupEdit']);

const TYPES=[
 ['text','Short text','Aa','Text'],['textarea','Long text','¶','Text'],
 ['email','Email','@','Contact'],['phone','Phone','+1','Contact'],['url','Website','//','Contact'],['location','Location','⌖','Contact'],
 ['number','Whole number','12','Numbers'],['decimal','Decimal','1.5','Numbers'],['currency','Currency','$','Numbers'],['percent','Percent','%','Numbers'],['rating','Rating','★','Numbers'],['range','Slider','⟷','Numbers'],['formula','Calculation','ƒx','Numbers'],
 ['date','Date','D','Date & time'],['time','Time','T','Date & time'],['datetime','Date & time','DT','Date & time'],
 ['checkbox','Yes / No','✓','Choices'],['select','Dropdown','▾','Choices'],['radio','Single choice','◉','Choices'],['multiselect','Multiple choice','☰','Choices'],
 ['file','File upload','⇪','Media'],['image','Photo','▣','Media'],['signature','Signature','✎','Media'],['color','Color','◐','Media'],
 ['relation','Link to record','↗','Relations'],['heading','Section heading','§','Layout']];
const T=Object.fromEntries(TYPES.map(t=>[t[0],{label:t[1],glyph:t[2],group:t[3]}]));
const CHOICE=new Set(['select','radio','multiselect']);
const NUMERIC=new Set(['number','decimal','currency','percent','range','rating']);
const PLACEHOLDER=new Set(['text','textarea','email','phone','url','number','decimal','currency','percent']);
const NOCOL=new Set(['heading','signature','textarea']);

/* ---------- Lookups ---------- */
const formById=id=>store.forms.find(f=>f.id===id);
const recById=id=>store.records.find(r=>r.id===id);
const byOrder=(a,b)=>(a.order??0)-(b.order??0)||a.name.localeCompare(b.name);
function titleFieldOf(form){
  const fs=(form.fields||[]);
  return fs.find(f=>f.id===form.titleField)||fs.find(f=>['text','email','phone','url'].includes(f.type))||fs.find(f=>f.type!=='heading');
}
function recTitle(rec,form){
  form=form||formById(rec.formId); if(!form)return 'Untitled';
  const f=titleFieldOf(form); const t=f?fmt(f,valOf(f,rec)):'';
  return t||('Untitled '+itemName(form).toLowerCase());
}
const parentsOf=formId=>store.forms.filter(f=>(f.children||[]).some(c=>c.formId===formId)).sort(byOrder);
const recordsOf=formId=>store.records.filter(r=>r.formId===formId);

function fmt(f,v){
  if(f.type!=='formula'&&isEmpty(v))return '';
  try{switch(f.type){
    case 'formula':return fmtCalc(f,v);
    case 'checkbox':return v?'Yes':'No';
    case 'decimal':return Number(v).toLocaleString(undefined,{minimumFractionDigits:f.decimals??2,maximumFractionDigits:f.decimals??2});
    case 'number':return Number(v).toLocaleString();
    case 'currency':return new Intl.NumberFormat(undefined,{style:'currency',currency:(f.currency||'USD').toUpperCase()}).format(v);
    case 'percent':return v+'%';
    case 'range':return v+(f.suffix||'');
    case 'rating':return '★'.repeat(v)+'☆'.repeat(Math.max(0,(f.max||5)-v));
    case 'multiselect':return v.join(', ');
    case 'location':return v.address||(v.lat!=null?`${v.lat}, ${v.lng}`:'');
    case 'file':case 'image':return v.name||'File';
    case 'signature':return 'Signed';
    case 'relation':{const r=recById(v);return r?recTitle(r):'(removed)';}
    case 'date':return new Date(v+'T00:00').toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'});
    case 'datetime':return new Date(v).toLocaleString(undefined,{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
    default:return String(v);
  }}catch(e){return String(v)}
}
function curSym(code){try{return new Intl.NumberFormat(undefined,{style:'currency',currency:(code||'USD').toUpperCase()}).formatToParts(0).find(p=>p.type==='currency').value}catch(e){return code||'$'}}
const fsize=n=>n<1024?n+' B':n<1048576?(n/1024).toFixed(0)+' KB':(n/1048576).toFixed(1)+' MB';
function mapUrl(v){if(!v)return '';if(v.lat!=null&&v.lng!=null&&v.lat!==''&&v.lng!=='')return `https://www.google.com/maps/search/?api=1&query=${v.lat},${v.lng}`;if(v.address)return 'https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(v.address);return '';}


/* ---------- Calculations ---------- */
const lc=s=>String(s||'').trim().toLowerCase();
function fieldByName(form,name){const n=lc(name);return (form?.fields||[]).find(f=>f.type!=='heading'&&(lc(f.label)===n||f.id===name));}
function rawFor(f,rec,form,depth,check){
  if(f.type==='formula')return evalFormula(form,f,rec,depth+1,check);
  const v=rec.values?.[f.id];
  if(f.type==='relation'){const r=v&&recById(v);return r?recTitle(r):'';}
  if(f.type==='location')return v?.address||'';
  if(f.type==='file'||f.type==='image')return v?.name||'';
  return v??null;
}
function evalFormula(form,f,rec,depth=0,check=false){
  if(depth>20)throw FX.E('These calculations refer to each other in a loop.');
  const ast=FX.parse(f.expr||'');
  const ctx={check,
    ref:name=>{const g=fieldByName(form,name);if(!g)throw FX.E(`There is no field called {${name}} on this form.`);if(g.id===f.id)throw FX.E('A calculation can’t use itself.');return rawFor(g,rec,form,depth,check)},
    family:(fn,a)=>{
      if(fn==='PARENT'){const g=a[0];const p=rec.parentId&&recById(rec.parentId);if(!p){if(check)return 0;return null}const pf=formById(p.formId);const pg=fieldByName(pf,g);if(!pg)throw FX.E(`The parent form has no field called “${g}”.`);return rawFor(pg,p,pf,depth,check)}
      const cf=store.forms.find(x=>lc(x.name)===lc(a[0]))||(check&&fdraft&&lc(fdraft.name)===lc(a[0])?fdraft:null);
      if(!cf)throw FX.E(`There is no form called “${a[0]}”.`);
      const kids=rec.id?store.records.filter(r=>r.parentId===rec.id&&r.formId===cf.id):[];
      if(fn==='CHILDCOUNT')return kids.length;
      const g=fieldByName(cf,a[1]);if(!g)throw FX.E(`${cf.name} has no field called “${a[1]}”.`);
      const vals=kids.map(k=>FX.num(rawFor(g,k,cf,depth,check)));
      if(fn==='CHILDSUM')return vals.reduce((s,x)=>s+x,0);
      if(fn==='CHILDAVG')return vals.length?vals.reduce((s,x)=>s+x,0)/vals.length:0;
      if(fn==='CHILDMIN')return vals.length?Math.min(...vals):0;
      return vals.length?Math.max(...vals):0;
    }};
  return FX.ev(ast,ctx);
}
function calc(form,f,rec){try{const v=evalFormula(form,f,rec);return (typeof v==='number'&&!isFinite(v))?{e:'The result is too large or undefined.'}:{v}}catch(e){return {e:e.fx?e.message:'This formula could not be worked out.'}}}
function valOf(f,rec,form){if(f.type!=='formula')return rec.values?.[f.id];form=form||formById(rec.formId);const r=calc(form,f,rec);return r.e?null:r.v;}
function fmtCalc(f,v){
  if(v==null||v==='')return '';
  if(typeof v==='boolean')return v?'Yes':'No';
  if(typeof v!=='number'||f.format==='text')return String(v);
  const d=f.decimals??2;
  try{switch(f.format){
    case 'number':return v.toLocaleString(undefined,{maximumFractionDigits:d});
    case 'currency':return new Intl.NumberFormat(undefined,{style:'currency',currency:(f.currency||'USD').toUpperCase()}).format(v);
    case 'percent':return v.toLocaleString(undefined,{maximumFractionDigits:d})+'%';
    case 'days':return v.toLocaleString()+(Math.abs(v)===1?' day':' days');
    default:return v.toLocaleString(undefined,{minimumFractionDigits:d,maximumFractionDigits:d});
  }}catch(e){return String(v)}
}

/* ---------- State ---------- */
let view={name:'loading'},hist=[],rdraft=null,fdraft=null,pdraft=null;
const ui={search:'',openField:null,tab:'fields',palette:false,confirm:null,leaveOk:false};

function dirty(){return (view.name==='record'&&rdraft?.dirty)||(view.name==='formEdit'&&fdraft?.dirty)||admin.isDirty(view)}
function guard(){if(dirty()&&!ui.leaveOk){ui.leaveOk=true;toast('You have unsaved changes. Tap again to leave without saving.');setTimeout(()=>ui.leaveOk=false,4000);return false;}ui.leaveOk=true;return true;}
export function goRec(draft,v){if(!guard())return;rdraft=draft;go(v);}
export function go(v,push=true){
  if(ADMIN_VIEWS.has(v.name)&&!isAdmin(store.me)){toast('Only administrators can open that.');return false;}
  if((v.name==='records'||v.name==='record')&&!canViewForm(store.me,v.formId)){toast('You don’t have access to that form.');return false;}
  if(!guard())return false;
  ui.leaveOk=false;ui.confirm=null;
  if(push&&view.name!=='loading')hist.push(view);
  view=v;closeMenu();
  if(v.name==='records'){ui.search='';}
  if(v.name==='formEdit'){ui.tab=v.tab||'fields';ui.openField=null;ui.palette=false;}
  render();window.scrollTo(0,0);return true;
}
export function back(){if(!guard())return;const v=hist.pop();if(v){if(v.name==='record')rdraft=null;go(v,false)}else home()}
function sidebarForms(){return store.forms.filter(f=>f.showInSidebar&&canViewForm(store.me,f.id)).sort(byOrder);}
export function home(){
  const fs=sidebarForms();
  ui.leaveOk=true;
  if(fs.length)go({name:'records',formId:fs[0].id},false);
  else if(isAdmin(store.me))go({name:'designer'},false);
  else go({name:'welcome'},false);
}
let booted=false;
function onData(){
  if(!store.ready)return;
  if(!booted){booted=true;$('#boot').hidden=true;$('#app').hidden=false;home();return;}
  if(ADMIN_VIEWS.has(view.name)&&!isAdmin(store.me)){ui.leaveOk=true;home();return;}
  if((view.name==='records'||view.name==='record')&&!canViewForm(store.me,view.formId)){ui.leaveOk=true;home();return;}
  renderSide();
  if(admin.isDirty(view))return;
  if(view.name==='formEdit')return;
  if(view.name==='record'&&rdraft?.dirty)return;
  if(view.name==='record'||view.name==='records'){if(!formById(view.formId)){home();return;}}
  if(view.name==='record'&&view.recordId&&!recById(view.recordId)){back();return;}
  renderMain();
}

/* ---------- Rendering ---------- */
export function render(){renderSide();renderMain();}
function renderSide(){
  const fs=sidebarForms();
  const activeForm=(view.name==='records'||view.name==='record')?view.formId:null;
  const me=store.me||{};const name=store.profiles[me.uid]?.displayName||store.user?.displayName||store.user?.email||'You';
  const adm=isAdmin(me);
  $('#side').innerHTML=`
    <div class="brand"><span class="brand-mark"><i></i></span><b>Formwright</b></div>
    <div class="navlabel">Forms</div>
    ${fs.length?fs.map(f=>`<button class="nav${activeForm===f.id?' on':''}" data-act="nav-form" data-id="${f.id}">${badge(f)}<span class="t">${esc(f.name)}</span><span class="n">${recordsOf(f.id).length}</span></button>`).join(''):`<div class="nav-empty">No forms to show yet.</div>`}
    ${adm?`<div class="navlabel" style="margin-top:12px">Administration</div>
    <button class="nav${view.name==='designer'||view.name==='formEdit'?' on':''}" data-act="nav-designer"><span class="glyph navg">⚙</span><span class="t">Form designer</span><span class="n">${store.forms.length}</span></button>
    <button class="nav${view.name==='groups'||view.name==='groupEdit'?' on':''}" data-act="nav-groups"><span class="glyph navg">◫</span><span class="t">Security groups</span><span class="n">${store.groups.length}</span></button>
    <button class="nav${view.name==='users'?' on':''}" data-act="nav-users"><span class="glyph navg">☺</span><span class="t">Users</span><span class="n">${store.users.length}</span></button>`:''}
    <div class="side-foot"><div class="who"><b>${esc(name)}</b><span>${adm?'Administrator':'Member'}</span></div><button class="btn sm ghost" data-act="sign-out">Sign out</button></div>`;
}
function renderMain(){
  const m=$('#main');let h='',title='Formwright';
  if(!store.ready){m.innerHTML='<div class="loading">Loading your forms…</div>';return;}
  if(view.name==='records'){const f=formById(view.formId);title=f?.name;h=viewRecords(f);}
  else if(view.name==='record'){const f=formById(view.formId);title=f?.name;h=viewRecord(f);}
  else if(view.name==='designer'){title='Form designer';h=viewDesigner();}
  else if(view.name==='formEdit'){title='Edit form';h=viewFormEdit();}
  else if(admin.handles(view)){const r=admin.renderView(view);title=r.title;h=r.html;}
  else if(view.name==='welcome'){title='Formwright';h=viewWelcome();}
  $('#topttl').textContent=title||'Formwright';
  m.innerHTML=`<div class="wrap">${h}</div>`;
  document.querySelectorAll('canvas[data-sig]').forEach(initSig);
}

function viewWelcome(){
  return `<div class="panel empty"><h2>You’re signed in</h2><p>No forms are shared with you yet. An administrator needs to add you to a security group.</p><p class="help">Signed in as ${esc(store.user?.email||'')}</p></div>`;
}

/* Records list */
function viewRecords(form){
  if(!form)return '';
  const all=recordsOf(form.id).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
  const tf=titleFieldOf(form);
  const cols=(form.fields||[]).filter(f=>f.inList&&!NOCOL.has(f.type)&&f.id!==tf?.id).slice(0,5);
  const parents=parentsOf(form.id);
  const lvl=formLevel(store.me,form.id),mayCreate=canCreate(store.me,form.id);
  const q=ui.search.trim().toLowerCase();
  const recs=q?all.filter(r=>(recTitle(r,form)+' '+(form.fields||[]).map(f=>fmt(f,valOf(f,r))).join(' ')).toLowerCase().includes(q)):all;
  const parentCell=r=>{const p=r.parentId&&recById(r.parentId);return p?esc(recTitle(p)):''};
  const cell=(f,r)=>{const t=fmt(f,valOf(f,r,form));if(f.type==='url'&&t)return `<a href="${esc(/^https?:/i.test(t)?t:'https://'+t)}" target="_blank" rel="noopener" data-stop>${esc(t)}</a>`;return `<span class="${NUMERIC.has(f.type)&&f.type!=='rating'?'num':''}">${esc(t)}</span>`};
  return `
  <div class="head">
    <div class="ttl">${badge(form,1)}<div><h1>${esc(form.name)}</h1>${form.description?`<p class="sub">${esc(form.description)}</p>`:''}</div></div>
    <div class="actions">${isAdmin(store.me)?`<button class="btn ghost" data-act="edit-form" data-id="${form.id}">Edit form</button>`:''}${mayCreate?`<button class="btn primary" data-act="new-record" data-id="${form.id}">+ New ${esc(itemName(form).toLowerCase())}</button>`:''}</div>
  </div>
  ${lvl.view==='own'?`<p class="scope-note"><span class="chip acc">Only yours</span> You see the ${esc(form.name.toLowerCase())} you created.${lvl.edit==='none'?' Read only.':''}</p>`:lvl.edit==='none'?`<p class="scope-note"><span class="chip">Read only</span> You can view these ${esc(form.name.toLowerCase())} but not change them.</p>`:lvl.edit==='own'?`<p class="scope-note"><span class="chip">Edit yours</span> You can view all ${esc(form.name.toLowerCase())} and edit the ones you created.</p>`:''}
  ${all.length?`
  <div class="search"><input class="in" id="search" type="search" placeholder="Search ${esc(form.name.toLowerCase())}" value="${esc(ui.search)}" aria-label="Search records"><span class="chip">${recs.length} of ${all.length}</span></div>
  <div class="panel">
    ${recs.length?`<div class="tblwrap"><table class="tbl"><thead><tr><th>${esc(tf?.label||'Title')}</th>${parents.length?'<th>Belongs to</th>':''}${cols.map(c=>`<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>
      ${recs.map(r=>`<tr data-act="open-record" data-id="${r.id}"><td class="title">${esc(recTitle(r,form))}</td>${parents.length?`<td>${parentCell(r)}</td>`:''}${cols.map(c=>`<td>${cell(c,r)}</td>`).join('')}</tr>`).join('')}
    </tbody>${totalsRow(cols,recs,form,parents.length)}</table></div>
    <div class="cards">${recs.map(r=>`<button class="card" data-act="open-record" data-id="${r.id}"><b>${esc(recTitle(r,form))}</b><div class="meta">${parents.length&&parentCell(r)?`<span>↳ ${parentCell(r)}</span>`:''}${cols.map(c=>{const t=fmt(c,valOf(c,r));return t?`<span>${esc(t)}</span>`:''}).join('')}</div></button>`).join('')}${totalsStrip(cols,recs,form)}</div>
    `:`<div class="empty"><p>No ${esc(form.name.toLowerCase())} match “${esc(ui.search)}”.</p></div>`}
  </div>`:`
  <div class="panel empty">${store.recordsLoading.has(form.id)?`<p>Loading ${esc(form.name.toLowerCase())}…</p>`:`<h2>No ${esc(form.name.toLowerCase())} yet</h2>${mayCreate?`<p>Add the first ${esc(itemName(form).toLowerCase())} to start the list.</p><button class="btn primary" data-act="new-record" data-id="${form.id}">+ New ${esc(itemName(form).toLowerCase())}</button>`:`<p>Nothing has been shared with you here yet.</p>`}`}</div>`}`;
}

const SUMMABLE=new Set(['number','decimal','currency','formula']);
function colTotal(c,recs,form){if(!SUMMABLE.has(c.type)||(c.type==='formula'&&c.format==='text'))return null;let s=0,n=0;recs.forEach(r=>{const v=valOf(c,r,form);if(typeof v==='number'&&isFinite(v)){s+=v;n++;}});return n?s:null;}
function totalsRow(cols,recs,form,hasParent){const t=cols.map(c=>colTotal(c,recs,form));if(recs.length<2||!t.some(x=>x!=null))return '';return `<tfoot><tr><td>Total</td>${hasParent?'<td></td>':''}${cols.map((c,i)=>`<td class="num">${t[i]==null?'':esc(fmt(c,t[i]))}</td>`).join('')}</tr></tfoot>`;}
function totalsStrip(cols,recs,form){const t=cols.map(c=>[c,colTotal(c,recs,form)]).filter(x=>x[1]!=null);if(recs.length<2||!t.length)return '';return `<div class="totals">${t.map(([c,v])=>`<span>Total ${esc(c.label.toLowerCase())}: <b class="num">${esc(fmt(c,v))}</b></span>`).join('')}</div>`;}

/* Record page */
function newRecordDraft(form,parent){
  const values={};
  (form.fields||[]).forEach(f=>{if(f.type==='checkbox')values[f.id]=false;if(f.type==='range')values[f.id]=f.min??0;});
  let copied=0;
  if(parent){
    const pf=formById(parent.formId);const rel=(pf?.children||[]).find(c=>c.formId===form.id);
    if(rel?.copy&&pf){(form.fields||[]).forEach(f=>{const m=f.type!=='formula'&&pf.fields.find(p=>p.type===f.type&&p.type!=='heading'&&p.label.trim().toLowerCase()===f.label.trim().toLowerCase());if(m&&!isEmpty(parent.values?.[m.id])){values[f.id]=clone(parent.values[m.id]);copied++;}});}
    (form.fields||[]).forEach(f=>{if(f.type==='relation'&&f.relForm===parent.formId&&isEmpty(values[f.id]))values[f.id]=parent.id;});
  }
  return {formId:form.id,recordId:null,values,parentId:parent?.id||null,parentFormId:parent?.formId||null,errors:{},dirty:false,copied};
}
function viewRecord(form){
  if(!form)return '';
  const rec=view.recordId?recById(view.recordId):null;
  if(!rdraft||rdraft.formId!==form.id||rdraft.recordId!==(view.recordId||null)){rdraft=rec?{formId:form.id,recordId:rec.id,values:{},errors:{},dirty:false}:newRecordDraft(form,null);}
  if(rec&&!rdraft.dirty){rdraft.values=clone(rec.values||{});rdraft.parentId=rec.parentId||null;rdraft.parentFormId=rec.parentFormId||null;}
  const ro=rec?!canEditRecord(store.me,rec):!canCreate(store.me,form.id);rdraft.readOnly=ro;
  const parent=rdraft.parentId?recById(rdraft.parentId):null;
  const pform=parent?formById(parent.formId):null;
  const parentForms=parentsOf(form.id);
  const title=rec?recTitle({formId:form.id,values:rdraft.values},form):'New '+itemName(form).toLowerCase();
  let crumbs=`<button data-act="nav-records" data-id="${form.id}">${esc(form.name)}</button>`;
  if(parent&&pform)crumbs=`<button data-act="open-record" data-id="${parent.id}">${esc(pform.name)} · ${esc(recTitle(parent,pform))}</button><span>›</span>`+crumbs;
  let parentPick='';
  if(parentForms.length){
    const opts=parentForms.map(pf=>`<optgroup label="${esc(pf.name)}">${recordsOf(pf.id).map(r=>`<option value="${r.id}"${r.id===rdraft.parentId?' selected':''}>${esc(recTitle(r,pf))}</option>`).join('')}</optgroup>`).join('');
    parentPick=`<div class="panel parentcard"><div class="grow"><small>Belongs to</small><select class="in" id="parent-pick" style="margin-top:6px" aria-label="Parent record"${ro?' disabled':''}><option value="">No parent</option>${opts}</select></div>${parent?`<button class="btn sm" data-act="open-record" data-id="${parent.id}">Open ${esc(itemName(pform).toLowerCase())}</button>`:''}</div>`;
  }
  const children=(form.children||[]).map(c=>({rel:c,cf:formById(c.formId)})).filter(x=>x.cf&&canViewForm(store.me,x.cf.id));
  const childHTML=rec?children.map(({cf})=>{
    const rs=store.records.filter(r=>r.parentId===rec.id&&r.formId===cf.id).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
    const cols=(cf.fields||[]).filter(f=>f.inList&&!NOCOL.has(f.type)&&f.id!==titleFieldOf(cf)?.id).slice(0,3);
    return `<section class="section"><div class="section-h"><h2>${badge(cf)}${esc(cf.name)} <span class="count">${rs.length}</span></h2>${canCreate(store.me,cf.id)?`<button class="btn sm" data-act="add-child" data-id="${cf.id}">+ Add ${esc(itemName(cf).toLowerCase())}</button>`:''}</div>
      <div class="panel">${rs.length?`<div class="cards" style="display:flex">${rs.map(r=>`<button class="card" data-act="open-record" data-id="${r.id}"><b>${esc(recTitle(r,cf))}</b><div class="meta">${cols.map(c=>{const t=fmt(c,valOf(c,r));return t?`<span>${esc(c.label)}: ${esc(t)}</span>`:''}).join('')}</div></button>`).join('')}</div>`:`<p class="note">No ${esc(cf.name.toLowerCase())} for this ${esc(itemName(form).toLowerCase())} yet.</p>`}</div></section>`;
  }).join(''):'';
  let backHTML='';
  if(rec){
    const links=[];
    store.forms.forEach(f=>(f.fields||[]).filter(x=>x.type==='relation'&&x.relForm===form.id).forEach(x=>recordsOf(f.id).filter(r=>r.values?.[x.id]===rec.id).forEach(r=>links.push({r,f,x}))));
    if(links.length)backHTML=`<section class="section"><div class="section-h"><h2>Linked from <span class="count">${links.length}</span></h2></div><div class="panel"><div class="cards" style="display:flex">${links.map(({r,f,x})=>`<button class="card" data-act="open-record" data-id="${r.id}"><b>${esc(recTitle(r,f))}</b><div class="meta"><span>${esc(f.name)} · ${esc(x.label)}</span></div></button>`).join('')}</div></div></section>`;
  }
  const delKey='rec-'+(rec?.id||'');
  const kids=rec?store.records.filter(r=>r.parentId===rec.id).length:0;
  return `
  <div class="crumbs">${crumbs}</div>
  <div class="head"><div class="ttl">${badge(form,1)}<div><h1>${esc(title)}</h1>${!rec&&rdraft.copied?`<p class="sub">${rdraft.copied} field${rdraft.copied>1?'s':''} copied from the ${esc(itemName(pform||{}).toLowerCase())}.</p>`:''}</div></div></div>
  ${parentPick}
  <div class="panel">
    <fieldset class="fset"${ro?' disabled':''}>${formFieldsHTML(form,rdraft,'record')}</fieldset>
    <div class="savebar">
      ${rec&&!ro?`<button class="btn danger${ui.confirm===delKey?' armed':''}" data-act="del-record">${ui.confirm===delKey?(kids?`Tap again to delete (${kids} child record${kids>1?'s':''} stay)`:'Tap again to delete'):'Delete'}</button>`:''}
      <span class="grow" id="dirtynote">${rdraft.dirty?'Unsaved changes':rec?recordMeta(rec)+(ro?' · Read only':''):''}</span>
      <button class="btn ghost" data-act="back">${rdraft.dirty?'Discard':'Back'}</button>
      ${ro?'':`<button class="btn primary" data-act="save-record">${rec?'Save':'Save '+esc(itemName(form).toLowerCase())}</button>`}
    </div>
  </div>
  ${childHTML}${backHTML}
  ${!rec&&children.length?`<p class="help">Save this ${esc(itemName(form).toLowerCase())} to add ${children.map(c=>esc(c.cf.name.toLowerCase())).join(' and ')}.</p>`:''}`;
}

const personName=id=>store.profiles[id]?.displayName||(id===store.user?.uid?'you':'someone');
const when=t=>new Date(t).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
function recordMeta(rec){
  const by=rec.ownerId===store.user?.uid?'you':personName(rec.ownerId);
  let s=`Created by ${esc(by)}`;
  if(rec.updatedAt)s+=` · edited ${esc(when(rec.updatedAt))}`+(rec.updatedBy&&rec.updatedBy!==rec.ownerId?` by ${esc(personName(rec.updatedBy))}`:'');
  return s;
}

/* Field rendering */
function formFieldsHTML(form,d,scope){
  const fs=form.fields||[];
  if(!fs.length)return `<p class="note">This form has no fields yet. Add some in the designer.</p>`;
  return `<div class="fgrid" data-scope="${scope}">${fs.map(f=>fieldBlock(f,d.values[f.id],d.errors?.[f.id],scope)).join('')}</div>`;
}
function fieldBlock(f,v,err,scope){
  if(f.type==='heading')return `<div class="fsec" id="fb-${scope}-${f.id}"><h3>${esc(f.label)}</h3>${f.help?`<p class="help">${esc(f.help)}</p>`:''}</div>`;
  const id=`in-${scope}-${f.id}`;
  const lab=['radio','multiselect','rating','checkbox','formula'].includes(f.type)?`<span class="flabel" id="lb-${id}">${esc(f.label)}${f.required?'<span class="req">*</span>':''}</span>`:`<label class="flabel" for="${id}">${esc(f.label)}${f.required?'<span class="req">*</span>':''}</label>`;
  return `<div class="fld w-${f.width==='half'?'half':'full'}${err?' bad':''}" id="fb-${scope}-${f.id}">${lab}${control(f,v,id,scope)}${f.help?`<p class="help">${esc(f.help)}</p>`:''}${err?`<p class="err">${esc(err)}</p>`:''}</div>`;
}
function control(f,v,id,scope){
  const a=`id="${id}" data-fid="${f.id}"`,ph=f.placeholder?` placeholder="${esc(f.placeholder)}"`:'';
  const mm=(f.min!=null&&f.min!==''?` min="${f.min}"`:'')+(f.max!=null&&f.max!==''?` max="${f.max}"`:'');
  const val=v==null?'':esc(v);
  switch(f.type){
    case 'formula':{const d=scope==='record'?rdraft:pdraft;const form=d?formOfDraft(d):null;const r=form?calc(form,f,draftRec(d)):{e:''};return `<div class="calc${r.e?' bad':''}" id="calc-${scope}-${f.id}" aria-live="polite">${esc(r.e||fmtCalc(f,r.v)||'—')}</div><span class="fxsrc">= ${esc(f.expr||'')}</span>`;}
    case 'text':return `<input class="in" type="text" ${a} value="${val}"${ph}>`;
    case 'textarea':return `<textarea class="in" ${a}${ph}>${val}</textarea>`;
    case 'email':return `<input class="in" type="email" inputmode="email" autocomplete="email" ${a} value="${val}"${ph||' placeholder="name@example.com"'}>`;
    case 'phone':return `<input class="in" type="tel" inputmode="tel" autocomplete="tel" ${a} value="${val}"${ph||' placeholder="+1 555 555 0100"'}>`;
    case 'url':return `<input class="in" type="url" inputmode="url" ${a} value="${val}"${ph||' placeholder="https://"'}>`;
    case 'number':return `<input class="in" type="number" step="1" inputmode="numeric" ${a} value="${val}"${mm}${ph}>`;
    case 'decimal':{const d=f.decimals??2;return `<input class="in" type="number" step="${d?Math.pow(10,-d).toFixed(d):1}" inputmode="decimal" ${a} value="${val}"${mm}${ph}>`;}
    case 'currency':return `<div class="affix"><span>${esc(curSym(f.currency))}</span><input class="in" type="number" step="0.01" inputmode="decimal" ${a} value="${val}"${mm}${ph}></div>`;
    case 'percent':return `<div class="affix"><input class="in" type="number" step="any" inputmode="decimal" ${a} value="${val}"${mm}${ph}><span>%</span></div>`;
    case 'range':{const mn=f.min??0,mx=f.max??100,cur=v??mn;return `<div class="rangew"><input type="range" ${a} min="${mn}" max="${mx}" step="${f.step||1}" value="${esc(cur)}"><output id="out-${id}">${esc(cur)}${esc(f.suffix||'')}</output></div>`;}
    case 'rating':{const mx=f.max||5;let s='';for(let i=1;i<=mx;i++)s+=`<button type="button" class="${(v||0)>=i?'on':''}" data-act="rate" data-fid="${f.id}" data-n="${i}" aria-label="${i} of ${mx}" aria-pressed="${(v||0)>=i}">★</button>`;return `<div class="stars" role="group" aria-labelledby="lb-${id}">${s}</div>`;}
    case 'date':return `<input class="in" type="date" ${a} value="${val}">`;
    case 'time':return `<input class="in" type="time" ${a} value="${val}">`;
    case 'datetime':return `<input class="in" type="datetime-local" ${a} value="${val}">`;
    case 'checkbox':return `<label class="switch"><input type="checkbox" ${a}${v?' checked':''} aria-labelledby="lb-${id}"><span class="tr"></span><span>${v?'Yes':'No'}</span></label>`;
    case 'select':return `<select class="in" ${a}><option value="">Choose…</option>${(f.options||[]).map(o=>`<option${o===v?' selected':''}>${esc(o)}</option>`).join('')}</select>`;
    case 'radio':return `<div class="opts" role="radiogroup" aria-labelledby="lb-${id}">${(f.options||[]).map((o,i)=>`<label class="opt"><input type="radio" name="${id}" data-fid="${f.id}" value="${esc(o)}"${o===v?' checked':''}>${esc(o)}</label>`).join('')}</div>`;
    case 'multiselect':return `<div class="opts" role="group" aria-labelledby="lb-${id}">${(f.options||[]).map(o=>`<label class="opt"><input type="checkbox" data-fid="${f.id}" data-multi value="${esc(o)}"${(v||[]).includes(o)?' checked':''}>${esc(o)}</label>`).join('')}</div>`;
    case 'color':return `<div class="colorw"><input type="color" ${a} value="${esc(v||'#3346c8')}"><code id="out-${id}">${esc(v||'Not set')}</code></div>`;
    case 'location':{const L=v||{},u=mapUrl(L);return `<div class="loc"><input class="in" type="text" ${a} data-part="address" value="${esc(L.address||'')}" placeholder="Street address or place name" autocomplete="street-address"><div class="row2"><input class="in" type="number" step="any" inputmode="decimal" data-fid="${f.id}" data-part="lat" value="${esc(L.lat??'')}" placeholder="Latitude" aria-label="${esc(f.label)} latitude"><input class="in" type="number" step="any" inputmode="decimal" data-fid="${f.id}" data-part="lng" value="${esc(L.lng??'')}" placeholder="Longitude" aria-label="${esc(f.label)} longitude"></div><a id="map-${id}" href="${esc(u)}" target="_blank" rel="noopener"${u?'':' hidden'}>Open in Google Maps ↗</a></div>`;}
    case 'file':case 'image':{
      let chip='';
      if(v){const src=v.url||v.data||'';chip=`<div class="file-chip">${f.type==='image'&&src?`<img src="${esc(src)}" alt="">`:`<span class="glyph">${f.type==='image'?'▣':'⇪'}</span>`}<span class="nm">${esc(v.name)}</span><span class="sz">${v.size?fsize(v.size):''}</span>${src?`<a class="btn sm ghost" href="${esc(src)}" target="_blank" rel="noopener">Open</a>`:''}<button type="button" class="ibtn" data-act="file-clear" data-fid="${f.id}" aria-label="Remove file">✕</button></div>`;}
      return `<div class="filew">${chip}<label class="pick"><input type="file" ${a}${f.type==='image'?' accept="image/*"':''}>${v?'Replace':(f.type==='image'?'Take or choose a photo':'Choose a file')}</label></div>`;}
    case 'signature':return `<div class="sig"><canvas data-sig="${f.id}" data-scope="${scope}" aria-label="Signature pad for ${esc(f.label)}"></canvas><div class="sigbar"><span>${v?'Signed':'Sign above with your finger or mouse'}</span><button type="button" class="btn sm ghost" data-act="sig-clear" data-fid="${f.id}">Clear</button></div></div>`;
    case 'relation':{const tf=formById(f.relForm);if(!tf)return `<p class="help">Choose which form this links to in the designer.</p>`;const rs=recordsOf(tf.id).map(r=>({r,t:recTitle(r,tf)})).sort((x,y)=>x.t.localeCompare(y.t));return `<div class="row2" style="grid-template-columns:minmax(0,1fr) auto"><select class="in" ${a}><option value="">Choose a ${esc(itemName(tf).toLowerCase())}…</option>${rs.map(({r,t})=>`<option value="${r.id}"${r.id===v?' selected':''}>${esc(t)}</option>`).join('')}</select>${v&&recById(v)&&scope==='record'?`<button type="button" class="btn" data-act="open-record" data-id="${v}">Open</button>`:''}</div>`;}
  }
  return '';
}
function draftRec(d){return {id:d.recordId||null,formId:d.formId,values:d.values,parentId:d.parentId||null};}
function refreshCalcs(d){const form=formOfDraft(d);const scope=d===pdraft?'preview':'record';(form?.fields||[]).filter(f=>f.type==='formula').forEach(f=>{const el=document.getElementById(`calc-${scope}-${f.id}`);if(!el)return;const r=calc(form,f,draftRec(d));el.textContent=r.e||fmtCalc(f,r.v)||'—';el.classList.toggle('bad',!!r.e);});}
function draftOf(el){const s=el.closest('[data-scope]')?.dataset.scope;return s==='record'?rdraft:s==='preview'?pdraft:null;}
function formOfDraft(d){return d===pdraft?fdraft:formById(d.formId);}
function repaint(d,f){const scope=d===pdraft?'preview':'record';const el=document.getElementById(`fb-${scope}-${f.id}`);if(!el)return;el.outerHTML=fieldBlock(f,d.values[f.id],d.errors?.[f.id],scope);const c=document.querySelector(`#fb-${scope}-${f.id} canvas[data-sig]`);if(c)initSig(c);}
function markDirty(d){d.dirty=true;refreshCalcs(d);if(d===rdraft){const n=$('#dirtynote');if(n)n.textContent='Unsaved changes';const b=document.querySelector('[data-act="back"]');if(b)b.textContent='Discard';}}
function setVal(t){
  const d=draftOf(t);if(!d)return;const form=formOfDraft(d);const f=(form?.fields||[]).find(x=>x.id===t.dataset.fid);if(!f)return;
  let v;
  if(t.type==='checkbox'&&!('multi' in t.dataset)){v=t.checked;const s=t.parentElement.querySelector('.tr + span');if(s)s.textContent=v?'Yes':'No';}
  else if('multi' in t.dataset){v=[...t.closest('.opts').querySelectorAll('input:checked')].map(x=>x.value);}
  else if(t.dataset.part){v={...(d.values[f.id]||{})};v[t.dataset.part]=t.dataset.part==='address'?t.value:(t.value===''?null:Number(t.value));const a=document.getElementById('map-'+t.closest('.fld').querySelector('[data-part=address]').id);if(a){const u=mapUrl(v);a.href=u;a.hidden=!u;}}
  else if(NUMERIC.has(f.type)){v=t.value===''?null:Number(t.value);if(f.type==='range'){const o=document.getElementById('out-'+t.id);if(o)o.textContent=t.value+(f.suffix||'');}}
  else if(f.type==='color'){v=t.value;const o=document.getElementById('out-'+t.id);if(o)o.textContent=v;}
  else v=t.value;
  d.values[f.id]=v;
  if(d.errors?.[f.id]){delete d.errors[f.id];const fb=t.closest('.fld');fb?.classList.remove('bad');fb?.querySelector('.err')?.remove();}
  markDirty(d);
}
async function onFile(t){
  const d=draftOf(t);const form=formOfDraft(d);const f=form.fields.find(x=>x.id===t.dataset.fid);let file=t.files?.[0];if(!file)return;
  const fb=t.closest('.fld');fb.classList.add('pending');
  try{
    let val;
    if(d===pdraft){val={name:file.name,size:file.size,type:file.type,url:URL.createObjectURL(file)};}
    else{
      if(file.size>25*1024*1024){fb.classList.remove('pending');t.value='';toast(`That file is ${fsize(file.size)}. Files must be under 25 MB.`);return;}
      val=await uploadFile(file,form.id);
    }
    d.values[f.id]=val;markDirty(d);repaint(d,f);
  }catch(e){fb.classList.remove('pending');toast(e?.code==='storage/unauthorized'?'You don’t have permission to upload files to this form.':'The upload failed. Check your connection and try again.');console.error(e);}
}
function initSig(c){
  const scope=c.dataset.scope,d=scope==='record'?rdraft:pdraft;if(!d)return;const fid=c.dataset.sig;
  const dpr=Math.min(2,window.devicePixelRatio||1),w=c.clientWidth||300;c.width=w*dpr;c.height=160*dpr;
  const ctx=c.getContext('2d');ctx.scale(dpr,dpr);ctx.fillStyle='#fbfbf7';ctx.fillRect(0,0,w,160);
  ctx.strokeStyle='#15182a';ctx.lineWidth=2.2;ctx.lineCap='round';ctx.lineJoin='round';
  if(d.values[fid]){const im=new Image();im.onload=()=>ctx.drawImage(im,0,0,w,160);im.src=d.values[fid];}
  if(c.closest('fieldset[disabled]'))return;
  let drawing=false,last=null,moved=false;
  const pt=e=>{const r=c.getBoundingClientRect();return [e.clientX-r.left,e.clientY-r.top]};
  c.onpointerdown=e=>{drawing=true;moved=false;last=pt(e);c.setPointerCapture(e.pointerId);};
  c.onpointermove=e=>{if(!drawing)return;const p=pt(e);ctx.beginPath();ctx.moveTo(...last);ctx.lineTo(...p);ctx.stroke();last=p;moved=true;};
  c.onpointerup=c.onpointercancel=()=>{if(!drawing)return;drawing=false;if(moved){d.values[fid]=c.toDataURL('image/png');markDirty(d);const s=c.parentElement.querySelector('.sigbar span');if(s)s.textContent='Signed';}};
}
function validate(form,vals){
  const errs={};
  (form.fields||[]).forEach(f=>{
    if(f.type==='heading'||f.type==='formula')return;const v=vals[f.id];
    if(f.required&&(f.type==='checkbox'?!v:isEmpty(v))){errs[f.id]=f.type==='checkbox'?'This must be switched on.':'This field is required.';return;}
    if(isEmpty(v))return;
    if(f.type==='email'&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))errs[f.id]='Enter an email like name@example.com.';
    if(f.type==='url'){try{const u=new URL(/^[a-z]+:\/\//i.test(v)?v:'https://'+v);if(!u.hostname.includes('.'))throw 0;}catch(e){errs[f.id]='Enter a web address like example.com.';}}
    if(f.type==='phone'&&(!/^[+()\-.\s\d]+$/.test(v)||v.replace(/\D/g,'').length<7))errs[f.id]='Enter a phone number with at least 7 digits.';
    if(NUMERIC.has(f.type)&&typeof v==='number'){
      if(Number.isNaN(v))errs[f.id]='Enter a number.';
      else if(f.type==='number'&&!Number.isInteger(v))errs[f.id]='Enter a whole number.';
      else if(f.min!=null&&f.min!==''&&v<f.min)errs[f.id]=`Must be ${f.min} or more.`;
      else if(f.max!=null&&f.max!==''&&f.type!=='rating'&&v>f.max)errs[f.id]=`Must be ${f.max} or less.`;
    }
    if(f.type==='location'&&v){if(v.lat!=null&&(v.lat<-90||v.lat>90))errs[f.id]='Latitude must be between -90 and 90.';if(v.lng!=null&&(v.lng<-180||v.lng>180))errs[f.id]='Longitude must be between -180 and 180.';}
  });
  return errs;
}
async function saveRecord(){
  const d=rdraft,form=formById(d.formId);if(d.readOnly){toast('This record is read only for you.');return;}const errs=validate(form,d.values);
  if(Object.keys(errs).length){d.errors=errs;renderMain();toast('Fix the highlighted fields, then save.');document.querySelector('.fld.bad')?.scrollIntoView({block:'center',behavior:'smooth'});return;}
  (form.fields||[]).filter(f=>f.type==='formula').forEach(f=>{const r=calc(form,f,draftRec(d));d.values[f.id]=r.e?null:r.v;});
  const now=Date.now(),old=d.recordId?recById(d.recordId):null,id=d.recordId||uid('r');
  const rec={id,formId:form.id,values:d.values,parentId:d.parentId||null,parentFormId:d.parentFormId||null,createdAt:old?.createdAt||now,updatedAt:now};
  try{await store.put('records',rec);}catch(e){console.error(e);toast(e?.code==='permission-denied'?'You don’t have permission to save this record.':'Saving failed. Check your connection and try again.');return;}
  d.dirty=false;d.errors={};d.recordId=id;d.copied=0;view.recordId=id;toast('Saved');render();
}

/* Designer */
function viewDesigner(){
  const fs=[...store.forms].sort(byOrder);
  return `
  <div class="head"><div class="ttl"><div><h1>Form designer</h1><p class="sub">Build forms, choose which ones appear in the sidebar, and connect them as parents and children. Hidden forms are still reachable from their parent records. Who can see and edit each form is set in Security groups.</p></div></div>
    <div class="actions"><button class="btn primary" data-act="new-form">+ New form</button></div></div>
  ${fs.length?`<div class="panel flist">${fs.map((f,i)=>{
    const par=parentsOf(f.id),kids=(f.children||[]).map(c=>formById(c.formId)).filter(Boolean);
    return `<div class="fcard">${badge(f,1)}<div class="info"><b>${esc(f.name)}</b><div class="tags"><span class="chip">${(f.fields||[]).filter(x=>x.type!=='heading').length} fields</span><span class="chip">${recordsOf(f.id).length} record${recordsOf(f.id).length===1?'':'s'}</span>${par.length?`<span class="chip acc">Child of ${par.map(p=>esc(p.name)).join(', ')}</span>`:''}${kids.length?`<span class="chip acc">Parent of ${kids.map(k=>esc(k.name)).join(', ')}</span>`:''}${f.showInSidebar?'':'<span class="chip warn">Hidden</span>'}</div></div>
      <div class="ctl"><label class="switch vis"><input type="checkbox" data-act-change="toggle-sidebar" data-id="${f.id}"${f.showInSidebar?' checked':''}><span class="tr"></span><span>Sidebar</span></label>
      <button class="ibtn" data-act="form-move" data-id="${f.id}" data-dir="-1" aria-label="Move up"${i===0?' disabled':''}>↑</button><button class="ibtn" data-act="form-move" data-id="${f.id}" data-dir="1" aria-label="Move down"${i===fs.length-1?' disabled':''}>↓</button>
      <button class="btn sm" data-act="nav-records" data-id="${f.id}">Records</button><button class="btn sm primary" data-act="edit-form" data-id="${f.id}">Edit</button></div></div>`;}).join('')}</div>`
  :`<div class="panel empty"><h2>No forms yet</h2><p>Create your first form, or load a set of connected example forms (Clients, Projects, Site visits, Contacts) to see how relationships work.</p><div class="actions"><button class="btn" data-act="load-examples">Load example forms</button><button class="btn primary" data-act="new-form">+ New form</button></div></div>`}`;
}
function newField(type){
  const f={id:uid('x'),type,label:T[type].label,required:false,inList:false,width:['heading','textarea','location','multiselect','file','signature'].includes(type)?'full':'half',help:''};
  if(CHOICE.has(type))f.options=['Option 1','Option 2','Option 3'];
  if(type==='decimal')f.decimals=2;
  if(type==='currency')f.currency='CAD';
  if(type==='rating')f.max=5;
  if(type==='formula'){f.expr='';f.format='decimal';f.decimals=2;f.inList=true;}
  if(type==='range'){f.min=0;f.max=100;f.step=1;}
  if(type==='relation'){const o=store.forms.find(x=>x.id!==fdraft?.id);f.relForm=o?.id||'';f.label=o?itemName(o):'Linked record';}
  return f;
}
function viewFormEdit(){
  const f=fdraft;const tabs=[['fields','Fields'],['relations','Relationships'],['settings','Settings'],['preview','Preview']];
  let body='';
  if(ui.tab==='fields'){
    const groups=[...new Set(TYPES.map(t=>t[3]))];
    body=`<div class="panel">${f.fields.length?f.fields.map((x,i)=>`<div class="frow${ui.openField===x.id?' open':''}" data-feid="${x.id}">
        <div class="frow-h"><span class="glyph" title="${esc(T[x.type].label)}">${T[x.type].glyph}</span>
          <button class="lab" data-act="open-field" data-id="${x.id}" aria-expanded="${ui.openField===x.id}"><b id="frl-${x.id}">${esc(x.label||'Untitled field')}${x.required?'<span class="req">*</span>':''}</b><small>${esc(T[x.type].label)}${x.type==='relation'&&formById(x.relForm)?' → '+esc(formById(x.relForm).name):''}${x.inList?' · in list':''}${f.titleField===x.id?' · title':''}</small></button>
          <div class="fctl"><button class="ibtn" data-act="field-move" data-id="${x.id}" data-dir="-1" aria-label="Move up"${i===0?' disabled':''}>↑</button><button class="ibtn" data-act="field-move" data-id="${x.id}" data-dir="1" aria-label="Move down"${i===f.fields.length-1?' disabled':''}>↓</button><button class="ibtn hide-sm" data-act="field-dup" data-id="${x.id}" aria-label="Duplicate">⧉</button><button class="ibtn" data-act="field-del" data-id="${x.id}" aria-label="Delete field" style="${ui.confirm==='f-'+x.id?'color:var(--danger)':''}">${ui.confirm==='f-'+x.id?'✓?':'✕'}</button></div></div>
        ${ui.openField===x.id?fieldEditor(x):''}</div>`).join(''):`<p class="note">No fields yet. Add one below.</p>`}</div>
      <div class="panel palette"><div class="section-h"><h2 style="font-size:1rem">Add a field</h2><span class="help">Tap a type to add it to the end.</span></div>
        ${groups.map(g=>`<div class="pgroup"><span>${g}</span><div class="pgrid">${TYPES.filter(t=>t[3]===g).map(t=>`<button class="ptype" data-act="add-field" data-type="${t[0]}"><span class="glyph">${t[2]}</span>${t[1]}</button>`).join('')}</div></div>`).join('')}</div>`;
  }else if(ui.tab==='relations'){
    const others=store.forms.filter(x=>x.id!==f.id).sort(byOrder);
    const par=parentsOf(f.id);
    const linkers=[];store.forms.forEach(o=>(o.fields||[]).filter(x=>x.type==='relation'&&x.relForm===f.id).forEach(x=>linkers.push(o.name+' · '+x.label)));
    body=`<section class="section"><div class="section-h"><h2>Child forms</h2><button class="btn sm" data-act="add-rel">+ Add child form</button></div>
      <p class="help">From any ${esc(itemName(f).toLowerCase()||'record')}, people can create records in these forms. The new record is attached as its child and listed on the ${esc(itemName(f).toLowerCase()||'record')} page.</p>
      <div class="panel">${(f.children||[]).length?f.children.map((c,i)=>`<div class="rel"><select class="in" data-crel="${i}" data-cprop="formId" aria-label="Child form">${others.map(o=>`<option value="${o.id}"${o.id===c.formId?' selected':''}>${esc(o.name)}</option>`).join('')}<option value="${f.id}"${c.formId===f.id?' selected':''}>${esc(f.name||'This form')} (itself)</option></select>
        <label class="switch"><input type="checkbox" data-crel="${i}" data-cprop="copy"${c.copy?' checked':''}><span class="tr"></span><span>Copy matching fields</span></label>
        <button class="ibtn" data-act="del-rel" data-i="${i}" aria-label="Remove child form">✕</button></div>`).join(''):`<p class="note">No child forms. Add one to create records from this form.</p>`}</div>
      <p class="help">“Copy matching fields” fills in any child field whose label and type match a field on the parent.</p></section>
      <section class="section"><div class="section-h"><h2>Parents</h2></div><div class="panel"><p class="note">${par.length?`This form is a child of ${par.map(p=>`<b>${esc(p.name)}</b>`).join(', ')}. Its records can belong to one of their records.`:'No form lists this one as a child.'}</p></div></section>
      <section class="section"><div class="section-h"><h2>Linked by fields</h2></div><div class="panel"><p class="note">${linkers.length?'Link-to-record fields that point here: '+linkers.map(esc).join(', ')+'.':'Add a “Link to record” field to any form to point at records in another form, like a lookup.'}</p></div></section>`;
  }else if(ui.tab==='settings'){
    const tfs=f.fields.filter(x=>['text','email','phone','url','number','select','date'].includes(x.type));
    body=`<div class="panel"><div class="settings">
      <label class="prop"><span>One record is called</span><input class="in" data-fprop="itemName" value="${esc(f.itemName||'')}" placeholder="${esc(itemName(f))}"><small class="help">Used in buttons like “New ${esc(itemName(f).toLowerCase())}”.</small></label>
      <label class="prop"><span>Record title comes from</span><select class="in" data-fprop="titleField"><option value="">First text field</option>${tfs.map(x=>`<option value="${x.id}"${x.id===f.titleField?' selected':''}>${esc(x.label)}</option>`).join('')}</select></label>
      <label class="prop full"><span>Description</span><textarea class="in" data-fprop="description" rows="2" placeholder="What this form collects">${esc(f.description||'')}</textarea></label>
      <div class="prop"><span>Color</span><div class="swatches">${COLORS.map((c,i)=>`<button class="sw${(f.color??0)===i?' on':''}" style="background:${c}" data-act="set-color" data-i="${i}" aria-label="Color ${i+1}"></button>`).join('')}</div></div>
      <div class="prop"><span>Visibility</span><label class="switch"><input type="checkbox" data-fprop="showInSidebar" data-kind="bool"${f.showInSidebar?' checked':''}><span class="tr"></span><span>Show in sidebar</span></label><small class="help">Hidden forms stay in the designer and under their parent records.</small></div>
    </div></div>
    ${f.isNew?'':`<section class="section"><div class="section-h"><h2>Delete form</h2></div><div class="panel"><div class="parentcard"><p class="grow help">Deletes the form and its ${recordsOf(f.id).length} records. Child records in other forms are kept.</p><button class="btn danger${ui.confirm==='form'?' armed':''}" data-act="del-form">${ui.confirm==='form'?'Tap again to delete':'Delete form'}</button></div></div></section>`}`;
  }else{
    if(!pdraft)pdraft={values:{},errors:{},dirty:false};
    body=`<div class="panel"><div class="preview-note">Preview. Try the fields; nothing here is saved.</div>${formFieldsHTML(f,pdraft,'preview')}<div class="savebar"><button class="btn" data-act="preview-check">Check required fields</button></div></div>`;
  }
  return `
  <div class="crumbs"><button data-act="nav-designer">Form designer</button><span>›</span><span>${f.isNew?'New form':esc(f.name)}</span></div>
  <div class="head"><div class="ttl">${badge(f.name?f:{...f,name:'?'},1)}<div style="flex:1;min-width:0"><input class="title-in" data-fprop="name" value="${esc(f.name)}" placeholder="Form name, e.g. Inspections" aria-label="Form name"></div></div></div>
  <div class="tabs" role="tablist">${tabs.map(([k,l])=>`<button class="tab${ui.tab===k?' on':''}" role="tab" aria-selected="${ui.tab===k}" data-act="tab" data-tab="${k}">${l}${k==='fields'?` <span class="count">${f.fields.length}</span>`:''}${k==='relations'&&(f.children||[]).length?` <span class="count">${f.children.length}</span>`:''}</button>`).join('')}</div>
  ${body}
  <div class="panel savebar" style="border-radius:var(--r)"><span class="grow" id="fdirty">${f.dirty?'Unsaved changes':'All changes saved'}</span><button class="btn ghost" data-act="done-form">${f.dirty?'Discard':'Done'}</button><button class="btn primary" data-act="save-form">Save form</button></div>`;
}
function fieldEditor(x){
  const P=(l,h,c='')=>`<label class="prop ${c}"><span>${l}</span>${h}</label>`;
  const inp=(p,v,attrs='')=>`<input class="in" data-prop="${p}" value="${esc(v??'')}" ${attrs}>`;
  const num=(p,v)=>inp(p,v,'type="number" step="any" inputmode="decimal" data-kind="num"');
  const sw=(p,l)=>`<label class="switch"><input type="checkbox" data-prop="${p}" data-kind="bool"${x[p]?' checked':''}><span class="tr"></span><span>${l}</span></label>`;
  let h=P('Label',inp('label',x.label))+P('Field type',`<select class="in" data-prop="type">${TYPES.map(t=>`<option value="${t[0]}"${t[0]===x.type?' selected':''}>${t[1]}</option>`).join('')}</select>`);
  h+=P(x.type==='heading'?'Description':'Help text',inp('help',x.help),'full');
  if(x.type==='formula'){
    const others=fdraft.fields.filter(o=>o.id!==x.id&&o.type!=='heading');
    h+=`<label class="prop full"><span>Formula</span><textarea class="in fx" data-prop="expr" rows="3" spellcheck="false" autocapitalize="off" placeholder="{Price} * {Quantity}">${esc(x.expr||'')}</textarea></label>
    <div class="prop full"><span id="fxc-${x.id}" class="fxcheck${fxCheck(x).ok?'':' bad'}">${fxCheck(x).msg}</span></div>
    <div class="prop full"><span>Insert a field</span><div class="chips">${others.length?others.map(o=>`<button type="button" class="chipbtn" data-act="fx-ins" data-fid="${x.id}" data-ins="{${esc(o.label)}}">${esc(o.label)}</button>`).join(''):'<span class="help">Add other fields first.</span>'}</div></div>
    <div class="prop full"><span>Insert a function</span><div class="chips">${['+','-','*','/','( )','SUM(','ROUND(',"IF(",'DAYS(','TODAY()','CHILDSUM(','CHILDCOUNT(','PARENT('].map(fn=>`<button type="button" class="chipbtn fn" data-act="fx-ins" data-fid="${x.id}" data-ins="${esc(fn==='( )'?'(':fn.length===1?' '+fn+' ':fn)}">${esc(fn)}</button>`).join('')}</div></div>
    <div class="prop full">${FX_REF}</div>`;
    h+=P('Show result as',`<select class="in" data-prop="format">${[['decimal','Decimal number'],['number','Number'],['currency','Currency'],['percent','Percent'],['days','Days'],['text','Text']].map(([k,l])=>`<option value="${k}"${(x.format||'decimal')===k?' selected':''}>${l}</option>`).join('')}</select>`);
    if(['decimal','number','percent'].includes(x.format||'decimal'))h+=P('Decimal places',num('decimals',x.decimals));
    if(x.format==='currency')h+=P('Currency code',inp('currency',x.currency||'CAD','maxlength="3" style="text-transform:uppercase"'));
  }
  if(PLACEHOLDER.has(x.type))h+=P('Placeholder',inp('placeholder',x.placeholder));
  if(CHOICE.has(x.type))h+=P('Options, one per line',`<textarea class="in" data-prop="options" data-kind="lines" rows="4">${esc((x.options||[]).join('\n'))}</textarea>`,'full');
  if(['number','decimal','currency','percent','range'].includes(x.type))h+=P('Minimum',num('min',x.min))+P('Maximum',num('max',x.max));
  if(x.type==='decimal')h+=P('Decimal places',num('decimals',x.decimals));
  if(x.type==='currency')h+=P('Currency code',inp('currency',x.currency,'maxlength="3" style="text-transform:uppercase"'));
  if(x.type==='range')h+=P('Step',num('step',x.step))+P('Unit after value',inp('suffix',x.suffix,'placeholder="e.g. %"'));
  if(x.type==='rating')h+=P('Number of stars',num('max',x.max));
  if(x.type==='relation')h+=P('Links to form',`<select class="in" data-prop="relForm"><option value="">Choose a form…</option>${[...store.forms].sort(byOrder).map(o=>`<option value="${o.id}"${o.id===x.relForm?' selected':''}>${esc(o.name)}</option>`).join('')}</select>`);
  if(x.type!=='heading')h+=`<div class="props-sw">${x.type==='formula'?'':sw('required','Required')}${NOCOL.has(x.type)?'':sw('inList','Show as list column')}<label class="switch"><input type="checkbox" data-prop="width" data-kind="half"${x.width==='half'?' checked':''}><span class="tr"></span><span>Half width on wide screens</span></label></div>`;
  h+=`<div class="prop full"><span class="keyline">Field ID ${esc(x.id)}</span></div>`;
  return `<div class="fedit">${h}</div>`;
}
const FX_REF=`<details class="fxref"><summary>Formula reference</summary><div class="tblwrap"><table><tbody>
<tr><td>{Field name}</td><td>The value of another field on this form. Yes/No counts as 1 or 0.</td></tr>
<tr><td>+ - * / ^ %</td><td>Add, subtract, multiply, divide, power, remainder.</td></tr>
<tr><td>= != &lt; &gt; &lt;= &gt;=</td><td>Compare two values, for use inside IF.</td></tr>
<tr><td>&amp;</td><td>Join text, e.g. {First} &amp; " " &amp; {Last}.</td></tr>
<tr><td>IF(test, a, b)</td><td>a when the test is true, otherwise b. AND( ), OR( ), NOT( ) combine tests.</td></tr>
<tr><td>SUM, AVG, MIN, MAX</td><td>Over any list of values, e.g. SUM({Q1}, {Q2}, {Q3}).</td></tr>
<tr><td>ROUND(x, 2)</td><td>Round to 2 places. Also ROUNDUP, ROUNDDOWN, FLOOR, CEIL, ABS, SQRT, POW, MOD.</td></tr>
<tr><td>DAYS(end, start)</td><td>Days between two dates. TODAY() is today's date.</td></tr>
<tr><td>HOURS(end, start)</td><td>Hours between two times or date-times.</td></tr>
<tr><td>CHILDSUM("Form", "Field")</td><td>Total of a field across this record's children. Also CHILDAVG, CHILDMIN, CHILDMAX.</td></tr>
<tr><td>CHILDCOUNT("Form")</td><td>How many child records this record has in that form.</td></tr>
<tr><td>PARENT("Field")</td><td>A value from the parent record.</td></tr>
</tbody></table></div></details>`;
function fxCheck(x){
  if(!(x.expr||'').trim())return {ok:false,msg:'Write a formula, for example {Price} * {Quantity}.'};
  try{const rec={id:null,formId:fdraft.id,values:{},parentId:null};evalFormula(fdraft,x,rec,0,true);return {ok:true,msg:'✓ Formula is valid'};}
  catch(e){return {ok:false,msg:e.fx?e.message:'This formula could not be worked out.'};}
}
function updateFxCheck(x){const el=document.getElementById('fxc-'+x.id);if(!el)return;const r=fxCheck(x);el.textContent=r.msg;el.classList.toggle('bad',!r.ok);}
function setFdirty(){fdraft.dirty=true;const n=$('#fdirty');if(n)n.textContent='Unsaved changes';const b=document.querySelector('[data-act="done-form"]');if(b)b.textContent='Discard';}
async function saveForm(){
  const f=fdraft;
  if(!f.name.trim()){toast('Give the form a name first.');$('.title-in')?.focus();return;}
  f.fields.forEach(x=>{if(!x.label.trim())x.label='Untitled field';if(CHOICE.has(x.type))x.options=(x.options||[]).filter(Boolean);});
  const reEsc=t=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  Object.entries(f._labels||{}).forEach(([id,old])=>{const nf=f.fields.find(z=>z.id===id);if(!nf||!old||nf.label===old)return;f.fields.filter(z=>z.type==='formula'&&z.expr).forEach(z=>{z.expr=z.expr.replace(new RegExp('\\{\\s*'+reEsc(old)+'\\s*\\}','gi'),()=>'{'+nf.label+'}');});});
  const renames=Object.entries(f._labels||{}).map(([id,old])=>[old,f.fields.find(z=>z.id===id)?.label]).filter(([o,n])=>o&&n&&o!==n);
  const q='["\']';
  const others=renames.length&&!f.isNew?store.forms.filter(o=>o.id!==f.id&&(o.fields||[]).some(z=>z.type==='formula'&&z.expr)):[];
  const nameRe=reEsc(f.name.trim());
  for(const o of others){
    let changed=false;const fields=clone(o.fields);
    fields.filter(z=>z.type==='formula'&&z.expr).forEach(z=>{renames.forEach(([old,nw])=>{
      const r1=new RegExp('(CHILD(?:SUM|AVG|MIN|MAX)\\(\\s*'+q+nameRe+q+'\\s*,\\s*'+q+')'+reEsc(old)+'('+q+')','gi');
      const r2=new RegExp('(PARENT\\(\\s*'+q+')'+reEsc(old)+'('+q+')','gi');
      const isChild=(f.children||[]).some(c=>c.formId===o.id);
      let e=z.expr.replace(r1,(m,x,y)=>x+nw+y);if(isChild)e=e.replace(r2,(m,x,y)=>x+nw+y);
      if(e!==z.expr){z.expr=e;changed=true;}
    });});
    if(changed){try{await store.put('forms',{...o,fields});}catch(e){}}
  }
  f._labels=Object.fromEntries(f.fields.map(x=>[x.id,x.label]));
  const out=clone(f);delete out.dirty;delete out.isNew;delete out._labels;out.name=out.name.trim();
  if(f.isNew)out.order=Math.max(0,...store.forms.map(x=>x.order||0))+1;
  out.updatedAt=Date.now();
  try{await store.put('forms',out);}catch(e){toast('Saving failed. Check your connection and try again.');return;}
  f.dirty=false;f.isNew=false;toast('Form saved');render();
}
function editForm(id){
  const src=formById(id);if(!src||!guard())return;
  fdraft={...clone(src),fields:clone(src.fields||[]),children:clone(src.children||[]),dirty:false,isNew:false,_labels:Object.fromEntries((src.fields||[]).map(x=>[x.id,x.label]))};pdraft=null;
  go({name:'formEdit',formId:id});
}

/* ---------- Events ---------- */
document.addEventListener('click',async e=>{
  if(e.target.closest('[data-stop]'))return;
  const el=e.target.closest('[data-act]');if(!el)return;
  const a=el.dataset.act,id=el.dataset.id;
  if(a!=='del-record'&&a!=='del-form'&&a!=='field-del'&&ui.confirm&&!a.startsWith('nav')){ui.confirm=null;}
  switch(a){
    case 'menu':$('#side').classList.add('open');$('#scrim').classList.add('open');break;
    case 'close-menu':closeMenu();break;
    case 'nav-form':case 'nav-records':go({name:'records',formId:id});break;
    case 'nav-designer':go({name:'designer'});break;
    case 'nav-groups':go({name:'groups'});break;
    case 'nav-users':go({name:'users'});break;
    case 'sign-out':if(!guard())return;await signOutUser();break;
    case 'back':back();break;
    case 'new-record':{const f=formById(id);if(f)goRec(newRecordDraft(f,null),{name:'record',formId:id,recordId:null});break;}
    case 'open-record':{const r=recById(id);if(r)goRec(null,{name:'record',formId:r.formId,recordId:r.id});break;}
    case 'add-child':{const parent=recById(view.recordId);const cf=formById(id);if(!parent||!cf)return;if(rdraft?.dirty){toast('Save this record first.');return;}goRec(newRecordDraft(cf,parent),{name:'record',formId:cf.id,recordId:null});break;}
    case 'save-record':saveRecord();break;
    case 'del-record':{const k='rec-'+view.recordId;if(ui.confirm!==k){ui.confirm=k;renderMain();return;}ui.confirm=null;const rid=view.recordId;rdraft.dirty=false;try{await store.del('records',rid);toast('Deleted');}catch(err){toast('Delete failed. Try again.');}break;}
    case 'rate':{const d=draftOf(el);const f=formOfDraft(d).fields.find(x=>x.id===el.dataset.fid);const n=+el.dataset.n;d.values[f.id]=d.values[f.id]===n?0:n;markDirty(d);repaint(d,f);break;}
    case 'file-clear':{const d=draftOf(el);const f=formOfDraft(d).fields.find(x=>x.id===el.dataset.fid);d.values[f.id]=null;markDirty(d);repaint(d,f);break;}
    case 'sig-clear':{const d=draftOf(el);const f=formOfDraft(d).fields.find(x=>x.id===el.dataset.fid);d.values[f.id]=null;markDirty(d);repaint(d,f);break;}
    case 'edit-form':editForm(id);break;
    case 'new-form':if(!guard())return;fdraft={id:uid('f'),name:'',itemName:'',description:'',color:store.forms.length%COLORS.length,showInSidebar:true,titleField:'',children:[],fields:[],isNew:true,dirty:true};fdraft.fields.push({...newField('text'),label:'Name',required:true,inList:true,width:'full'});pdraft=null;go({name:'formEdit',formId:fdraft.id});setTimeout(()=>$('.title-in')?.focus(),50);break;
    case 'tab':ui.tab=el.dataset.tab;ui.confirm=null;if(ui.tab==='preview')pdraft=null;renderMain();break;
    case 'open-field':ui.openField=ui.openField===id?null:id;renderMain();break;
    case 'add-field':{const f=newField(el.dataset.type);fdraft.fields.push(f);ui.openField=f.id;setFdirty();renderMain();document.querySelector(`[data-feid="${f.id}"]`)?.scrollIntoView({block:'center',behavior:'smooth'});break;}
    case 'field-move':{const fs=fdraft.fields,i=fs.findIndex(x=>x.id===id),j=i+(+el.dataset.dir);if(j<0||j>=fs.length)return;[fs[i],fs[j]]=[fs[j],fs[i]];setFdirty();renderMain();break;}
    case 'field-dup':{const i=fdraft.fields.findIndex(x=>x.id===id);const c={...clone(fdraft.fields[i]),id:uid('x')};c.label+=' (copy)';fdraft.fields.splice(i+1,0,c);ui.openField=c.id;setFdirty();renderMain();break;}
    case 'field-del':{if(ui.confirm!=='f-'+id){ui.confirm='f-'+id;renderMain();toast('Tap the check to delete this field. Values already saved in records are kept but hidden.');return;}ui.confirm=null;fdraft.fields=fdraft.fields.filter(x=>x.id!==id);if(fdraft.titleField===id)fdraft.titleField='';setFdirty();renderMain();break;}
    case 'add-rel':{const cand=store.forms.find(x=>x.id!==fdraft.id&&!(fdraft.children||[]).some(c=>c.formId===x.id));if(!cand){toast('Create another form first, then add it here as a child.');return;}fdraft.children.push({formId:cand.id,copy:true});setFdirty();renderMain();break;}
    case 'del-rel':fdraft.children.splice(+el.dataset.i,1);setFdirty();renderMain();break;
    case 'set-color':fdraft.color=+el.dataset.i;setFdirty();renderMain();break;
    case 'save-form':saveForm();break;
    case 'done-form':if(fdraft.dirty&&!ui.leaveOk){ui.leaveOk=true;toast('Tap Discard again to drop your changes.');setTimeout(()=>ui.leaveOk=false,4000);return;}fdraft.dirty=false;go({name:'designer'});break;
    case 'del-form':{if(ui.confirm!=='form'){ui.confirm='form';renderMain();return;}ui.confirm=null;await deleteForm(fdraft.id);break;}
    case 'form-move':{const fs=[...store.forms].sort(byOrder);const i=fs.findIndex(x=>x.id===id),j=i+(+el.dataset.dir);if(j<0||j>=fs.length)return;[fs[i],fs[j]]=[fs[j],fs[i]];try{for(let k=0;k<fs.length;k++)if(fs[k].order!==k)await store.put('forms',{...fs[k],order:k});}catch(err){toast('Reordering failed. Try again.');}break;}
    case 'fx-ins':{const x=fdraft.fields.find(z=>z.id===el.dataset.fid);const ta=document.querySelector(`[data-feid="${x.id}"] textarea[data-prop=expr]`);if(!ta)return;const ins=el.dataset.ins;const st=ta.selectionStart??ta.value.length,en=ta.selectionEnd??st;ta.setRangeText(ins,st,en,'end');if(ins.endsWith('('))ta.setRangeText(')',ta.selectionStart,ta.selectionStart,'start');ta.focus();x.expr=ta.value;setFdirty();updateFxCheck(x);break;}
    case 'load-examples':await loadExamples();break;
    case 'preview-check':{const errs=validate(fdraft,pdraft.values);pdraft.errors=errs;renderMain();toast(Object.keys(errs).length?`${Object.keys(errs).length} field${Object.keys(errs).length>1?'s need':' needs'} attention.`:'Everything checks out.');break;}
    default:await admin.onClick(el,a,id);
  }
});
document.addEventListener('input',e=>{
  const t=e.target;
  if(t.id==='search'){ui.search=t.value;const pos=t.selectionStart;renderMain();const s=$('#search');if(s){s.focus();s.setSelectionRange(pos,pos);}return;}
  if(t.dataset.fid&&t.type!=='file'&&!(t.type==='radio'||t.type==='checkbox'))setVal(t);
  if(t.dataset.fprop&&t.dataset.kind!=='bool'){fdraft[t.dataset.fprop]=t.value;setFdirty();}
  if(t.dataset.prop&&!['bool','half'].includes(t.dataset.kind)&&t.tagName!=='SELECT'){
    const f=fdraft.fields.find(x=>x.id===t.closest('[data-feid]').dataset.feid);const p=t.dataset.prop,k=t.dataset.kind;
    f[p]=k==='num'?(t.value===''?null:Number(t.value)):k==='lines'?t.value.split('\n').map(s=>s.trim()):p==='currency'?t.value.toUpperCase():t.value;
    if(p==='expr')updateFxCheck(f);
    if(p==='label'){fdraft.fields.filter(z=>z.type==='formula').forEach(updateFxCheck);const l=document.getElementById('frl-'+f.id);if(l)l.innerHTML=esc(f.label||'Untitled field')+(f.required?'<span class="req">*</span>':'');}
    setFdirty();
  }
  admin.onInput(t);
});
document.addEventListener('change',async e=>{
  const t=e.target;
  if(t.dataset.fid){if(t.type==='file')return onFile(t);if(t.type==='radio'||t.type==='checkbox'||t.tagName==='SELECT')setVal(t);return;}
  if(t.id==='parent-pick'){const r=t.value?recById(t.value):null;rdraft.parentId=r?.id||null;rdraft.parentFormId=r?.formId||null;markDirty(rdraft);renderMain();return;}
  if(t.dataset.actChange==='toggle-sidebar'){const f=formById(t.dataset.id);if(!f)return;try{await store.put('forms',{...f,showInSidebar:t.checked});toast(t.checked?`${f.name} is in the sidebar`:`${f.name} is hidden from the sidebar`);}catch(err){toast('Could not save that change. Try again.');t.checked=!t.checked;}return;}
  if(t.dataset.fprop&&t.dataset.kind==='bool'){fdraft[t.dataset.fprop]=t.checked;setFdirty();return;}
  if(t.dataset.fprop==='titleField'){setFdirty();renderMain();return;}
  if(t.dataset.prop){
    const f=fdraft.fields.find(x=>x.id===t.closest('[data-feid]').dataset.feid);const p=t.dataset.prop,k=t.dataset.kind;
    if(k==='bool')f[p]=t.checked;else if(k==='half')f.width=t.checked?'half':'full';
    else if(p==='type'){const nf=newField(t.value);Object.assign(f,{type:t.value},Object.fromEntries(Object.entries(nf).filter(([key])=>!['id','label','required','inList','help','width'].includes(key)&&f[key]==null)));if(NOCOL.has(f.type))f.inList=false;}
    else if(t.tagName==='SELECT')f[p]=t.value;
    setFdirty();
    if(['type','relForm','required','inList','format'].includes(p)||k==='bool')renderMain();
    return;
  }
  if(t.dataset.crel!=null){const c=fdraft.children[+t.dataset.crel];if(t.dataset.cprop==='copy')c.copy=t.checked;else c.formId=t.value;setFdirty();renderMain();return;}
  await admin.onChange(t);
});
function closeMenu(){$('#side').classList.remove('open');$('#scrim').classList.remove('open');}

async function deleteForm(id){
  try{await deleteFormCascade(id);fdraft.dirty=false;toast('Form deleted');go({name:'designer'},false);}
  catch(e){console.error(e);toast('Delete failed. Try again.');}
}
async function loadExamples(){
  try{await writeExamples(examples);toast('Example forms loaded. Give people access in Security groups.');home();}
  catch(e){console.error(e);toast('Loading the examples failed. Try again.');}
}

/* ---------- Lifecycle (called from main.js) ---------- */
export function startApp(){
  booted=false;view={name:'loading'};hist=[];rdraft=fdraft=pdraft=null;
  Object.assign(ui,{search:'',openField:null,tab:'fields',palette:false,confirm:null,leaveOk:false});
  store.onChange=onData;
  store.onError=(err)=>{if(err?.code==='permission-denied')toast('Some data could not be loaded because of your permissions.');else toast('Lost the connection to the database. Changes will sync when it returns.');};
}
export function stopApp(){
  booted=false;store.onChange=()=>{};$('#app').hidden=true;closeMenu();
}
export { view as currentView, ui, byOrder, formById, recordsOf, renderMain };
