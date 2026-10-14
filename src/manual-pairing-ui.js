const {ManualHost,createManualGuest,DEFAULT_ICE}=require('./rtc-manual');

// All handshake text stays on the devices. Copy/paste is user-driven; this UI
// never sends it to a signaling, QR, clipboard-sync, or paste-hosting service.
module.exports=function manualPairing({container,getSession,join,onOpen=()=>{},onClose=()=>{}}){
    const dialog=document.createElement('dialog');dialog.setAttribute('aria-label','Manual connection');
    dialog.style.cssText='background:#172735;color:#f1f8fc;border:1px solid #547286;border-radius:8px;box-sizing:border-box;width:min(620px,calc(100vw - 24px));max-height:85vh;overflow:auto;padding:20px;font:14px/1.5 system-ui';
    const heading=document.createElement('h2');heading.textContent='Manual connection';
    const hint=document.createElement('p');hint.textContent='No Homegames service needed. Both players need a downloaded game HTML or an already-open player. Send the offer privately; your friend sends an answer back. Keep both tabs open.';
    const limit=document.createElement('p');limit.textContent='Direct connections can still be blocked by a network or firewall. This mode shares game scenes, assets and input; live camera/microphone streams are not supported.';
    const status=document.createElement('p');status.setAttribute('role','status');
    const label=document.createElement('label'),stun=document.createElement('input');stun.type='checkbox';stun.checked=true;label.append(stun,' Use public STUN for internet connections (Google). Turn off for LAN-only pairing.');
    const hostBox=document.createElement('section'),guestBox=document.createElement('section');
    const hostTitle=document.createElement('h3');hostTitle.textContent='Host a player';hostBox.append(hostTitle);
    const guestTitle=document.createElement('h3');guestTitle.textContent='Join a host';guestBox.append(guestTitle);
    let host=null,guest=null,disposed=false,busy=false;
    const buttons=[];
    const say=text=>{if(!disposed)status.textContent=text;};
    const button=(box,text,action)=>{const button=document.createElement('button');button.textContent=text;button.style.cssText='padding:7px 10px;margin:4px;cursor:pointer';button.onclick=async()=>{
        if(busy)return;busy=true;buttons.forEach(b=>b.disabled=true);
        try{await action();}catch(error){say(error.message);}finally{busy=false;buttons.forEach(b=>b.disabled=false);}
    };buttons.push(button);box.append(button);return button;};
    const field=(box,name,readOnly=false)=>{const label=document.createElement('label');label.textContent=name;const area=document.createElement('textarea');area.setAttribute('aria-label',name);area.readOnly=readOnly;area.maxLength=128*1024;area.style.cssText='display:block;box-sizing:border-box;width:100%;height:90px;margin:5px 0 12px;background:#101820;color:#eef;border:1px solid #547286;padding:8px;font:11px monospace';label.append(area);box.append(label);return area;};
    const output=field(hostBox,'Offer to send',true),answer=field(hostBox,'Answer from friend');
    button(hostBox,'Create offer',async()=>{
        const session=getSession();if(!session?.game)throw new Error('Start a local game to host a player');
        if(!host)host=new ManualHost(session,{onStatus:say});host.iceServers=stun.checked?DEFAULT_ICE:[];
        output.value='';answer.value='';say('Collecting network addresses…');output.value=await host.createOffer();say('Send the entire offer to your friend. It expires in 10 minutes.');
    });
    const copy=async field=>{if(!field.value)throw new Error('Create the handshake first');try{await navigator.clipboard.writeText(field.value);say('Handshake copied');}catch(_){field.focus();field.select();say('Copy the selected handshake text');}};
    button(hostBox,'Copy offer',()=>copy(output));
    button(hostBox,'Connect with answer',async()=>{if(!host)throw new Error('Create an offer first');await host.acceptAnswer(answer.value);say('Connecting directly…');});
    button(hostBox,'Cancel offer',()=>{host?.cancelOffer();output.value='';answer.value='';say('Pending offer cancelled');});
    const offer=field(guestBox,'Offer from host'),reply=field(guestBox,'Answer to send',true);
    button(guestBox,'Create answer',async()=>{
        // Validate before stopping a running host. A bad paste must not end it.
        const next=createManualGuest(offer.value,{iceServers:stun.checked?DEFAULT_ICE:[],onStatus:say});
        host?.stop();host=null;guest?.close();guest=next;reply.value='';say('Collecting network addresses…');
        try{join(next.transport);reply.value=await next.answer();say('Send the entire answer back to the host, then choose Done.');}catch(error){next.close();throw error;}
    });
    button(guestBox,'Copy answer',()=>copy(reply));
    const done=document.createElement('button');done.textContent='Done';done.style.cssText='padding:8px 18px;margin-top:16px';done.onclick=()=>dialog.close();
    dialog.append(heading,hint,label,hostBox,guestBox,limit,status,done);container.append(dialog);dialog.onclose=onClose;
    return {
        show(){if(disposed||dialog.open)return;dialog.showModal();onOpen();},
        dispose(){if(disposed)return;disposed=true;host?.stop();guest?.close();dialog.remove();},
    };
};
