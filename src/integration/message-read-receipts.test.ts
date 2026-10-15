import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { initSocket } from '../lib/socket';
import { getMessages, sendMessage } from '../services/messages.service';

assert.equal(env.NODE_ENV, 'test');
assert.match(new URL(env.DATABASE_URL).searchParams.get('schema') || '', /^servicehub_migration_test_[a-f0-9]{32}$/);
after(() => prisma.$disconnect());

test('seen timestamps are durable, scoped, idempotent and delivered to the two participants', async t => {
  const tag = randomUUID();
  const makeUser = (name:string) => prisma.user.create({ data:{ name, email:`${name}-${tag}@example.test`, passwordHash:'test-unusable', phone:'', location:'Cordova', emailVerified:true, verificationStatus:'APPROVED' } });
  const [seeker,provider,outsider] = await Promise.all(['seeker','provider','outsider'].map(makeUser));
  const booking = await prisma.booking.create({ data:{ seekerId:seeker.id, providerId:provider.id, originType:'DIRECT_LISTING', agreedAmount:500, paymentMethod:'On-site Cash', status:'ACCEPTED' } });
  const second = await prisma.booking.create({ data:{ seekerId:seeker.id, providerId:provider.id, originType:'DIRECT_LISTING', agreedAmount:500, paymentMethod:'On-site Cash', status:'ACCEPTED' } });
  const io = initSocket(createServer());
  const events:Array<{room:string;event:string;payload:any}> = [];
  t.mock.method(io, 'to', (room:string) => ({ emit:(event:string,payload:unknown) => events.push({room,event,payload}) }));
  t.after(async () => {
    await new Promise<void>(resolve => io.close(() => resolve()));
    await prisma.booking.deleteMany({ where:{ id:{in:[booking.id,second.id]} } });
    await prisma.user.deleteMany({ where:{id:{in:[seeker.id,provider.id,outsider.id]}} });
  });
  const outgoing = await sendMessage(booking.id,seeker.id,'Please check the laptop.',false,'user');
  const elsewhere = await sendMessage(second.id,seeker.id,'Another job.',false,'user');
  assert.equal(outgoing.readAt,null);
  await assert.rejects(getMessages(booking.id,outsider.id,'user'), {status:403});
  await getMessages(booking.id,outsider.id,'admin');
  await getMessages(booking.id,provider.id,'user',false);
  await sendMessage(booking.id,provider.id,'Replying does not acknowledge unloaded history.',false,'user');
  assert.equal((await prisma.message.findUniqueOrThrow({where:{id:outgoing.id}})).isRead,false);
  assert.equal(events.filter(event => event.event==='messages_read').length,0);

  const before = Date.now();
  await Promise.all(Array.from({length:4}, () => getMessages(booking.id,provider.id,'user')));
  const seen = await prisma.message.findUniqueOrThrow({where:{id:outgoing.id}});
  assert.equal(seen.isRead,true);
  assert.ok(seen.readAt && seen.readAt.getTime()>=before && seen.readAt.getTime()<=Date.now());
  const receipts = events.filter(event => event.event==='messages_read');
  assert.deepEqual(receipts.map(event => event.room).sort(),[`user:${seeker.id}`,`user:${provider.id}`].sort());
  assert.ok(receipts.every(event => event.payload.bookingId===booking.id && event.payload.receiverId===provider.id && event.payload.messages[0].id===outgoing.id));
  await getMessages(booking.id,provider.id,'user');
  assert.equal((await prisma.message.findUniqueOrThrow({where:{id:outgoing.id}})).readAt?.getTime(),seen.readAt.getTime());
  assert.equal((await prisma.message.findUniqueOrThrow({where:{id:elsewhere.id}})).readAt,null);
  assert.equal(events.filter(event => event.event==='messages_read').length,2);
  const history = await getMessages(booking.id,seeker.id,'user');
  assert.equal(history.find(message => message.id===outgoing.id)?.readAt?.getTime(),seen.readAt.getTime());
  const legacy = await prisma.message.create({data:{bookingId:booking.id,senderId:seeker.id,receiverId:provider.id,content:'Historical message',isRead:true}});
  await getMessages(booking.id,provider.id,'user');
  assert.equal((await prisma.message.findUniqueOrThrow({where:{id:legacy.id}})).readAt,null,'Do not invent historical seen times');
});
