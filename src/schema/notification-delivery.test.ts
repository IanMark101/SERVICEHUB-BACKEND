import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import type { Request, Response } from 'express';
import type { PrismaClient } from '@prisma/client';

test('notification ownership, read acknowledgements and administrator recipients',async t=>{
  type Row=Record<string,any>;
  let rows:Row[]=[];let inTransaction=false;let findArgs:Row={};
  const matches=(row:Row,where:Row):boolean=>Object.entries(where).every(([key,value])=>{
    if(key==='OR')return value.some((item:Row)=>matches(row,item));
    if(value&&typeof value==='object'){
      if('in' in value)return value.in.includes(row[key]);
      if('lte' in value)return new Date(row[key]).getTime()<=value.lte.getTime();
    }
    return row[key]===value;
  });
  const users=[{id:'admin',role:'admin',isActive:true,moderationStatus:'ACTIVE'},{id:'inactive',role:'admin',isActive:false,moderationStatus:'ACTIVE'},{id:'member',role:'user',isActive:true,moderationStatus:'ACTIVE'}];
  const fake={
    user:{findMany:async({where}:Row)=>users.filter(row=>matches(row,where))},
    notification:{
      findMany:async(args:Row)=>{findArgs=args;return rows.filter(row=>matches(row,args.where)).sort((a,b)=>b.createdAt.getTime()-a.createdAt.getTime()||b.id.localeCompare(a.id)).slice(args.skip||0,args.take?(args.skip||0)+args.take:undefined);},
      count:async({where}:Row)=>rows.filter(row=>matches(row,where)).length,
      updateMany:async({where,data}:Row)=>{assert.equal(inTransaction,true);const selected=rows.filter(row=>matches(row,where));selected.forEach(row=>Object.assign(row,data));return {count:selected.length};},
      createMany:async({data}:Row)=>{assert.equal(inTransaction,true);rows.push(...data.map((row:Row)=>({createdAt:new Date(),isRead:false,...row})));return {count:data.length};},
    },
    $transaction:async(run:(tx:typeof fake)=>unknown)=>{const before=structuredClone(rows);inTransaction=true;try{return await run(fake);}catch(error){rows=before;throw error;}finally{inTransaction=false;}},
  };
  const singleton=globalThis as unknown as {prisma?:PrismaClient};const prior=singleton.prisma;singleton.prisma=fake as unknown as PrismaClient;t.after(()=>{singleton.prisma=prior;});
  const {initSocket}=await import('../lib/socket');const io=initSocket(createServer());t.after(()=>io.close());
  const emitted:Row[]=[];t.mock.method(io,'to',(room:string)=>({emit:(event:string,data:Row)=>{assert.equal(inTransaction,false);emitted.push({room,event,data});}}));
  const {getMyNotifications,markAllAsRead,markOneAsRead}=await import('../controllers/notifications.controller');
  const {recordAdminNotifications,missingBookingCancellationNotifications}=await import('../services/notifications.service');
  const seed=()=>{rows=[{id:'one',userId:'reader',title:'Booking cancelled',link:'/seeker/seeker-activity?tab=canceled&booking=booking',isRead:false,createdAt:new Date(0)},{id:'two',userId:'reader',isRead:false,createdAt:new Date(0)},{id:'foreign',userId:'other',isRead:false,createdAt:new Date(0)}];emitted.length=0;};
  const invoke=async(handler:typeof markOneAsRead,id='one',query:Row={})=>{
    let result:Row={};let status=200;
    const res={status:(value:number)=>{status=value;return res;},json:(value:Row)=>{result=value;}} as unknown as Response;
    await handler({user:{id:'reader'},params:{id},query} as unknown as Request,res,error=>{if(error)throw error;});return {status,...result};
  };
  await t.test('list and totals contain only the authenticated account and stable ordering',async()=>{
    seed();const result=await invoke(getMyNotifications,'',{page:1,limit:1});
    assert.equal(result.data.length,1);assert.equal(result.data[0].userId,'reader');assert.equal(result.pagination.total,2);assert.equal(result.pagination.unread,2);
    assert.deepEqual(findArgs.orderBy,[{createdAt:'desc'},{id:'desc'}]);
  });
  await t.test('opening one alert leaves the other unread, and repeated reads are idempotent',async()=>{
    seed();const result=await invoke(markOneAsRead);assert.equal(result.data.unread,1);assert.equal(rows.find(row=>row.id==='two')?.isRead,false);
    const repeat=await invoke(markOneAsRead);assert.equal(repeat.data.unread,1);
    assert.ok(emitted.every(event=>event.room==='user:reader'&&event.event==='notifications_read'));
    assert.equal(emitted[0].data.notificationId,'one');
  });
  await t.test('another account alert cannot be read or disclosed',async()=>{
    seed();const result=await invoke(markOneAsRead,'foreign');assert.equal(result.status,404);assert.equal(rows.find(row=>row.id==='foreign')?.isRead,false);assert.equal(emitted.length,0);
  });
  await t.test('mark all preserves alerts created after the cutoff and other accounts',async()=>{
    seed();rows.push({id:'arriving',userId:'reader',isRead:false,createdAt:new Date(Date.now()+60000)});
    const result=await invoke(markAllAsRead);assert.equal(result.data.unread,1);assert.equal(rows.find(row=>row.id==='arriving')?.isRead,false);assert.equal(rows.find(row=>row.id==='foreign')?.isRead,false);assert.ok(result.data.readBefore);
  });
  await t.test('administrator notices are persisted only for active administrators',async()=>{
    rows=[];const ids=await fake.$transaction(tx=>recordAdminNotifications(tx as never,{title:'Case needs review',body:'Review the case',link:'/admin/reports'}));
    assert.deepEqual(ids,['admin']);assert.equal(rows.length,1);assert.equal(rows[0].userId,'admin');
  });
  await t.test('repair identifies only the absent cancellation recipient and recognizes legacy IDs',async()=>{
    seed();const missing=await missingBookingCancellationNotifications(fake as never,{id:'booking',seekerId:'reader',providerId:'other'});
    assert.equal(missing.length,1);assert.equal(missing[0].userId,'other');rows.push({...missing[0],createdAt:new Date(),isRead:false});
    assert.deepEqual(await missingBookingCancellationNotifications(fake as never,{id:'booking',seekerId:'reader',providerId:'other'}),[]);
  });
});
