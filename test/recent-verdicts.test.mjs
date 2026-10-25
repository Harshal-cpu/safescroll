import assert from 'node:assert/strict';
import test from 'node:test';

test('recent verdicts show the latest occurrences, not the last string keys', async () => {
  const stored = [
    { key: 'a', ts: 300, verdict: { action: 'block' } },
    { key: 'b', ts: 100, verdict: { action: 'flag' } },
    { key: 'c', ts: 200, verdict: { action: 'clean' } }
  ];
  const messages = [];
  globalThis.window = { addEventListener() {} };
  globalThis.chrome = { runtime: { sendMessage: async message => { messages.push(message); } } };
  globalThis.indexedDB = {
    open() {
      const request = {
        result: {
          transaction() {
            const tx = {
              objectStore() {
                return {
                  put(row) {
                    const index = stored.findIndex(item => item.key === row.key);
                    if (index < 0) stored.push(row);
                    else stored[index] = row;
                    queueMicrotask(() => tx.oncomplete?.());
                  },
                  openCursor() {
                    const cursorRequest = {};
                    let index = 0;
                    const next = () => {
                      const value = stored.slice().sort((a, b) => a.key.localeCompare(b.key))[index++];
                      cursorRequest.result = value
                        ? { value, continue: () => queueMicrotask(next) }
                        : null;
                      cursorRequest.onsuccess();
                    };
                    queueMicrotask(next);
                    return cursorRequest;
                  }
                };
              }
            };
            return tx;
          }
        }
      };
      queueMicrotask(() => request.onsuccess());
      return request;
    }
  };

  const { getRecentVerdicts, getSessionStats, persistVerdict } = await import('../src/offscreen/store.js');
  assert.deepEqual((await getRecentVerdicts(2)).map(row => row.key), ['a', 'c']);

  await persistVerdict('d', { action: 'clean', ts: 400 });
  assert.deepEqual((await getRecentVerdicts(2)).map(row => row.key), ['d', 'a']);
  assert.deepEqual(await getSessionStats(), {
    ok: true, blocked: 1, flagged: 1, clean: 2, total: 4, bySource: {}
  });
  assert.deepEqual(messages, [{ type: 'verdicts-updated' }]);
});
