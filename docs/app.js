const $ = selector => document.querySelector(selector);
const STATIC_MODE = document.documentElement.dataset.caseproofMode === 'static';
const CASE_COPY = {
  'duplicate-webhook': ['The same event, twice.', 'Duplicate webhook', 'A repeated delivery should not become a second payment.'],
  'ready-to-capture': ['Approved is not captured.', 'Approved order', 'Buyer approval is permission to capture, not evidence of a completed payment.'],
  'pending-capture': ['Pending means wait.', 'Pending capture', 'A capture exists, but its status does not yet support a paid conclusion.'],
  'amount-mismatch': ['Ten dollars are missing.', 'Amount mismatch', 'The order expects 49.00. Completed captures account for only 39.00.'],
  'stale-snapshot': ['Yesterday’s truth expires.', 'Stale snapshot', 'This snapshot is one hour old. Refresh it before proposing a payment decision.'],
  'unverified-webhook': ['A claim needs a source.', 'Unverified webhook', 'An event claims payment, but its verification failed. Keep it out of the decision.']
};
const ACTIONS = {record_payment:'Record the reconciled payment',capture_order:'Review before capturing the order',refresh_order:'Refresh the order snapshot',manual_review:'Review the evidence manually',wait:'Wait for the capture to complete',request_approval:'Request buyer approval'};
const STATES = {paid:'Captured in full',ready_to_capture:'Ready for review',pending:'Pending capture',review_required:'Review required',underpaid:'Underpaid',overpaid:'Overpaid',awaiting_approval:'Awaiting approval',unknown:'Unknown'};
let config = {aiConfigured:false,sandboxConfigured:false};
let caseList = [];
let selectedId = null;
let inspectionId = null;
let inspectionInput = null;
let inspectionRequestVersion = 0;
let activeVersion = 0;
let analysisVersion = 0;
let retryAction = () => boot();
const text = (selector,value) => {$(selector).textContent = value ?? '—';};
const show = (selector,visible) => {$(selector).hidden = !visible;};
const element = (tag,content,className) => {const node=document.createElement(tag); if(content!==undefined) node.textContent=content; if(className) node.className=className; return node;};
const pretty = value => value && typeof value==='object' ? JSON.stringify(value) : String(value ?? '—');

async function request(path,body) {
  let target=path;
  if(STATIC_MODE){
    if(body)throw new Error('This offline demo cannot call PayPal or a model. Run the full app locally.');
    if(path==='/api/config')target='./config.json';
    else {
      const match=/^\/api\/cases\/([a-z-]+)$/.exec(path);
      if(!match || !Object.hasOwn(CASE_COPY,match[1]))throw new Error('This case is not included in the offline demo.');
      target=`./cases/${match[1]}.json`;
    }
    target=new URL(target,document.baseURI).href;
  }
  const response = await fetch(target,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(60000),cache:'no-store'});
  let data;
  try {data=await response.json();} catch {throw new Error('The server returned an unreadable response. Try again.');}
  if(!response.ok) throw Object.assign(new Error(data?.error?.message || 'The request could not be completed.'),{code:data?.error?.code,status:response.status});
  return data;
}
function message(error) {return error.name==='TimeoutError'?'The request timed out. Try again when the service is available.':error.message || (STATIC_MODE?'Could not load the saved demo files. Reload the page or try again.':'Could not reach the local server. Restart it and try again.');}
function resetAnalysis() {
  analysisVersion++;
  show('#ai-result',false);
  $('#ai-result').replaceChildren();
  $('#analyze').disabled = STATIC_MODE || !config.aiConfigured || !(selectedId || inspectionId);
  $('#analyze').removeAttribute('aria-busy');
  text('#analyze','Generate AI proposal ↗');
  text('#ai-status',STATIC_MODE?'Local inference is disabled in this offline demo. Clone and run the full app with Ollama to generate a real proposal.':!(selectedId || inspectionId)?'Select a scenario or inspect an order to request a proposal.':!config.aiConfigured?'No local model configured. The deterministic evidence above works independently; AI is not simulated.':inspectionId?'Refreshes the inspected order before generating a local model proposal. No payment action will execute.':'Uses the explicitly configured local model. No payment action will execute.');
}
function beginLoad() {
  activeVersion++;
  selectedId=null;
  inspectionId=null;
  inspectionInput=null;
  resetAnalysis();
  show('#main-error',false);show('#case-detail',false);show('#loading',true);
  $('#workspace').setAttribute('aria-busy','true');
  return activeVersion;
}
function endLoad() {show('#loading',false);$('#workspace').removeAttribute('aria-busy');}
function fail(error) {endLoad();text('#main-error-copy',message(error));show('#main-error',true);}
function renderCases() {
  $('#cases').replaceChildren();
  caseList.forEach((entry,index) => {
    const id=typeof entry==='string'?entry:entry.id;
    const copy=CASE_COPY[id] || [entry.title || id,entry.title || id,entry.summary || ''];
    const button=element('button',undefined,'case-button'); button.type='button';button.dataset.caseId=id;
    button.setAttribute('aria-current',id===selectedId?'true':'false');
    button.append(element('span',String(index+1).padStart(2,'0'),'case-number'));
    const label=element('span');label.append(element('strong',copy[1]),element('small',index===0?'Same capture. One count.':copy[0]));button.append(label);
    button.addEventListener('click',()=>loadCase(id));$('#cases').append(button);
  });
}
function renderResult(data,id,{preserveAnalysis=false}={}) {
  const {result,provenance}=data;
  selectedId=id;
  inspectionId=id?null:data.resultId ?? null;
  if(id) inspectionInput=null;
  const fixture=provenance.kind==='synthetic-fixture';
  const copy=id?CASE_COPY[id]:fixture?['An injected inspection test.','Test adapter','A test adapter supplied these records. This is not an authentic PayPal response.']:['Your sandbox order.','Sandbox order','Read directly from the PayPal sandbox and compared with your expected invoice.'];
  const index=caseList.findIndex(x=>(typeof x==='string'?x:x.id)===id);
  text('#provenance-label',fixture?'SYNTHETIC SCENARIO':'PAYPAL SANDBOX READ');
  text('#provenance-notice',provenance.notice);
  text('#case-index',id?`CASE ${String(index+1).padStart(2,'0')} / ${String(caseList.length).padStart(2,'0')}`:'YOUR ORDER / READ ONLY');
  text('#case-title',copy?.[0] || 'Evidence file');text('#case-description',copy?.[2] || '');
  text('#state-badge',STATES[result.state] || result.state);
  $('#state-badge').dataset.tone=['review_required','underpaid','overpaid','unknown'].includes(result.state)?'danger':result.state==='paid'?'success':'warning';
  text('#invoice-id',result.invoiceId);text('#duplicate-count',`${result.duplicateEvents} duplicate ${result.duplicateEvents===1?'delivery':'deliveries'} excluded`);
  document.querySelectorAll('[data-currency]').forEach(n=>n.textContent=result.amounts.currencyCode);
  text('#expected',result.amounts.expected);text('#completed',result.amounts.completed);text('#difference',result.amounts.difference);
  $('.difference').dataset.mismatch=result.amounts.differenceMinor!=='0';
  text('#amount-scope',result.amounts.scope);
  text('#snapshot-time',`${fixture?'Scenario clock':'Checked at'} · ${result.observedAt}`);
  text('#next-action',result.allowedActions.map(a=>ACTIONS[a] || a).join(' · ') || 'No supported action');
  $('#issues').replaceChildren();
  result.issues.forEach(issue=>{const li=element('li',undefined,'issue');li.dataset.severity=issue.severity;li.append(element('strong',issue.severity==='blocking'?'Decision blocked':issue.severity==='warning'?'Check this evidence':'Observation'),element('span',issue.message),element('code',issue.code));$('#issues').append(li);});
  text('#issue-count',`${result.issues.length} ${result.issues.length===1?'OBSERVATION':'OBSERVATIONS'}`);show('#issues-section',!!result.issues.length);
  $('#evidence').replaceChildren();
  result.evidence.forEach((item,index)=>{
    const li=element('li');li.append(element('span',String(index+1),'evidence-index'));
    const details=element('details');details.open=index<3;
    const summary=element('summary',item.label);summary.append(element('small',item.id));details.append(summary);
    const dl=element('dl',undefined,'facts');Object.entries(item.facts).forEach(([key,value])=>dl.append(element('dt',key),element('dd',pretty(value))));details.append(dl);li.append(details);$('#evidence').append(li);
  });
  text('#evidence-count',`${result.evidence.length} RECORDS`);
  text('#raw-result',JSON.stringify(data,null,2));
  $('#cases').querySelectorAll('button').forEach(button=>button.setAttribute('aria-current',button.dataset.caseId===id?'true':'false'));
  if(!preserveAnalysis) resetAnalysis();
  endLoad();show('#case-detail',true);
}
async function loadCase(id) {
  const version=beginLoad();retryAction=()=>loadCase(id);
  try {const data=await request(`/api/cases/${encodeURIComponent(id)}`);if(version!==activeVersion)return;renderResult(data,id);history.replaceState(null,'',`#${encodeURIComponent(id)}`);}
  catch(error){if(version===activeVersion)fail(error);}
}
async function boot() {
  beginLoad();retryAction=()=>boot();
  try {
    const [configuration,cases]=STATIC_MODE?[await request('/api/config'),null]:await Promise.all([request('/api/config'),request('/api/cases')]);
    if(STATIC_MODE && (configuration.mode!=='offline-demo' || configuration.aiConfigured!==false || configuration.sandboxConfigured!==false))throw new Error('The offline demo configuration is invalid.');
    config=configuration;caseList=STATIC_MODE?configuration.cases:cases.cases;
    if(!Array.isArray(caseList)||!caseList.length)throw new Error(STATIC_MODE?'The saved demo cases are unavailable. Reload the page or open the source instructions.':'No case files are available. Restart the server and try again.');
    renderCases();
    $('#sandbox-fields').disabled=STATIC_MODE || !config.sandboxConfigured;
    text('#sandbox-status',STATIC_MODE?'PayPal inspection is disabled in this offline demo. Run the full app locally with your server-side sandbox credentials.':config.sandboxConfigured?'Server credentials configured. Supply an existing sandbox order and your expected invoice below.':'Sandbox credentials are not configured on this local server. Use the case files above for now.');
    if(STATIC_MODE){
      show('#offline-panel',true);text('#mode-tag','Offline demo');
      text('.sidebar-intro p','Six synthetic scenarios. Recorded sandbox evidence is linked separately.');
      text('.workbench-foot span:last-child','Offline demo · no live services');
      text('#recorded-evidence-copy',configuration.recordedEvidence.notice);
      if(configuration.repositoryUrl){
        const repository=new URL(configuration.repositoryUrl);
        if(repository.protocol!=='https:' || repository.hostname!=='github.com' || repository.username || repository.password || repository.search || repository.hash || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(repository.pathname))throw new Error('The source repository link is invalid.');
        $('#static-source-link').href=repository.href;show('#static-source-link',true);
      }
    }
    let hash;try{hash=decodeURIComponent(location.hash.slice(1));}catch{hash='';}
    const id=caseList.find(x=>(typeof x==='string'?x:x.id)===hash);
    await loadCase(id?(typeof id==='string'?id:id.id):(typeof caseList[0]==='string'?caseList[0]:caseList[0].id));
  } catch(error){fail(error);}
}
$('#retry').addEventListener('click',()=>retryAction());
$('#analyze').addEventListener('click',async()=>{
  if(STATIC_MODE || !(selectedId || inspectionId)||!config.aiConfigured)return;
  const id=selectedId;const resultId=inspectionId;const version=++analysisVersion;const caseVersion=activeVersion;
  $('#analyze').disabled=true;$('#analyze').setAttribute('aria-busy','true');text('#analyze','Checking the local model…');
  text('#ai-status',resultId?'Refreshing the order, then checking a model draft against the new evidence.':'Generating a draft, then checking its structured assertions against this case.');show('#ai-result',false);
  try {
    const response=await request('/api/analyze',id?{caseId:id}:{resultId});
    if(version!==analysisVersion||caseVersion!==activeVersion)return;
    if(!response.result || !response.provenance || (resultId && response.resultId!==resultId))throw new Error('The server did not return matching refreshed evidence. Inspect the order again before requesting a proposal.');
    // Keep this generation's version while displaying exactly the evidence
    // used by its proposal. A later selection still invalidates both together.
    renderResult(response,id,{preserveAnalysis:true});
    const result=$('#ai-result');result.replaceChildren();
    const {proposal,validation}=response;
    result.append(element('strong',validation.accepted?'Structured checks passed':'Proposal rejected'));
    if(proposal){
      const citations=Array.isArray(proposal.evidenceIds)?proposal.evidenceIds.map(pretty).join(', '):pretty(proposal.evidenceIds);
      result.append(element('p',`Proposed action: ${ACTIONS[proposal.action] || pretty(proposal.action)}`),element('p',`Citations: ${citations}`));
      const draft = element('details');
      draft.append(element('summary','Read the unverified model explanation'),element('p','This draft may contradict the evidence or describe actions that have not happened. Use the calculated amounts and state above.', 'small'),element('p',pretty(proposal.explanation)));
      result.append(draft);
    }
    if(validation.errors?.length){const list=element('ul');validation.errors.forEach(x=>list.append(element('li',pretty(x))));result.append(list);}
    result.append(element('p','AI draft — explanation text is not independently verified. No action executed.','small'));
    text('#ai-status',response.provenance?.inference==='injected-test-generator'?'Injected test output — no actual model inference.':'Draft returned from the configured model.');show('#ai-result',true);
  }catch(error){
    if(version!==analysisVersion||caseVersion!==activeVersion)return;
    text('#ai-status',message(error));
    if(resultId && ['INSPECTION_EXPIRED','INSPECTION_NOT_FOUND','INVALID_RESULT_ID'].includes(error.code)){
      inspectionId=null;
      const result=$('#ai-result');result.replaceChildren();
      if(inspectionInput){
        const payload={...inspectionInput};
        const retry=element('button','Inspect this order again ↗','secondary');retry.type='button';
        retry.addEventListener('click',()=>inspectOrder(payload));result.append(retry);show('#ai-result',true);
      }
    }
  }
  finally{if(version===analysisVersion&&caseVersion===activeVersion){$('#analyze').disabled=!config.aiConfigured || !(selectedId || inspectionId);$('#analyze').removeAttribute('aria-busy');text('#analyze',selectedId || inspectionId?'Generate another proposal ↗':'Generate AI proposal ↗');}}
});
async function inspectOrder(payload) {
  if(STATIC_MODE)return;
  const requestVersion=++inspectionRequestVersion;
  const version=beginLoad();retryAction=()=>inspectOrder(payload);
  $('#inspect-button').disabled=true;$('#sandbox-form').setAttribute('aria-busy','true');show('#sandbox-error',false);text('#inspect-button','Reading sandbox order…');
  try{const data=await request('/api/inspect',payload);if(version!==activeVersion)return;renderResult(data,null);inspectionInput={...payload};history.replaceState(null,'',location.pathname);$('#case-title').setAttribute('tabindex','-1');$('#case-title').focus();}
  catch(error){if(version===activeVersion){fail(error);text('#sandbox-error',message(error));show('#sandbox-error',true);}}
  finally{if(requestVersion===inspectionRequestVersion){$('#inspect-button').disabled=false;$('#sandbox-form').removeAttribute('aria-busy');text('#inspect-button','Read sandbox order ↗');}}
}
$('#sandbox-form').addEventListener('submit',event=>{
  event.preventDefault();if(STATIC_MODE || !config.sandboxConfigured)return;
  inspectOrder(Object.fromEntries(new FormData(event.currentTarget)));
});
boot();
