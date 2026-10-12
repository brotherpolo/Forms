// Formula engine for Calculation fields.
// Parses expressions like  ROUND({Price} * {Qty} * 1.13, 2)  without eval().
// Field references, child/parent lookups and IF are resolved through a context object:
//   { ref(name) -> value, family(fn, args) -> value, check: boolean }

import { isEmpty } from './util.js';

export const FX=(()=>{
  const E=m=>{const e=new Error(m);e.fx=true;return e;};
  const FN={
    SUM:a=>flat(a).reduce((s,x)=>s+num(x),0),
    AVG:a=>{const v=flat(a);return v.length?v.reduce((s,x)=>s+num(x),0)/v.length:0},
    AVERAGE:a=>FN.AVG(a),
    MIN:a=>{const v=flat(a).map(num);return v.length?Math.min(...v):0},
    MAX:a=>{const v=flat(a).map(num);return v.length?Math.max(...v):0},
    COUNT:a=>flat(a).filter(x=>!isEmpty(x)).length,
    ROUND:a=>scaled(Math.round,num(a[0]),num(a[1])),
    ROUNDUP:a=>scaled(Math.ceil,num(a[0]),num(a[1])),
    ROUNDDOWN:a=>scaled(Math.floor,num(a[0]),num(a[1])),
    FLOOR:a=>Math.floor(num(a[0])),CEIL:a=>Math.ceil(num(a[0])),
    ABS:a=>Math.abs(num(a[0])),
    SQRT:a=>{const x=num(a[0]);if(x<0)throw E('SQRT needs a number that is 0 or more.');return Math.sqrt(x)},
    POW:a=>Math.pow(num(a[0]),num(a[1])),
    MOD:a=>{if(num(a[1])===0)throw E('MOD cannot divide by zero.');return num(a[0])%num(a[1])},
    AND:a=>a.every(truthy),OR:a=>a.some(truthy),NOT:a=>!truthy(a[0]),
    DAYS:a=>{const x=toTime(a[0]),y=toTime(a[1]);if(x==null||y==null)return null;return Math.round((x-y)/864e5)},
    HOURS:a=>{const x=toTime(a[0]),y=toTime(a[1]);if(x==null||y==null)return null;return Math.round((x-y)/36e5*100)/100},
    TODAY:()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`},
    NOW:()=>Date.now(),
    LEN:a=>String(a[0]??'').length,
    TEXT:a=>String(a[0]??''),
  };
  const CHILD=new Set(['CHILDSUM','CHILDCOUNT','CHILDAVG','CHILDMIN','CHILDMAX','PARENT']);
  // Scale, clean float noise (14.125*100 = 1412.4999…), round, scale back.
  function scaled(fn,x,d){const m=Math.pow(10,d);return fn(Number((x*m).toPrecision(15)))/m}
  function flat(a){return a.flatMap(x=>Array.isArray(x)?x:[x])}
  function num(v){if(typeof v==='number')return isFinite(v)?v:0;if(typeof v==='boolean')return v?1:0;if(Array.isArray(v))return v.length;if(typeof v==='string'){const n=Number(v.trim());return v.trim()===''||isNaN(n)?0:n}return 0}
  function truthy(v){return typeof v==='string'?v!=='':Array.isArray(v)?v.length>0:!!num(v)}
  function toTime(v){if(v==null||v==='')return null;if(typeof v==='number')return v;const s=String(v);if(/^\d{1,2}:\d{2}/.test(s))return new Date('1970-01-01T'+s.padStart(5,'0')).getTime();if(/^\d{4}-\d{2}-\d{2}$/.test(s))return new Date(s+'T00:00').getTime();const t=new Date(s).getTime();return isNaN(t)?null:t}
  function tokenize(s){
    const t=[];let i=0;
    while(i<s.length){const c=s[i];
      if(/\s/.test(c)){i++;continue}
      if(/[0-9.]/.test(c)){let j=i;while(j<s.length&&/[0-9.]/.test(s[j]))j++;const n=Number(s.slice(i,j));if(isNaN(n))throw E(`"${s.slice(i,j)}" is not a number.`);t.push({k:'num',v:n});i=j;continue}
      if(c==='{'){const j=s.indexOf('}',i);if(j<0)throw E('A { is missing its closing }.');t.push({k:'ref',v:s.slice(i+1,j).trim()});i=j+1;continue}
      if(c==='"'||c==="'"){const j=s.indexOf(c,i+1);if(j<0)throw E('A quote is missing its closing quote.');t.push({k:'str',v:s.slice(i+1,j)});i=j+1;continue}
      if(/[A-Za-z_]/.test(c)){let j=i;while(j<s.length&&/[A-Za-z0-9_]/.test(s[j]))j++;t.push({k:'id',v:s.slice(i,j).toUpperCase()});i=j;continue}
      const two=s.slice(i,i+2);if(['<=','>=','!=','<>','=='].includes(two)){t.push({k:'op',v:two==='<>'?'!=':two==='=='?'=':two});i+=2;continue}
      if('+-*/%^(),<>=&'.includes(c)){t.push({k:'op',v:c});i++;continue}
      throw E(`“${c}” can’t be used in a formula.`);
    }
    return t;
  }
  const cache=new Map();
  function parse(src){
    if(cache.has(src))return cache.get(src);
    const t=tokenize(src);let p=0;
    if(!t.length)throw E('Write a formula, for example {Price} * {Quantity}.');
    const is=v=>t[p]&&t[p].k==='op'&&t[p].v===v, eat=v=>is(v)?(p++,true):false;
    const take=ops=>t[p]&&t[p].k==='op'&&ops.includes(t[p].v)?t[p++].v:null;
    function cmp(){let l=cat(),o;while((o=take(['=','!=','<','>','<=','>='])))l={op:o,l,r:cat()};return l}
    function cat(){let l=add();while(eat('&'))l={op:'&',l,r:add()};return l}
    function add(){let l=mul(),o;while((o=take(['+','-'])))l={op:o,l,r:mul()};return l}
    function mul(){let l=pw(),o;while((o=take(['*','/','%'])))l={op:o,l,r:pw()};return l}
    function pw(){const b=un();return eat('^')?{op:'^',l:b,r:pw()}:b}
    function un(){if(eat('-'))return {op:'neg',l:un()};if(eat('+'))return un();return prim()}
    function prim(){
      const k=t[p++];if(!k)throw E('The formula ends too early.');
      if(k.k==='num')return {num:k.v};
      if(k.k==='str')return {str:k.v};
      if(k.k==='ref'){if(!k.v)throw E('{ } needs a field name inside.');return {ref:k.v}}
      if(k.k==='id'){
        if(k.v==='TRUE')return {num:1};if(k.v==='FALSE')return {num:0};
        if(!FN[k.v]&&!CHILD.has(k.v)&&k.v!=='IF')throw E(`There is no function called ${k.v}.`);
        if(!eat('('))throw E(`${k.v} needs brackets, like ${k.v}( ).`);
        const args=[];if(!eat(')')){do args.push(cmp());while(eat(','));if(!eat(')'))throw E(`${k.v}( is missing its closing ).`)}
        return {fn:k.v,args};
      }
      if(k.v==='('){const e=cmp();if(!eat(')'))throw E('A ( is missing its closing ).');return e}
      throw E(`Unexpected “${k.v}”.`);
    }
    const ast=cmp();if(p<t.length)throw E(`Unexpected “${t[p].v}”. Check for a missing operator like + or *.`);
    cache.set(src,ast);if(cache.size>500)cache.clear();return ast;
  }
  function ev(n,c){
    if('num' in n)return n.num;if('str' in n)return n.str;if('ref' in n)return c.ref(n.ref);
    if(n.fn){
      if(n.fn==='IF'){if(n.args.length<2)throw E('IF needs a test and a value, like IF({Qty} > 10, 5, 0).');return truthy(ev(n.args[0],c))?ev(n.args[1],c):(n.args[2]?ev(n.args[2],c):0)}
      const a=n.args.map(x=>ev(x,c));
      if(CHILD.has(n.fn))return c.family(n.fn,a);
      return FN[n.fn](a);
    }
    const a=ev(n.l,c);if(n.op==='neg')return -num(a);const b=ev(n.r,c);
    switch(n.op){
      case '+':return num(a)+num(b);case '-':{if(typeof a==='string'&&typeof b==='string'&&toTime(a)!=null&&toTime(b)!=null&&/\d{4}-\d{2}-\d{2}|:\d{2}/.test(a))return Math.round((toTime(a)-toTime(b))/864e5);return num(a)-num(b)}
      case '*':return num(a)*num(b);
      case '/':if(num(b)===0){if(c.check)return 0;throw E('Can’t divide by zero yet. Fill in the fields this uses.')}return num(a)/num(b);
      case '%':if(num(b)===0){if(c.check)return 0;throw E('Can’t divide by zero.')}return num(a)%num(b);
      case '^':return Math.pow(num(a),num(b));
      case '&':return String(a??'')+String(b??'');
      default:{const bothNum=!(typeof a==='string'&&isNaN(Number(a)))&&!(typeof b==='string'&&isNaN(Number(b)));const x=bothNum?num(a):String(a??'').toLowerCase(),y=bothNum?num(b):String(b??'').toLowerCase();
        return n.op==='='?x===y:n.op==='!='?x!==y:n.op==='<'?x<y:n.op==='>'?x>y:n.op==='<='?x<=y:x>=y;}
    }
  }
  return {parse,ev,num,E,FN:Object.keys(FN)};
})();
