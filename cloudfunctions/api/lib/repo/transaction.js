'use strict';

const { randomUUID } = require('node:crypto');

/** 云事务只使用 doc 操作；查询须在事务外准备，再在事务内验证队伍 revision。 */
function cloudTransactionRepo(transaction, command) {
  const ref = (collection, id) => transaction.collection(collection).doc(id);
  return {
    async get(collection, id) {
      try { return (await ref(collection, id).get()).data || null; }
      catch (e) {
        if (e.errCode === -502005 || /collection.*not exist|db or table not exist/i.test(e.errMsg || e.message || '')) throw e;
        if (/document.*not exist|document.*not found|文档不存在/i.test(e.errMsg || e.message || '')) return null;
        throw e;
      }
    },
    async insert(collection, data) {
      const id = data._id || randomUUID();
      if (await this.get(collection, id)) throw new Error('事务新增文档已存在');
      const row = Object.assign({ createdAt: new Date(), updatedAt: new Date() }, data);
      delete row._id;
      await ref(collection, id).set({ data: row });
      return Object.assign({ _id: id }, row);
    },
    async update(collection, id, patch) {
      const data = Object.assign({}, patch, { updatedAt: new Date() });
      // 仓储 patch 的对象/数组字段整体替换，与内存事务保持一致。
      // SDK 默认把普通对象展开为子路径：原值为 null 时会写入失败，
      // 原值为对象时则会残留上次结果中已经移除的字段。Date 等标量不包装。
      for (const [key, value] of Object.entries(data)) {
        if (Array.isArray(value) || Object.prototype.toString.call(value) === '[object Object]') {
          data[key] = command.set(value);
        }
      }
      await ref(collection, id).update({ data });
    },
  };
}

module.exports = { cloudTransactionRepo };
