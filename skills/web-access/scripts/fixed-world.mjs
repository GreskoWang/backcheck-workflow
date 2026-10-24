// Only caches broker-created execution-context metadata, never page data.
// A fresh frame tree is checked before every use. No caller can choose a world.
export function createFixedWorldResolver({sendCdp, makeError, metadataTimeoutMs = 2000, worldTimeoutMs = 5000}) {
  const states = new Map();
  function invalidate(targetId, expectedSessionId = null) {
    const state = states.get(targetId);
    if (state && (!expectedSessionId || state.sessionId === expectedSessionId)) states.delete(targetId);
  }
  function clear() { states.clear(); }
  async function resolve(targetId, sessionId, deadline) {
    let state = states.get(targetId);
    if (!state || state.sessionId !== sessionId) {
      state = {sessionId, frameId:null, loaderId:null, executionContextId:null};
      states.set(targetId, state);
    }
    const unchanged = () => {
      if (states.get(targetId) !== state) {
        throw makeError('isolated_context_changed', 'Execution context changed before fixed query.', {targetId}, 409);
      }
    };
    const tree = await sendCdp('Page.getFrameTree', {}, {sessionId, targetId, timeoutMs:metadataTimeoutMs, deadline});
    unchanged();
    const frame = tree.frameTree?.frame;
    if (!frame?.id) throw makeError('main_frame_unavailable', '无法定位页面主 frame。', {targetId}, 502);
    // No loader identity means no reuse. This also covers unusual protocol
    // implementations without guessing a document's lifetime from its URL.
    if (frame.loaderId && state.frameId === frame.id && state.loaderId === frame.loaderId && state.executionContextId) {
      return state.executionContextId;
    }
    state.executionContextId = null;
    const world = await sendCdp('Page.createIsolatedWorld', {
      frameId:frame.id, worldName:'codex-background-check-broker', grantUniveralAccess:false,
    }, {sessionId, targetId, timeoutMs:worldTimeoutMs, deadline});
    unchanged();
    if (!Number.isSafeInteger(world.executionContextId) || world.executionContextId <= 0) {
      throw makeError('isolated_world_unavailable', '无法创建隔离 DOM 查询上下文。', {targetId}, 502);
    }
    if (frame.loaderId) Object.assign(state, {frameId:frame.id, loaderId:frame.loaderId, executionContextId:world.executionContextId});
    return world.executionContextId;
  }
  return Object.freeze({resolve, invalidate, clear});
}
