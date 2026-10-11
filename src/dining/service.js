const crypto = require('node:crypto');
const domain = require('./domain');
// 所有改变同一账单的操作都读写同一 session 文档，由数据库事务重试并发冲突。
function createService(db, staffIds = [], options = {}) {
  return async function handle(event, actor) {
    if (!actor) domain.fail('UNAUTHENTICATED', '请在微信中重新打开小程序');
    const table = domain.tableNumber(event.table);
    const isStaff = staffIds.includes(actor);
    if (!['join', 'get', 'submit', 'checkout', 'cancelCheckout', 'staffGet', 'confirmPaid'].includes(event.action)) domain.fail('ACTION_INVALID', '不支持的操作');
    if (['staffGet', 'confirmPaid'].includes(event.action) && !isStaff) domain.fail('FORBIDDEN', '仅门店收银员可以使用此功能');
    const nextId = crypto.randomUUID();
    const now = Date.now();
    return db.runTransaction(async tx => {
      const tableDoc = tx.collection('dining_tables').doc(table);
      const tableResult = await tableDoc.get();
      const pointer = tableResult.data;
      if (!pointer) domain.fail('NOT_CONFIGURED', '桌台尚未初始化，请联系门店');
      let session;
      let changed = false;
      if (event.action === 'join') {
        // 已加入的顾客回来时继续查看原餐次；已结账不自动开下一桌。
        const knownId = event.sessionId || pointer.sessionId;
        if (knownId) {
          session = (await tx.collection('dining_sessions').doc(knownId).get()).data;
          if (!session || session.table !== table) domain.fail('SESSION_INVALID', '桌台记录已变化，请重新扫码');
          if (event.sessionId) domain.member(session, actor);
        }
        if (!session || (!event.sessionId && session.status === 'paid')) {
          session = domain.newSession(table, nextId, now);
          await tableDoc.update({ data: { sessionId: session.id } });
          changed = true;
        }
        changed = domain.join(session, actor) || changed;
      } else {
        const sessionId = event.sessionId || (event.action === 'staffGet' ? pointer.sessionId : '');
        if (!sessionId) domain.fail('SESSION_INVALID', '本桌暂无用餐记录，请先加入点单');
        session = (await tx.collection('dining_sessions').doc(sessionId).get()).data;
        if (!session || session.table !== table) domain.fail('SESSION_INVALID', '桌台记录已变化，请重新扫码');
        if (!isStaff || !['staffGet', 'confirmPaid', 'cancelCheckout'].includes(event.action)) domain.member(session, actor);
        if (event.action === 'submit') {
          const previous = session.orders.some(order => order.actor === actor && order.requestId === event.requestId);
          if (!previous && options.beforeNewSubmit) await options.beforeNewSubmit(event, tx, now);
          changed = domain.submit(session, actor, event, now);
        }
        if (event.action === 'checkout') changed = domain.requestCheckout(session, actor, event, now);
        if (event.action === 'cancelCheckout') changed = domain.cancelCheckout(session, actor, event, isStaff);
        if (event.action === 'confirmPaid') changed = domain.confirmPaid(session, actor, event, now, isStaff);
      }
      if (changed) {
        session.revision += 1; session.updatedAt = now;
        const { _id, ...data } = session;
        await tx.collection('dining_sessions').doc(session.id).set({ data });
      }
      return domain.present(session, actor, isStaff);
    }, 20);
  };
}
module.exports = { createService };
